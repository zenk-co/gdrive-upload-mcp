# Contributing

このプロジェクトへの貢献を歓迎します。バグ報告・機能提案・PR いずれも歓迎です。

## はじめに

- バグや要望は **Issue** で。再現手順・期待する挙動・実際の挙動を添えてください。
- セキュリティ上の問題は Issue ではなく [SECURITY.md](SECURITY.md) の手順で報告してください。
- 大きな変更を入れる前に、まず Issue で方針を相談してもらえると手戻りが減ります。

## 開発環境

```bash
npm install --legacy-peer-deps   # peer 依存解決のため --legacy-peer-deps が必要
cp .dev.vars.example .dev.vars   # ローカル用シークレットを記入 (gitignored)

npm run dev          # wrangler dev (http://localhost:8787)
npm run typecheck    # tsc --noEmit
npm test             # vitest
```

セットアップ全体は [README.md](README.md)、自分のアカウントへのデプロイは
[docs/deploy.md](docs/deploy.md) を参照してください。

## PR を出す前に

- `npm run typecheck` と `npm test` が通ること。
- 振る舞いを変える変更にはテストを追加すること (`test/` 配下)。
- ドキュメント図 (`docs/diagrams/*.mmd`) を編集したら `npm run docs:build` で
  SVG を再生成し、`.mmd` と `.svg` の両方をコミットすること。
- コミットメッセージは命令形 (`Add ...` / `Fix ...`) で簡潔に。

## ブランチ / PR フロー

1. このリポジトリを fork する。
2. トピックブランチを切る (`feat/...`, `fix/...`, `docs/...` など)。
3. 変更をコミットし、fork に push。
4. main 向けに Pull Request を開く。

## ライセンス

貢献いただいたコードは、本プロジェクトと同じ [MIT License](LICENSE) の下で
公開されることに同意したものとみなします。
