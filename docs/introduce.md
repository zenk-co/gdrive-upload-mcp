# 利用者向け接続ガイド

すでにデプロイ済みの本 MCP サーバーを Claude (Cowork / Desktop) から使うまでの手順です。

サーバーをご自身でデプロイする場合は [deploy.md](./deploy.md) を参照してください。

## 前提

| 項目 | 値 |
|---|---|
| Claude のプラン | Pro / Max / Team / Enterprise (カスタムコネクタが使えるプラン) |
| MCP サーバーの URL | `https://gdrive-upload-mcp.<your-subdomain>.workers.dev/mcp` |
| 必要な Google 権限 | 自分の Drive にファイルを書き込める Google アカウント |

> URL はサーバーをデプロイした人の Cloudflare サブドメインに置き換えてください。自分でデプロイする手順は [deploy.md](./deploy.md) を参照。

## 手順 (3 ステップ)

### ステップ 1: ドメイン許可リストに追加

Claude の **設定 → 機能** を開く。「ネットワーク外部通信を許可」を ON にした上で、「追加の許可ドメイン」に次を入力して **追加**:

```
*.<your-subdomain>.workers.dev
```

(`gdrive-upload-mcp.<your-subdomain>.workers.dev` のみでも可)

これをやらないと、Claude のサンドボックスから本サーバーへの PUT が **`cowork-egress-blocked`** で弾かれます。

### ステップ 2: カスタムコネクタを追加

Claude の **設定 → コネクタ** を開き、右上の **「+」** から「カスタムコネクタを追加」を選択。

| フィールド | 入力値 |
|---|---|
| 名前 | `ファイルアップロード` (好きな名前で OK) |
| URL | `https://gdrive-upload-mcp.<your-subdomain>.workers.dev/mcp` |

**追加** ボタンを押す。

### ステップ 3: 連携を開始 (重要)

コネクタを追加しただけでは **「未接続」** 状態で使えません。コネクタ一覧から追加したコネクタを選び、右側の **「連携/連携させる」ボタンを押す**。

→ 新しいタブで Google のログイン画面が開く
→ Google アカウントを選択 (「警告: このアプリは Google で確認されていません」と出たら **詳細 → 移動** を押す。これはサーバー開発者本人の OAuth クライアントを使っているため)
→ 「**Google Drive のファイルの表示・編集・作成・削除**」の権限を承認

→ 自動でタブが閉じ、コネクタが **接続済み** になります。

## 使い方

これでチャット中に `prepare_upload` と `complete_upload` の 2 つのツールが Claude から呼べるようになります。例:

> 「今のスプレッドシートを PDF にして Drive に保存して」
> 「下の図を `report.png` で Drive に上げて」

Claude が以下の流れを自動実行:

1. `prepare_upload` でアップロード URL とトークンを取得
2. ファイル本体を HTTP PUT で送信 (Claude のサンドボックスからの egress なのでステップ 1 の許可が必須)
3. `complete_upload` で SHA-256 検証 → Drive の `fileId` を取得

保存先は **あなた自身の Google Drive** (My Drive 直下)。サーバー開発者は中身を見られません (`drive.file` スコープなので、このコネクタ経由で作ったファイルしか API から触れない仕様)。

## トラブルシュート

| 症状 | 対処 |
|---|---|
| 「`cowork-egress-blocked`」 PUT が拒否される | ステップ 1 のドメイン許可がされていない |
| 「`redirect_uri_mismatch`」Google エラー | サーバー開発者に「Google Cloud Console の redirect URI に登録できているか」確認依頼 |
| Google で「アプリは確認されていません」 | OAuth クライアントが未公開のため。**詳細 → 移動** で進めてください (Test ユーザー登録済みなら表示されないこともある) |
| `complete_upload` で「upload not completed」 | PUT に失敗している。コネクタを切断 → 再接続でセッションをリセットしてやり直す |
| そもそも接続できない | サーバー側のデプロイが古い可能性。サーバー開発者に再デプロイ依頼 |

## 接続を解除する

設定 → コネクタ → 該当コネクタ → 切断ボタン。Cloudflare 側に保存されている Google アクセストークンは無効化されます (refresh_token も無効にしたい場合は <https://myaccount.google.com/permissions> から本アプリを削除)。
