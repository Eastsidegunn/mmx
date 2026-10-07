[English](README.md) · [한국어](README.ko.md) · 简体中文 · [日本語](README.ja.md) · [Español](README.es.md)
> 本文译自英文原版 [README.md](README.md)（基于 8d9f4b0）。英文版可能更新得更快。

**AI agent? Read [AGENTS.md](AGENTS.md) first.**

# mmx

和智能体在同一张 Mermaid 图上一起画：你改图，它准确读出你改了什么，再直接在图上回应。

![mmx demo: a human edits the diagram, the agent answers](media/demo.gif)

[![CI](https://github.com/Eastsidegunn/mmx/actions/workflows/ci.yml/badge.svg)](https://github.com/Eastsidegunn/mmx/actions/workflows/ci.yml)
[![crates.io](https://img.shields.io/crates/v/mmx.svg)](https://crates.io/crates/mmx)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

给方框改个名，拖出一条新箭头，加条备注，点击发送。智能体拿到的是确切的改动（哪个节点、哪条连线、你的备注），而不是一段需要它去揣摩的文字；它也直接修改同一张图来回复。你的注释、虚线箭头和样式都会保留，你们看到的始终是同一张图。

## 安装

```bash
curl -LsSf https://github.com/Eastsidegunn/mmx/releases/latest/download/mmx-installer.sh | sh   # or: cargo install mmx
mmx init   # Claude Code skill; add --codex for Codex
mmx --version   # serve, wait, note and diff v2 need 0.4.0 or newer
```

## 试一试

1. 告诉智能体：*“用 mmx 把我们的结账流程画成 `diagram.mmd`，然后等我修改。”*
2. 运行 `mmx serve diagram.mmd`，打开终端输出的网址。
3. 直接在图上编辑并点击发送。智能体会在图上回应。

支持 Claude Code、Codex，以及任何能运行 CLI 的智能体。纯本地运行：无需账号，不依赖任何托管服务。

## 更多内容

- [使用指南](GUIDE.md) (English)：一轮交互如何进行、命令、局限
- [安装详情](INSTALL.md) (English)
- [嵌入编辑器](editor/README.md) (English)
- [更新日志](CHANGELOG.md) (English) · [参与贡献](CONTRIBUTING.md) (English) · [安全说明](SECURITY.md) (English) · [许可证 (MIT)](LICENSE) (English)
