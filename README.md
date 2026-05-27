<div align="center">

# 📤 Google Drive Upload MCP Server

**あらゆるサイズのファイルを、MCP クライアントから Google Drive へ — JSON-RPC ではなく素の HTTP で直接アップロード。**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-Streamable_HTTP-111111)](https://modelcontextprotocol.io/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**日本語** · [English](#english)

</div>

---

[Cloudflare Worker](https://workers.cloudflare.com/) 上で動く Model Context Protocol (MCP) サーバーです。MCP クライアント (Claude Desktop / Cowork など) から、**ユーザー本人の Google Drive** へファイルをアップロードできます。

設計の肝は **制御プレーン / データプレーン分離**です。ファイル本体は MCP/JSON-RPC を通りません。サーバーは短命の署名付き URL をクライアントに渡し、クライアントはその専用 HTTP エンドポイントへ生のバイト列を直接 `PUT` します。Worker はそれを Google Drive へストリームリレーします。

<div align="center">
  <img src="docs/diagrams/svg/system-overview.svg" alt="システム概観" width="720">
</div>

## ✨ この設計の利点

| | |
|---|---|
| 🚀 **大容量ファイル** | バイト列が JSON-RPC を経由せず Drive へ直接ストリーム。base64 肥大もメッセージサイズ制限もなし。 |
| 🔐 **アップロード単位の認証情報** | アップロードごとに、単一の `uploadId` / `userId` / サイズ / content-type / SHA-256 に紐づく短命 JWT を発行。 |
| 🧮 **エンドツーエンドの整合性** | Worker がストリーム中に SHA-256 を計算し、Drive へのリレー完了後に照合。不一致なら Drive のファイルを削除(best-effort)。 |
| 🪪 **ユーザー所有のストレージ** | OAuth 2.1、upstream IdP は Google。ファイルは*ユーザー自身*の Drive (`drive.file` スコープ) に保存され、運用者は中身を読めない。 |
| 🧩 **2 つの小さなツール** | `prepare_upload` と `complete_upload` だけが操作面。 |

## 🌐 必要要件: エージェントが送信先への egress を許可できること

ファイル本体は、エージェントの実行環境から `/upload/:id`(データプレーン)への **直接の HTTPS `PUT`** で送られます。そのため、エージェントの環境が**あなたの Worker ドメインへの外向き通信を許可**でき、かつ **`PUT` メソッドを許可**している必要があります(サンドボックスによっては、許可ドメインでも読み取り系メソッドしか通さないことがあります)。

目安:

- **ローカル実行のエージェント**(Claude Code / Codex CLI / Gemini CLI)は自分のマシンで動くため、ほぼ確実に egress を許可設定できる(または既に許可されている)。
- **クラウド / サンドボックス型のエージェント**は、ドメイン許可リストを設定でき、**かつ読み取り以外のメソッドを許可**している場合のみ利用可能。外向き通信を完全に遮断するものも多い。

| エージェント | 実行形態 | egress / ドメイン許可 | 利用可否 |
|---|---|---|---|
| **[Claude Code](https://code.claude.com/docs/en/sandboxing)** | ローカル CLI | 許可モード: *None* / *パッケージマネージャ + カスタム* / *All*。Enterprise は管理ドメインを固定可 | ✅ 自分のドメインを追加(または非サンドボックスで実行) |
| **[OpenAI Codex CLI](https://developers.openai.com/codex/concepts/sandboxing)** | ローカル CLI | `workspace-write` では既定でネットワーク off。有効化し allow ルールを追加(`config.toml` → `network_proxy`) | ✅ ネットワーク有効化 + ドメイン許可 |
| **[Gemini CLI](https://geminicli.com/docs/cli/sandbox/)** | ローカル CLI | `*-proxied` サンドボックスプロファイル + 許可リスト | ✅ proxied プロファイル + ドメイン許可 |
| **[Claude — Cowork / claude.ai コネクタ](docs/introduce.md)** | クラウド / デスクトップ agent | 「ネットワーク外部通信を許可」+ *追加の許可ドメイン* | ✅ 自分のドメインを追加([docs/introduce.md](docs/introduce.md) 参照) |
| **[OpenAI Codex(クラウド / web)](https://developers.openai.com/codex/cloud/internet-access)** | クラウドサンドボックス | 既定で off。許可リストプリセットあり。GET/HEAD/OPTIONS のみに制限される場合あり | ⚠️ ドメイン許可に加え、**読み取り専用メソッド制限で `PUT` が塞がれていない**ことを要確認 |
| egress 設定を**持たない**サンドボックス agent | クラウド | なし | ❌ アップロードエンドポイントへ到達不可 |

> egress が許可されていないと `PUT` は失敗します(Claude では `cowork-egress-blocked` として表示)。`prepare_upload` / `complete_upload` の呼び出しは MCP トランスポートを通るので成功しますが、ファイル本体を送れません。

> **⚠️ 動作確認済みは Claude(claude.ai / Cowork コネクタ)のみです。** 表内の他のエージェントは各サンドボックスの公開ドキュメントからの推定で、メンテナによる**検証はしていません**。他のエージェントでの動作報告・PR を歓迎します。

## 🛠️ MCP ツール

| ツール | 入力 | 出力 |
| --- | --- | --- |
| `prepare_upload` | `{ filename, size, contentType, sha256?, parentFolderId? }` | `{ uploadId, uploadUrl, uploadToken, expiresAt }` |
| `complete_upload` | `{ uploadId, sha256 }` | `{ fileId, resourceUri, name, mimeType, size, sha256 }` |

実際のファイル転送は、2 つの呼び出しの間に `uploadUrl` へ行う通常の HTTPS `PUT` です(→ [使い方](#-使い方))。

## 🏗️ アーキテクチャ

- **`/mcp`** — `McpAgent` (Durable Object) による Streamable HTTP MCP。[`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) の Bearer 認証で保護。
- **`/upload/:uploadId`** — データプレーン。クライアントがファイル本体を `PUT` し、Worker が SHA-256 を計算しつつ Google Drive resumable session へストリームリレー。
- **`/authorize`, `/callback`, `/oauth/token`, `/oauth/register`** — OAuth 2.1。upstream IdP は Google。

設計根拠の全体は [`docs/SPEC.md`](docs/SPEC.md) を参照。

## 🚀 セットアップ

```bash
npm install --legacy-peer-deps

# KV 名前空間を 3 つ作成し、各 id を wrangler.jsonc に貼る
wrangler kv namespace create UPLOAD_KV
wrangler kv namespace create TOKEN_KV
wrangler kv namespace create OAUTH_KV

# シークレット (本番)
wrangler secret put JWT_SIGNING_KEY     # 例: openssl rand -base64 48
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put COOKIE_SECRET       # 例: openssl rand -base64 32
```

ローカル開発では env テンプレートをコピー (gitignored):

```bash
cp .dev.vars.example .dev.vars   # 値を記入
npm run dev                       # http://localhost:8787
```

デプロイ手順の全体 (Google Cloud Console 設定 / KV id / `WORKER_BASE_URL`) は **[`docs/deploy.md`](docs/deploy.md)**。
デプロイ済みサーバーへの接続手順は **[`docs/introduce.md`](docs/introduce.md)**。

## 📥 使い方

1. MCP クライアントに `{WORKER_BASE_URL}/mcp` を Streamable HTTP MCP として登録。
2. 初回接続時に Google ログイン → Drive スコープを承認。
3. `prepare_upload` を呼び `uploadUrl` / `uploadToken` / `uploadId` を取得。
4. ファイル本体を `PUT`:
   ```bash
   curl -X PUT "$uploadUrl" \
        -H "Authorization: Bearer $uploadToken" \
        -H "Content-Type: $contentType" \
        -H "Content-Length: $size" \
        --data-binary @./file.bin
   ```
5. `complete_upload` を呼び、SHA-256 検証と `fileId` / `resourceUri` (`gdrive://files/<id>`) を取得。

## 📜 スクリプト

| スクリプト | 説明 |
| --- | --- |
| `npm run dev` | `wrangler dev` (http://localhost:8787) |
| `npm run deploy` | `wrangler deploy` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest ユニットテスト (jwt / sha256 / handlers) |
| `npm run docs:build` | `docs/diagrams/*.mmd` → SVG を再生成 |

## 📚 ドキュメント

| トピック | ファイル |
|---|---|
| 仕様・設計根拠 | [docs/SPEC.md](docs/SPEC.md) |
| アーキテクチャ | [docs/architecture.md](docs/architecture.md) |
| MCP ツール | [docs/mcp-tools.md](docs/mcp-tools.md) |
| アップロードフロー | [docs/upload-flow.md](docs/upload-flow.md) |
| 認証 | [docs/auth.md](docs/auth.md) |
| データモデル | [docs/data-model.md](docs/data-model.md) |
| セキュリティ / 脅威モデル | [docs/security.md](docs/security.md) |
| デプロイガイド | [docs/deploy.md](docs/deploy.md) |
| クライアント接続ガイド | [docs/introduce.md](docs/introduce.md) |

## ⚠️ 制限・既知の事項

- 単一 `PUT` のサイズは Cloudflare Workers の上限まで (`MAX_UPLOAD_BYTES`)。それ以上はチャンク分割 `PUT` に対応。
- `drive.file` スコープのため、このサーバー経由で作成したファイルのみ Drive API から参照可能。
- KV は結果整合。`prepare_upload` 直後の `complete_upload` で稀に再試行が要る場合あり。

## 🤝 コントリビュート

Issue / PR を歓迎します → [CONTRIBUTING.md](CONTRIBUTING.md)。セキュリティ報告は [SECURITY.md](SECURITY.md) を参照。

## 📄 ライセンス

[MIT](LICENSE) © ZENK Co., Ltd.

<br/>

---

<div align="center">

## English

[日本語](#-google-drive-upload-mcp-server) · **English**

**Upload files of any size to Google Drive straight from your MCP client — over plain HTTP, not through JSON-RPC.**

</div>

A Model Context Protocol (MCP) server that runs on a [Cloudflare Worker](https://workers.cloudflare.com/) and lets an MCP client (Claude Desktop, Cowork, …) upload files into the **user's own Google Drive**.

Its defining design choice is a **control plane / data plane split**: file bytes never travel through MCP/JSON-RPC. The server hands the client a short-lived signed URL, and the client `PUT`s the raw bytes directly to a dedicated HTTP endpoint that streams them into Google Drive.

### ✨ Why this design

| | |
|---|---|
| 🚀 **Large files** | Bytes bypass JSON-RPC and stream directly to Drive — no base64 bloat, no message-size limits. |
| 🔐 **Per-upload credentials** | Each upload gets a short-lived JWT scoped to one `uploadId` / `userId` / size / content-type / SHA-256. |
| 🧮 **End-to-end integrity** | The Worker computes SHA-256 while streaming and verifies it once the relay completes; on mismatch the Drive file is deleted (best-effort). |
| 🪪 **User-owned storage** | OAuth 2.1 with Google as the upstream IdP. Files land in the *user's* Drive (`drive.file` scope); the operator can't read them. |
| 🧩 **Two small tools** | `prepare_upload` and `complete_upload` — that's the entire control surface. |

### 🌐 Requirement: your agent must allow egress to the upload endpoint

The file body is sent as a **direct HTTPS `PUT`** from the agent's runtime to `/upload/:id` (the data plane). So the agent's environment must permit **outbound network access to your Worker's domain**, and must allow the **`PUT`** method — some sandboxes only permit read-only methods even for allow-listed domains.

Rule of thumb:

- **Locally-run agents** (Claude Code, Codex CLI, Gemini CLI) run on your machine and can almost always be configured to allow — or already allow — the egress.
- **Cloud / sandboxed agents** work only if they expose a configurable domain allowlist **and** permit non-read-only methods. Many block outbound traffic entirely.

| Agent | Runtime | Egress / domain allowlist | Usable |
|---|---|---|---|
| **[Claude Code](https://code.claude.com/docs/en/sandboxing)** | local CLI | Allowlist modes: *None* / *Package managers + custom* / *All*; enterprise can pin managed domains | ✅ add your domain (or run unsandboxed) |
| **[OpenAI Codex CLI](https://developers.openai.com/codex/concepts/sandboxing)** | local CLI | Network off by default in `workspace-write`; enable it and add allow rules (`config.toml` → `network_proxy`) | ✅ enable network + allow your domain |
| **[Gemini CLI](https://geminicli.com/docs/cli/sandbox/)** | local CLI | `*-proxied` sandbox profiles with an allowlist | ✅ use a proxied profile + allow your domain |
| **[Claude — Cowork / claude.ai connectors](docs/introduce.md)** | cloud / desktop agent | "Allow network egress" + *additional allowed domains* | ✅ add your domain (see [docs/introduce.md](docs/introduce.md)) |
| **[OpenAI Codex (cloud / web)](https://developers.openai.com/codex/cloud/internet-access)** | cloud sandbox | Off by default; allowlist presets; may restrict to GET/HEAD/OPTIONS | ⚠️ allow your domain **and** ensure `PUT` is not blocked by read-only method filtering |
| Sandboxed agents with **no egress config** | cloud | none | ❌ cannot reach the upload endpoint |

> If egress is not permitted, the `PUT` fails (Claude surfaces this as `cowork-egress-blocked`). The `prepare_upload` / `complete_upload` calls still go through the MCP transport, but the file body cannot be delivered.

> **⚠️ Verified only with Claude (claude.ai / Cowork connectors).** The other agents in the table are inferred from their documented sandbox / egress capabilities and have **not** been tested by the maintainers. Reports and PRs confirming other agents are very welcome.

### 🛠️ MCP Tools

| Tool | Input | Output |
| --- | --- | --- |
| `prepare_upload` | `{ filename, size, contentType, sha256?, parentFolderId? }` | `{ uploadId, uploadUrl, uploadToken, expiresAt }` |
| `complete_upload` | `{ uploadId, sha256 }` | `{ fileId, resourceUri, name, mimeType, size, sha256 }` |

The actual file transfer is a regular HTTPS `PUT` to `uploadUrl` between the two calls — see [Usage](#-usage).

### 🏗️ Architecture

- **`/mcp`** — Streamable HTTP MCP via an `McpAgent` (Durable Object), protected by [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) Bearer auth.
- **`/upload/:uploadId`** — the data plane. The client `PUT`s the file body here; the Worker computes SHA-256 while relaying the stream into a Google Drive resumable session.
- **`/authorize`, `/callback`, `/oauth/token`, `/oauth/register`** — OAuth 2.1, with Google as the upstream IdP.

Full design rationale lives in [`docs/SPEC.md`](docs/SPEC.md).

### 🚀 Quick Start

```bash
npm install --legacy-peer-deps

# Create three KV namespaces and paste each id into wrangler.jsonc
wrangler kv namespace create UPLOAD_KV
wrangler kv namespace create TOKEN_KV
wrangler kv namespace create OAUTH_KV

# Secrets (production)
wrangler secret put JWT_SIGNING_KEY     # e.g. openssl rand -base64 48
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put COOKIE_SECRET       # e.g. openssl rand -base64 32
```

For local development, copy the env template (it is gitignored):

```bash
cp .dev.vars.example .dev.vars   # then fill in the values
npm run dev                       # http://localhost:8787
```

Full deployment walkthrough (Google Cloud Console setup, KV ids, `WORKER_BASE_URL`): **[`docs/deploy.md`](docs/deploy.md)**.
Connecting an MCP client to an already-deployed server: **[`docs/introduce.md`](docs/introduce.md)**.

### 📥 Usage

1. Register `{WORKER_BASE_URL}/mcp` in your MCP client as a Streamable HTTP MCP.
2. On first connect, authorize via Google and grant the Drive scope.
3. Call `prepare_upload` to get `uploadUrl` / `uploadToken` / `uploadId`.
4. `PUT` the file body:
   ```bash
   curl -X PUT "$uploadUrl" \
        -H "Authorization: Bearer $uploadToken" \
        -H "Content-Type: $contentType" \
        -H "Content-Length: $size" \
        --data-binary @./file.bin
   ```
5. Call `complete_upload` to verify SHA-256 and get the `fileId` / `resourceUri` (`gdrive://files/<id>`).

### 📜 Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | `wrangler dev` (http://localhost:8787) |
| `npm run deploy` | `wrangler deploy` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest unit tests (jwt / sha256 / handlers) |
| `npm run docs:build` | Render `docs/diagrams/*.mmd` → SVG |

### 📚 Documentation

| Topic | File |
|---|---|
| Spec & design rationale | [docs/SPEC.md](docs/SPEC.md) |
| Architecture | [docs/architecture.md](docs/architecture.md) |
| MCP tools | [docs/mcp-tools.md](docs/mcp-tools.md) |
| Upload flow | [docs/upload-flow.md](docs/upload-flow.md) |
| Authentication | [docs/auth.md](docs/auth.md) |
| Data model | [docs/data-model.md](docs/data-model.md) |
| Security / threat model | [docs/security.md](docs/security.md) |
| Deploy guide | [docs/deploy.md](docs/deploy.md) |
| Client connection guide | [docs/introduce.md](docs/introduce.md) |

### ⚠️ Limitations

- Single-`PUT` size is capped by Cloudflare Workers limits (`MAX_UPLOAD_BYTES`). Chunked `PUT` exists for larger files.
- `drive.file` scope means only files created through this server are visible to the Drive API.
- KV is eventually consistent; a `complete_upload` immediately after `prepare_upload` may rarely need a retry.

### 🤝 Contributing

Issues and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). For security reports, see [SECURITY.md](SECURITY.md).

### 📄 License

[MIT](LICENSE) © ZENK Co., Ltd.
