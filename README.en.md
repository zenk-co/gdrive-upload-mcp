<div align="center">

# 📤 Google Drive Upload MCP Server

**Upload files of any size to Google Drive straight from your MCP client — over plain HTTP, not through JSON-RPC.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-Streamable_HTTP-111111)](https://modelcontextprotocol.io/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[![日本語](https://img.shields.io/badge/lang-日本語-lightgrey?style=for-the-badge)](README.md)
[![English](https://img.shields.io/badge/lang-English-blue?style=for-the-badge)](README.en.md)

</div>

---

A Model Context Protocol (MCP) server that runs on a [Cloudflare Worker](https://workers.cloudflare.com/) and lets an MCP client (Claude Desktop, Cowork, …) upload files into the **user's own Google Drive**.

Its defining design choice is a **control plane / data plane split**: file bytes never travel through MCP/JSON-RPC. The server hands the client a short-lived signed URL, and the client `PUT`s the raw bytes directly to a dedicated HTTP endpoint that streams them into Google Drive.

<div align="center">
  <img src="docs/diagrams/svg/system-overview.svg" alt="System overview" width="720">
</div>

## ✨ Why this design

| | |
|---|---|
| 🚀 **Large files** | Bytes bypass JSON-RPC and stream directly to Drive — no base64 bloat, no message-size limits. |
| 🔐 **Per-upload credentials** | Each upload gets a short-lived JWT scoped to one `uploadId` / `userId` / size / content-type / SHA-256. |
| 🧮 **End-to-end integrity** | The Worker computes SHA-256 while streaming and verifies it once the relay completes; on mismatch the Drive file is deleted (best-effort). |
| 🪪 **User-owned storage** | OAuth 2.1 with Google as the upstream IdP. Files land in the *user's* Drive (`drive.file` scope); the operator can't read them. |
| 🧩 **Two small tools** | `prepare_upload` and `complete_upload` — that's the entire control surface. |

## 🌐 Requirement: your agent must allow egress to the upload endpoint

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

## 🛠️ MCP Tools

| Tool | Input | Output |
| --- | --- | --- |
| `prepare_upload` | `{ filename, size, contentType, sha256?, parentFolderId? }` | `{ uploadId, uploadUrl, uploadToken, expiresAt }` |
| `complete_upload` | `{ uploadId, sha256 }` | `{ fileId, resourceUri, name, mimeType, size, sha256 }` |

The actual file transfer is a regular HTTPS `PUT` to `uploadUrl` between the two calls — see [Usage](#-usage).

## 🏗️ Architecture

- **`/mcp`** — Streamable HTTP MCP via an `McpAgent` (Durable Object), protected by [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) Bearer auth.
- **`/upload/:uploadId`** — the data plane. The client `PUT`s the file body here; the Worker computes SHA-256 while relaying the stream into a Google Drive resumable session.
- **`/authorize`, `/callback`, `/oauth/token`, `/oauth/register`** — OAuth 2.1, with Google as the upstream IdP.

Full design rationale lives in [`docs/SPEC.md`](docs/SPEC.md).

## 🚀 Quick Start

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

## 📥 Usage

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

## 📜 Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | `wrangler dev` (http://localhost:8787) |
| `npm run deploy` | `wrangler deploy` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest unit tests (jwt / sha256 / handlers) |
| `npm run docs:build` | Render `docs/diagrams/*.mmd` → SVG |

## 📚 Documentation

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

## ⚠️ Limitations

- Single-`PUT` size is capped by Cloudflare Workers limits (`MAX_UPLOAD_BYTES`). Chunked `PUT` exists for larger files.
- `drive.file` scope means only files created through this server are visible to the Drive API.
- KV is eventually consistent; a `complete_upload` immediately after `prepare_upload` may rarely need a retry.

## 🤝 Contributing

Issues and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). For security reports, see [SECURITY.md](SECURITY.md).

## 📄 License

[MIT](LICENSE) © ZENK Co., Ltd.
