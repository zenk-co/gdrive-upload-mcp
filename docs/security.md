# Security

[← SPEC.md に戻る](./SPEC.md)

## 脅威モデル

| 攻撃 | 影響 | 対策 |
|---|---|---|
| 他人の `uploadUrl` を盗み取り別ファイルを送る | 改ざんファイルを他人の Drive に保存 | JWT に `sub` (userId)、`maxSize`、`contentType`、`sha256`(任意) をバインド。Upload handler / `complete_upload` で `record.userId === jwt.sub` を強制 |
| 既発行の JWT をリプレイ | 過去の `uploadId` で再アップロード | `UPLOAD_KV` のレコードが `status === "pending"` でなければ拒否 (二度目以降は 409) |
| サイズ偽装 (`Content-Length` を小さく宣言してから大量送信) | Worker メモリ・帯域の浪費 | `TransformStream` が `chunk` 毎に累積バイト数をチェックし、`maxBytes` 超過で即 `controller.error()` → Drive session も `DELETE` |
| ハッシュ偽装 (改ざんファイルを通す) | 受信ファイルが要求と異なる | Worker 内で SHA-256 を計算し、JWT に事前バインドされた `sha256` と一致しなければ Drive ファイルを削除、KV を `failed` に |
| 期限切れトークンの利用 | 古いセッションの乗っ取り | `exp` 検証。`UPLOAD_KV` にも TTL を設定 |
| `alg: none` / `alg: RS256` への切替 | 署名検証の迂回 | `verifyUploadJwt` で `header.alg === "HS256"` を強制 |
| OAuth CSRF (`/callback` への偽 code 注入) | 別アカウントとの紐付け汚染 | `state` を `OAUTH_KV` に保存し、`/callback` で照合・即削除 |
| Worker secret 漏洩 | JWT 偽造 + Google client secret 漏洩 | Worker secrets として保管。ログ出力禁止。`JWT_SIGNING_KEY` は 32 バイト以上のランダム |
| Drive スコープ過大 | サーバー経由で既存ファイルを読み放題 | `drive.file` のみ。サーバー作成ファイル以外は API から見えない |

## 多層防御

`uploadId / userId / size / sha256` の検証は **3 箇所** で重複して行う:

1. **JWT verify** (Upload handler 入口) — 署名・`exp`・`iss/aud`・bound `uploadId` を検証
2. **KV record check** (Upload handler) — `status === pending`、`record.userId === jwt.sub`、Content-Length と `maxSize` の比較
3. **完了時 sha256 検証** — Worker 計算値と JWT の `sha256`、また `complete_upload` 引数の照合

このうち 1 つでも不一致なら受信は失敗 / 受信済みファイルは削除する。

## 鍵管理

| シークレット | 役割 | ローテーション戦略 |
|---|---|---|
| `JWT_SIGNING_KEY` | アップロード JWT 署名 | JWT TTL が 15 分なので、新キーへ切替後 15 分以上待てば旧キーを完全に廃止できる |
| `GOOGLE_CLIENT_SECRET` | Google OAuth | Google Cloud Console で新シークレット発行 → `wrangler secret put` → 旧シークレット削除 |
| `COOKIE_SECRET` | OAuthProvider セッション | OAuthProvider の grant 寿命に依存 (デフォルト数日) |

## ログとプライバシー

- `console.error` で出力するエラーには JWT/refresh_token/raw bytes を含めない
- `email` は `props` に入るが、`UPLOAD_KV` の `UploadRecord` には保存しない (`userId` のみ)
- Drive ファイルのバイト列は KV に残さない (ストリームリレーのみ)

## 既知のリスクと未対応事項

- KV は eventually consistent。攻撃でなくても `prepare_upload` 直後の `PUT` でレコード未到達となる可能性。リトライで吸収する想定で、現状はセキュリティリスクとはみなさない
- `parentFolderId` を信用する。書込権限は Drive 側で判定されるが、サーバーは folderId が User 所有かを検証していない (Drive 側で拒否されるので情報漏洩はない)
- 単一 Worker のため `JWT_SIGNING_KEY` を MCP と Upload handler で共有する。鍵分離するには別 Worker への分割が必要 (将来対応)
- Rate limit / abuse protection は未実装。必要なら Cloudflare Rate Limiting Rules を `/upload/*` に適用する
