# MCP Tools

[← SPEC.md に戻る](./SPEC.md)

MCP サーバーが公開するツール。アップロード系の実装は [src/mcp/tools.ts](../src/mcp/tools.ts)、
Drive 読み取り/管理系は [src/mcp/drive-tools.ts](../src/mcp/drive-tools.ts)。

全ツール認証必須。`getMcpAuthContext()` から `props.userId` を取得し、操作の所有者を確認する。

| ツール | 区分 | 必要スコープ |
|---|---|---|
| `prepare_upload` / `complete_upload` | アップロード | `drive.file` |
| `search_files` / `get_file_metadata` / `download_file` | 読み取り | `drive.readonly` |
| `delete_file` | 管理 | `drive.file` |

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

---

## `search_files`

ユーザーの Drive を検索/一覧する（要 `drive.readonly`）。

| 入力 | 型 | 必須 | 内容 |
|---|---|---|---|
| `query` | string | — | Drive クエリ構文（例: `name contains 'report'`）。省略時は最近のファイル |
| `pageSize` | integer | — | 1〜100（既定 25） |
| `pageToken` | string | — | 前回結果の `nextPageToken` |

出力: `{ files: [{ id, name, mimeType, size?, modifiedTime? }], nextPageToken? }`

## `get_file_metadata`

`fileId` のメタデータを返す（要 `drive.readonly`）。

| 入力 | 型 | 必須 |
|---|---|---|
| `fileId` | string | ✓ |

出力: `{ id, name, mimeType, size?, modifiedTime? }`

## `download_file`

**バイトは返さない。** 短命の HTTPS ダウンロード URL を発行する（要 `drive.readonly`）。
大きいファイルでも MCP チャネル/モデルコンテキストにバイトが載らないよう、アップロードと
鏡写しの「制御プレーン / データプレーン分離」にしている。

| 入力 | 型 | 必須 |
|---|---|---|
| `fileId` | string | ✓ |

出力: `{ downloadId, downloadUrl, downloadToken, expiresAt, name, mimeType, size? }`

クライアントは `GET <downloadUrl>` に `Authorization: Bearer <downloadToken>` を付けて取得する。
Worker は [`/download/:downloadId`](./architecture.md#ルーティング) で検証し、Drive から直接ストリームする。

### 副作用 / エラー

- `UPLOAD_KV` に `download:<downloadId>` を書き込む（TTL: `DOWNLOAD_TTL_SECONDS`(既定 900) + 60）
- Google ネイティブ形式（Docs/Sheets/Slides 等）は直接 DL 不可のため `isError` を返す

## `delete_file`

このアプリがアクセスできる Drive ファイルを削除する（要 `drive.file`）。

| 入力 | 型 | 必須 |
|---|---|---|
| `fileId` | string | ✓ |

出力: `{ deleted: true, fileId }`
