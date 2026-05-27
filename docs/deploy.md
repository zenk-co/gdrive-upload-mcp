# デプロイガイド (運用者向け)

このサーバーを自分の Cloudflare アカウントにデプロイする手順です。

利用者として既存サーバーへ接続したいだけなら [introduce.md](./introduce.md) を見てください。

## 前提

| 必要なもの | 確認方法 |
|---|---|
| Cloudflare アカウント (Workers が使えること) | <https://dash.cloudflare.com> にログイン |
| Google Cloud Console アクセス権 | <https://console.cloud.google.com/apis/credentials> |
| Node.js 20 以上 | `node -v` |
| `wrangler` CLI (devDep で入る) | `npx wrangler --version` |

## 手順

### 1. リポジトリ取得 + 依存インストール

```bash
git clone <this repo>
cd gdrive-upload-mcp
npm install --legacy-peer-deps
```

### 2. Google OAuth クライアントを作成

1. [Google Cloud Console > APIs & Services > Credentials](https://console.cloud.google.com/apis/credentials) を開く
2. **Create credentials → OAuth client ID** を選択
3. **Application type: Web application**
4. 承認済みのリダイレクト URI は後で追加するので最初は空のまま
5. 作成された **client_id** と **client_secret** を控える
6. **OAuth 同意画面** でスコープに以下を追加 (まだなら):
   - `openid`
   - `email`
   - `profile`
   - `https://www.googleapis.com/auth/drive.file`

### 3. Cloudflare にログインして KV を 3 つ作成

```bash
npx wrangler login                          # 初回のみ
npx wrangler kv namespace create UPLOAD_KV
npx wrangler kv namespace create TOKEN_KV
npx wrangler kv namespace create OAUTH_KV
```

各コマンドが返す `"id": "..."` を [wrangler.jsonc](../wrangler.jsonc) の `kv_namespaces` に貼り付け。

### 4. シークレットを投入

```bash
openssl rand -base64 48 | tr -d '\n' | npx wrangler secret put JWT_SIGNING_KEY
openssl rand -base64 48 | tr -d '\n' | npx wrangler secret put COOKIE_SECRET
echo -n "<step 2 の client_id>"     | npx wrangler secret put GOOGLE_CLIENT_ID
echo -n "<step 2 の client_secret>" | npx wrangler secret put GOOGLE_CLIENT_SECRET
```

### 5. 初回デプロイ

```bash
npx wrangler deploy
```

ログの末尾の URL を控える (例: `https://gdrive-upload-mcp.<your-subdomain>.workers.dev`)。

### 6. `WORKER_BASE_URL` を更新して再デプロイ

[wrangler.jsonc](../wrangler.jsonc) の `vars.WORKER_BASE_URL` を初回デプロイで得た URL に書き換える。

```bash
npx wrangler deploy
```

### 7. Google にデプロイ後の callback URL を登録

ステップ 2 で作った OAuth クライアントの「承認済みのリダイレクト URI」に追加:

```
https://gdrive-upload-mcp.<your-subdomain>.workers.dev/callback
```

(ローカル開発併用なら `http://127.0.0.1:8787/callback` と `http://localhost:8787/callback` も追加)

これで、利用者は [introduce.md](./introduce.md) の手順で接続できます。

## 設定のチューニング

[wrangler.jsonc](../wrangler.jsonc) の `vars` で調整できる項目:

| 変数 | 既定値 | 用途 |
|---|---|---|
| `MAX_UPLOAD_BYTES` | `104857600` (100 MB) | 1 ファイルあたりの上限。500 MB 等にするには Cloudflare Workers Paid プランが必要 |
| `TOKEN_TTL_SECONDS` | `900` (15 分) | `prepare_upload` で発行する JWT の有効期間 |
| `GOOGLE_OAUTH_SCOPES` | `openid email profile https://www.googleapis.com/auth/drive.file` | Google から要求するスコープ |

## ローカル開発

```bash
cp .dev.vars.example .dev.vars
# .dev.vars を編集

npx wrangler dev                    # http://localhost:8787
npm test                            # ユニットテスト
npm run typecheck
npm run docs:build                  # mermaid → SVG
```

## トラブルシュート (運用者向け)

| 症状 | 確認ポイント |
|---|---|
| `Cannot POST /register` で接続失敗 | `/.well-known/oauth-protected-resource` が 200 を返すか確認 (RFC 9728 のメタデータが必要) |
| `redirect_uri_mismatch` | Google Cloud Console の「承認済みのリダイレクト URI」に当該 URL が登録されているか |
| `not authenticated` でツール実行が失敗 | OAuth 接続を一度切断 → 再接続。`npx wrangler kv key list --binding=TOKEN_KV` でトークン保存状態確認 |
| `complete_upload` が `pending` のまま | KV ではなく `UPLOAD_SESSION` DO ストレージを参照するように修正済み。それでも出る場合は `wrangler tail` でリクエストログを |
| クライアントの sandbox が PUT を弾く | 利用者に Worker ドメインを許可リストに追加してもらう ([introduce.md](./introduce.md) 参照) |

## 次のステップ

- カスタムドメインを Worker に紐づけて URL を綺麗にする
- Workers Paid プランに上げて大容量対応 + DO ハイバネ抑制
- 追加 MCP ツール (`list_files`, `download_file`) を生やす
