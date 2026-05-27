# Security Policy

## 脆弱性の報告 / Reporting a Vulnerability

セキュリティ上の問題を見つけた場合は、**公開 Issue を立てず**に、GitHub の
[Private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
(リポジトリの **Security → Report a vulnerability**) からご連絡ください。

Please **do not open a public issue** for security problems. Instead, use
GitHub's private vulnerability reporting via the repository's
**Security → Report a vulnerability** tab.

報告には以下を含めてください:

- 影響範囲 (どのエンドポイント / トークン / データが対象か)
- 再現手順
- 想定される影響 (情報漏洩・なりすまし・改ざんなど)

## 対応 / Response

- 受領の確認をできるだけ早く返します。
- 修正方針と公開時期は報告者と調整します。
- 本プロジェクトはベストエフォートで保守されており、SLA はありません。

## 設計上の前提 / Threat model

脅威モデルと既存の対策 (リプレイ・トークン横取り・サイズ偽装など) は
[`docs/security.md`](docs/security.md) に記載しています。報告前に一読いただけると
重複報告を避けられます。
