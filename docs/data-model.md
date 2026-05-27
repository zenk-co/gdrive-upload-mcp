# Data Model

[← SPEC.md に戻る](./SPEC.md)

このサーバーが扱う 4 つの「データ」: Upload JWT、UploadRecord、Google Token、OAuth State。すべて KV + Worker secret で完結し、独自の RDBMS は持たない。

## Upload JWT

`prepare_upload` が発行する HS256 署名トークン。実装は [src/jwt.ts](../src/jwt.ts)。

### Claims

| クレーム | 型 | 内容 |
|---|---|---|
| `iss` | string | 固定 `"upload-mcp"` |
| `aud` | string | 固定 `"upload-app"` |
| `sub` | string | `userProps.userId` (Google `sub`) |
| `uploadId` | string | `prepare_upload` で発行した UUID v4 |
| `filename` | string | クライアント宣言のファイル名 |
| `maxSize` | number | クライアント宣言のサイズ (バイト)。Upload handler はこれを超える受信を拒否 |
| `contentType` | string | MIME |
| `sha256` | string? | 事前計算 SHA-256。省略可 |
| `iat` | number | 発行時刻 (UNIX 秒) |
| `exp` | number | 失効時刻 (UNIX 秒、デフォルト `iat + TOKEN_TTL_SECONDS`) |

### 署名

- アルゴリズム: HS256 (`HMAC-SHA-256`)
- 鍵: `JWT_SIGNING_KEY` (Worker secret、32 バイト以上推奨)
- ヘッダ: `{ alg: "HS256", typ: "JWT" }`

### 検証ロジック

1. `parts.length === 3` を確認
2. HMAC 署名一致
3. `header.alg === "HS256"` (alg confusion 対策)
4. `exp > now`
5. `iss === "upload-mcp"`, `aud === "upload-app"`
6. (Upload handler 側で追加) `uploadId === pathUploadId`, `sub === record.userId`

## UploadRecord (`UPLOAD_KV`)

`prepare_upload` で `pending`、Upload handler で `completed` または `failed` に書き換わる。

### キー命名

`upload:<uploadId>` (UUID v4 形式)

### スキーマ

| フィールド | 型 | 必須 | 段階 |
|---|---|---|---|
| `status` | `"pending" \| "completed" \| "failed"` | ✓ | 全段階 |
| `userId` | string | ✓ | `prepare_upload` |
| `filename` | string | ✓ | `prepare_upload` |
| `size` | number | ✓ | `prepare_upload` (要求サイズ) |
| `contentType` | string | ✓ | `prepare_upload` |
| `sha256` | string | — | `prepare_upload` (任意で事前バインド) |
| `parentFolderId` | string | — | `prepare_upload` |
| `expiresAt` | string (ISO 8601) | ✓ | JWT 失効時刻と一致 |
| `actualSize` | number | — | `completed` で書く (実バイト数) |
| `actualSha256` | string | — | `completed` で書く (Worker 計算ハッシュ) |
| `driveFileId` | string | — | `completed` で書く |
| `driveName` | string | — | `completed` で書く |
| `driveMime` | string | — | `completed` で書く |
| `failureReason` | string | — | `failed` で書く |

### TTL

| 段階 | TTL |
|---|---|
| `pending` | `TOKEN_TTL_SECONDS + 3600` 秒 (JWT 失効後も少しだけ残し、デバッグ可能にする) |
| `completed` | 24 時間 (再呼び出しの冪等性を保つ最低限の窓) |
| `failed` | 1 時間 |

## Google Token (`TOKEN_KV`)

### キー命名

`gtoken:<userId>`

### スキーマ

```ts
interface GoogleTokenRecord {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;   // UNIX 秒
  scope: string;
}
```

`/callback` で書き込み、`getFreshAccessToken()` が `expiresAt - 60 < now` のときに自動更新。

## UploadSession DO ストレージ

分割アップロード時のみ使われる Durable Object。`env.UPLOAD_SESSION.idFromName(uploadId)` でインスタンス化。詳細は [upload-flow.md](./upload-flow.md#chunked-upload) と [src/upload/session.ts](../src/upload/session.ts) を参照。

### 永続フィールド (DO storage、キー: `"state"`)

| フィールド | 型 | 内容 |
|---|---|---|
| `sessionUri` | string | Drive resumable session の URI |
| `uploadId` | string | このセッションの uploadId (= DO name) |
| `userId` | string | JWT の `sub` |
| `filename` | string | クライアント宣言のファイル名 |
| `contentType` | string | MIME |
| `totalSize` | number | クライアント宣言のサイズ |
| `expectedSha256` | string? | JWT に事前バインドされた sha256 |
| `parents` | string[]? | Drive 親フォルダ ID |
| `currentOffset` | number | 次に期待する `Content-Range` の `start` 位置 |

完了または失敗時に `storage.deleteAll()` で削除される。

### In-Memory のみ (非永続)

| フィールド | 型 | 用途 |
|---|---|---|
| `hasher` | `@noble/hashes` SHA256 | 受信バイトを累積ハッシュ |
| `hasherValid` | boolean | DO ハイバネート時に false にフォールバック、sha256 検証を無効化する印 |
| `bytesHashed` | number | ハッシャに通したバイト数。`currentOffset` とずれた場合は invalid 判定 |

## OAuth State (`OAUTH_KV`)

### キー命名

`oauthstate:<state>` (state は `crypto.randomUUID()`)

### スキーマ

```ts
type OAuthStateRecord = AuthRequest;  // workers-oauth-provider の型
```

TTL: 10 分 (`STATE_TTL_SECONDS`)。`/callback` 処理時に取り出し、即削除。

## Drive リソース表現

`complete_upload` の出力に含まれる `resourceUri` は次の形式:

```
gdrive://files/<driveFileId>
```

MCP の `resource_link` ブロックでもこの URI を使う。クライアント側で Drive Web UI の URL に解決する場合は `https://drive.google.com/file/d/<driveFileId>/view` などに変換する。
