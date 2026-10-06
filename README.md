English · [한국어](README.ko.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Español](README.es.md)

**AI agent? Read [AGENTS.md](AGENTS.md) first.**

# mmx

Sketch with your agent in the same Mermaid diagram: you edit the picture, it
reads exactly what you changed, it answers in the picture.

![mmx demo: a human edits the diagram, the agent answers](media/demo.gif)

[![CI](https://github.com/Eastsidegunn/mmx/actions/workflows/ci.yml/badge.svg)](https://github.com/Eastsidegunn/mmx/actions/workflows/ci.yml)
[![crates.io](https://img.shields.io/crates/v/mmx.svg)](https://crates.io/crates/mmx)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Rename a box, drag a new arrow, add a note, press Send. Your agent gets the
exact change (which node, which edge, your note) instead of a paragraph to
interpret, and replies by editing the same diagram. Your comments, dashed
arrows and styles survive, and you both see the same picture.

## Install

```bash
curl -LsSf https://github.com/Eastsidegunn/mmx/releases/latest/download/mmx-installer.sh | sh   # or: cargo install mmx
mmx init   # Claude Code skill; add --codex for Codex
mmx --version   # serve, wait, note and diff v2 need 0.4.0 or newer
```
If `mmx` is not found afterwards, add `~/.cargo/bin` to your PATH, then run `mmx doctor`.

## Try it

1. Ask your agent: *"Draw our checkout flow as `diagram.mmd` with mmx, then wait for my edits."*
2. Run `mmx serve diagram.mmd` and open the URL it prints.
3. Edit on the picture and press Send. Your agent answers in the diagram.

Works with Claude Code, Codex, or any agent that can run a CLI. Runs locally;
no account, nothing hosted.

## More

- [Guide](GUIDE.md): how a turn works, commands, limitations
- [Install details](INSTALL.md)
- [Embedding the editor](editor/README.md)
- [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [License (MIT)](LICENSE)
