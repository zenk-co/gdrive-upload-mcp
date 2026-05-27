# MCP Tools

[← SPEC.md に戻る](./SPEC.md)

MCP サーバーが公開する 2 つのツール。実装は [src/mcp/tools.ts](../src/mcp/tools.ts)。

両ツールとも認証必須。`getMcpAuthContext()` から `props.userId` を取得し、操作の所有者を確認する。

## `prepare_upload`

短命のアップロード URL と Bearer トークンを発行する。クライアントは返却された `uploadUrl` に対し `Authorization: Bearer <uploadToken>` を付けてファイル本体を PUT する。

### 入力

| フィールド | 型 | 必須 | 制約 |
|---|---|---|---|
| `filename` | string | ✓ | 1〜255 文字、`/` および `\0` を含まない |
| `size` | integer | ✓ | `1 ≤ size ≤ MAX_UPLOAD_BYTES` |
| `contentType` | string | ✓ | MIME 形式 `type/subtype` |
| `sha256` | string | — | 小文字 hex 64 桁。事前計算できる場合に渡す |
| `parentFolderId` | string | — | 親フォルダの Drive ID。省略時は My Drive 直下 |

### 出力

| フィールド | 型 | 内容 |
|---|---|---|
| `uploadId` | string (UUID v4) | アップロード識別子 |
| `uploadUrl` | string | `{WORKER_BASE_URL}/upload/{uploadId}` |
| `uploadToken` | string | HS256 署名 JWT (詳細は [data-model.md](./data-model.md#upload-jwt)) |
| `expiresAt` | string (ISO 8601) | JWT 失効時刻 |

### 副作用

- `UPLOAD_KV` に `upload:<uploadId>` を `status=pending` で書き込む (TTL: `TOKEN_TTL_SECONDS + 3600`)
- レコードに `userId`、要求された `size` / `contentType` / `sha256` / `parentFolderId` を保存

### エラー条件

- `not authenticated`: 認証コンテキストが取得できない
- `size > MAX_UPLOAD_BYTES`: zod バリデーションで弾く

---

## `complete_upload`

データプレーンへの PUT が成功した後、クライアントが完了通知として呼ぶ。Worker 計算済みの `actualSha256` と引数の `sha256` を照合し、Drive 上のファイル参照を返す。

### 入力

| フィールド | 型 | 必須 | 制約 |
|---|---|---|---|
| `uploadId` | string (UUID) | ✓ | `prepare_upload` の戻り値 |
| `sha256` | string | ✓ | 小文字 hex 64 桁。クライアント側で再計算したもの |

### 出力

| フィールド | 型 | 内容 |
|---|---|---|
| `fileId` | string | Google Drive のファイル ID |
| `resourceUri` | string | `gdrive://files/<fileId>` |
| `name` | string | Drive 上のファイル名 |
| `mimeType` | string | Drive 側で確定した MIME |
| `size` | number | 実バイト数 |
| `sha256` | string | Worker が計測したハッシュ |

`structuredContent` に加え、`content` に `resource_link` ブロックを併せて返すため、MCP クライアントはそのままリソース参照として扱える。

### エラー条件 (`isError: true` で返却)

| 条件 | メッセージ |
|---|---|
| `uploadId` が KV に存在しない | `uploadId not found: ...` |
| 別ユーザーの `uploadId` を指定 | `uploadId belongs to a different user` |
| `status !== "completed"` | `upload not completed (status=...)` |
| `actualSha256 !== sha256` | `sha256 mismatch: client=... server=...` |
| `driveFileId` が記録されていない | `missing driveFileId in record` |

`complete_upload` は冪等。完了済みレコードに対する 2 回目以降の呼び出しは同じ結果を返す。
