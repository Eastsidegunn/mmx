[English](README.md) · [한국어](README.ko.md) · [简体中文](README.zh-CN.md) · 日本語 · [Español](README.es.md)
> この文書は英語版 [README.md](README.md) の翻訳です（基準: 8d9f4b0）。英語版のほうが新しい場合があります。

**AI agent? Read [AGENTS.md](AGENTS.md) first.**

# mmx

エージェントと同じ Mermaid ダイアグラムで一緒にスケッチしよう。あなたが図を編集すると、
エージェントは何を変えたかを正確に読み取り、図の上で応えます。

![mmx demo: a human edits the diagram, the agent answers](media/demo.gif)

[![CI](https://github.com/Eastsidegunn/mmx/actions/workflows/ci.yml/badge.svg)](https://github.com/Eastsidegunn/mmx/actions/workflows/ci.yml)
[![crates.io](https://img.shields.io/crates/v/mmx.svg)](https://crates.io/crates/mmx)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

ボックスの名前を変え、矢印をドラッグで引き、メモを添えて「送信」を押すだけ。
エージェントには解釈の必要な長文ではなく、変更そのもの（どのノードか、どの接続か、
あなたのメモ）が届き、エージェントは同じダイアグラムを編集して返答します。
あなたが書いたコメントや破線の矢印、スタイルはそのまま残り、お互いに同じ図を見ながら進められます。

## インストール

```bash
curl -LsSf https://github.com/Eastsidegunn/mmx/releases/latest/download/mmx-installer.sh | sh   # or: cargo install mmx
mmx init   # Claude Code skill; add --codex for Codex
mmx --version   # serve, wait, note and diff v2 need 0.4.0 or newer
```

## 試してみる

1. エージェントに頼みます：*「mmx で決済フローを `diagram.mmd` に描いて、私の編集を待って」*
2. `mmx serve diagram.mmd` を実行し、表示された URL を開きます。
3. 図の上で編集して「送信」を押します。エージェントはダイアグラムで応えます。

Claude Code、Codex のほか、CLI を実行できるエージェントなら何でも使えます。
ローカルで動作し、アカウント登録は不要、外部ホストにも何も置きません。

## 詳しく見る

- [ガイド](GUIDE.md) (English): ターンの流れ、コマンド、制限事項
- [インストールの詳細](INSTALL.md) (English)
- [エディタの埋め込み](editor/README.md) (English)
- [変更履歴](CHANGELOG.md) (English) · [コントリビュート](CONTRIBUTING.md) (English) · [セキュリティ](SECURITY.md) (English) · [ライセンス (MIT)](LICENSE) (English)
