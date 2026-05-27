# SPEC

Google Drive Upload MCP Server (Cloudflare) の仕様書。

## 概要

Cloudflare Worker 上の MCP サーバーは「**制御プレーン**」、ユーザー本人の Google Drive にファイルを書き込む HTTP エンドポイントは「**データプレーン**」として分離する。大容量ファイル本体は MCP/JSON-RPC を経由させず、専用エンドポイントへ直接 PUT させる。

- **制御プレーン (`/mcp`)** — アップロード前後の調停。`prepare_upload` で短命の JWT を発行し、`complete_upload` で SHA-256 と保存状態を検証
- **データプレーン (`/upload/:uploadId`)** — クライアントから直接 PUT を受け、Worker 内で SHA-256 を計算しながら Google Drive resumable session にストリームリレー
- **認証** — `@cloudflare/workers-oauth-provider` で OAuth 2.1 を提供。upstream IdP は Google で、`drive.file` スコープを取得しユーザー本人の Drive へ保存

実装の概観は [architecture.md](./architecture.md) を参照。

## ドキュメントインデックス

| トピック | ファイル | 内容 |
|---|---|---|
| 利用者向け接続ガイド | [introduce.md](./introduce.md) | Claude (Cowork/Desktop) から本サーバーに接続して使い始める手順 |
| デプロイガイド | [deploy.md](./deploy.md) | サーバーを自分の Cloudflare アカウントにデプロイする手順 |
| アーキテクチャ | [architecture.md](./architecture.md) | 全体構成、コンポーネント分割、リクエストパス |
| MCP ツール | [mcp-tools.md](./mcp-tools.md) | `prepare_upload` / `complete_upload` の I/O と挙動 |
| アップロードフロー | [upload-flow.md](./upload-flow.md) | PUT エンドポイント、SHA-256 ストリーミング、Drive resumable 連携、状態遷移 |
| 認証 | [auth.md](./auth.md) | OAuth フロー、Google IdP 委譲、トークン保管とリフレッシュ |
| データモデル | [data-model.md](./data-model.md) | JWT claims、KV スキーマ、UploadRecord、Drive メタデータ |
| セキュリティ | [security.md](./security.md) | 脅威モデルと対策 (リプレイ・横取り・サイズ偽装など) |

## 図 (mermaid)

`.mmd` ソースを編集後、`npm run docs:build` で `docs/diagrams/svg/*.svg` を再生成する。SVG も git 管理対象。

| 図 | ソース | 出力 |
|---|---|---|
| システム概観 | [diagrams/system-overview.mmd](./diagrams/system-overview.mmd) | [svg/system-overview.svg](./diagrams/svg/system-overview.svg) |
| アップロードシーケンス | [diagrams/upload-sequence.mmd](./diagrams/upload-sequence.mmd) | [svg/upload-sequence.svg](./diagrams/svg/upload-sequence.svg) |
| OAuth シーケンス | [diagrams/oauth-sequence.mmd](./diagrams/oauth-sequence.mmd) | [svg/oauth-sequence.svg](./diagrams/svg/oauth-sequence.svg) |
| アップロード状態遷移 | [diagrams/upload-state.mmd](./diagrams/upload-state.mmd) | [svg/upload-state.svg](./diagrams/svg/upload-state.svg) |
| チャンク分割シーケンス | [diagrams/chunked-sequence.mmd](./diagrams/chunked-sequence.mmd) | [svg/chunked-sequence.svg](./diagrams/svg/chunked-sequence.svg) |

## 簡易要件 (原典)

- MCP サーバーは、アップロードごとに短命のアップロード用認証情報を発行する
- 認証情報は、特定の `uploadId` / `userId` / `filename` / `maxSize` / `contentType` / `sha256` に紐づける
- クライアントは、アップロード前または完了通知時にファイルの `sha256` を MCP サーバーへ渡す
- ファイル本体は MCP 経由では送らず、アップロードアプリの専用エンドポイントへ直接送信する
- アップロードアプリは、認証情報の有効期限・権限・対象ファイル・サイズ・`sha256` を検証してから保存する
- アップロード完了後、クライアントは MCP サーバーへ `uploadId` と `sha256` を渡して完了通知する
- MCP サーバーは保存状態と `sha256` の一致を確認し、参照用の `fileId` または `resourceUri` を返す
