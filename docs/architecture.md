# Architecture

[← SPEC.md に戻る](./SPEC.md)

## 設計原則

1. **制御プレーンとデータプレーンの分離** — MCP/JSON-RPC は調停のみ。ファイル本体は別エンドポイントへ直接 PUT
2. **短命・最小権限のトークン** — アップロード許可は `uploadId / userId / maxSize / contentType / sha256` に厳密にバインドした HMAC JWT (TTL 15 分)
3. **二重検証** — クライアント計算 SHA-256 と Worker 計算 SHA-256、両方が一致しなければファイルを破棄
4. **ユーザー本人の Drive に保存** — MCP 接続時の Google OAuth で得た `drive.file` 権限を流用し、サーバー横断の共有ストレージにはしない

## システム概観

![System overview](./diagrams/svg/system-overview.svg)

ソース: [diagrams/system-overview.mmd](./diagrams/system-overview.mmd)

## コンポーネント

| コンポーネント | 役割 | 実装 |
|---|---|---|
| OAuthProvider | OAuth 2.1 認可サーバー。MCP クライアント向けに access token を発行し、`/mcp` の Bearer を検証 | [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) を [src/index.ts](../src/index.ts) で wrap |
| Google IdP ハンドラ | `/authorize` `/callback` を実装し、upstream の Google OAuth に委譲。`drive.file` スコープを取得し `props` を発行 | [src/auth/google.ts](../src/auth/google.ts) |
| McpAgent (DO) | MCP の Streamable HTTP エンドポイント。`prepare_upload` / `complete_upload` ツールを公開 | [src/mcp/agent.ts](../src/mcp/agent.ts), [src/mcp/tools.ts](../src/mcp/tools.ts) |
| Upload handler | `PUT /upload/:uploadId` を受信。`Content-Range` の有無で単一/分割をディスパッチ。単一は JWT 検証 → Drive resumable session 初期化 → SHA-256 計測しつつストリームリレー | [src/upload/handler.ts](../src/upload/handler.ts) |
| UploadSession (DO) | uploadId ごとの分割アップロード状態を保持。Drive session URI と offset を永続化、SHA-256 ハッシャを in-memory で持つ | [src/upload/session.ts](../src/upload/session.ts) |
| JWT モジュール | HS256 sign/verify (WebCrypto)。`mcp-upload-kit` の実装を re-export | [src/jwt.ts](../src/jwt.ts) |
| SHA-256 ストリーム | `TransformStream` で累積ハッシュとサイズ超過チェック。`mcp-upload-kit` の実装を re-export | [src/sha256.ts](../src/sha256.ts) |
| Drive クライアント | resumable session init / PUT / cancel / delete | [src/drive.ts](../src/drive.ts) |
| Google トークンストア | アクセス/リフレッシュトークンの KV 保管と自動リフレッシュ | [src/auth/tokens.ts](../src/auth/tokens.ts) |

> JWT・SHA-256 stream・`Content-Range` パース・JSON response・KV key などの汎用 primitive は
> [`mcp-upload-kit`](https://github.com/zenk-t-suzuki/mcp-upload-kit) に切り出し済み。`src/jwt.ts` /
> `src/sha256.ts` 等はライブラリの薄い re-export。Drive 固有のアップロード制御・OAuth・MCP tool
> 定義はこの repo に残している。

## ルーティング

| パス | ハンドラ | 認証 |
|---|---|---|
| `/authorize` (GET) | Google サインイン開始 | なし (parseAuthRequest で OAuth リクエストを検証) |
| `/callback` (GET) | Google からのコールバック処理 | state による CSRF 対策 |
| `/oauth/token` (POST) | クライアントへの token 発行 | OAuthProvider 内蔵 |
| `/oauth/register` (POST) | Dynamic Client Registration | OAuthProvider 内蔵 |
| `/mcp` (GET/POST) | Streamable HTTP MCP | OAuthProvider が Bearer 検証 |
| `/upload/:uploadId` (PUT) | ファイル本体受信 | `prepare_upload` 発行の HMAC JWT |

## バインディング

| バインディング | 種別 | 用途 |
|---|---|---|
| `MCP_OBJECT` | Durable Object | McpAgent インスタンス (per-session) |
| `UPLOAD_SESSION` | Durable Object | UploadSession インスタンス (per-uploadId、分割アップロード時のみ生成) |
| `UPLOAD_KV` | KV | アップロードセッションの状態 (`UploadRecord`) |
| `TOKEN_KV` | KV | ユーザー別の Google access/refresh token |
| `OAUTH_KV` | KV | OAuthProvider と OAuth state の保管 |
| `JWT_SIGNING_KEY` | Secret | HS256 共有鍵 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Secret | Google OAuth クライアント資格 |
| `COOKIE_SECRET` | Secret | OAuthProvider のセッション署名 |
| `WORKER_BASE_URL` | Var | アップロード URL 生成と OAuth redirect の基底 URL |
| `MAX_UPLOAD_BYTES` | Var | アップロード上限 (バイト) |
| `TOKEN_TTL_SECONDS` | Var | アップロード JWT の TTL |
| `GOOGLE_OAUTH_SCOPES` | Var | Google から要求するスコープ |
