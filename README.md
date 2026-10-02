# mmx

mmx is a Rust CLI for a human and an AI agent to converse by editing the same Mermaid `.mmd` diagram. Each `mmx render` produces an SVG, a one-turn `diff.json`, and comparison `state.json`. The agent can read the diff to see what changed without re-reading the whole diagram.

## Install

```bash
curl -LsSf https://github.com/Eastsidegunn/mmx/releases/latest/download/mmx-installer.sh | sh
```

Prebuilt binaries for macOS, Linux and Windows. Building from source works
too: `cargo install --path .` (or `cargo install mmx` from crates.io).

The web pieces are release assets with stable URLs:
`releases/latest/download/mmx-editor.js` (the `<mmx-editor>` component) and
`releases/latest/download/mmx_wasm.wasm` (the full mmx turn for browsers).

Setting up in a different environment, or letting an agent install it for itself? See [INSTALL.md](INSTALL.md).

The CLI uses the pinned `mermaid-rs-renderer` dependency. Keep `mmx` on `PATH` when using hooks.

## One turn

```bash
mmx render examples/diagram.mmd --by human --print-if-changed
# Edit examples/diagram.mmd.
mmx render examples/diagram.mmd --by agent --note "Updated the delivery step" --print-if-changed
```

Every successful render that detects a change writes the SVG, diff JSON, and state JSON alongside the diagram. The first render writes all three files as a baseline and prints nothing with `--print-if-changed`. The next changed render writes all three and prints the diff. A repeated render of unchanged bytes does nothing. Exit 2 writes a repairable parse/encoding error into the diff; fix the source and render again. When hooks are installed, notes for Edit/Write edits are not recorded: the hook renders first, so the agent's render with `--note` is a no-op. A command to add a note is planned for v1.

## Integration

`skills/mmx/` explains the turn routine and JSON schema. `adapters/claude/settings.json` and `adapters/codex/hooks.json` are opt-in hook examples; `adapters/mmx_hook.py` is their shared runner. Copy a hook file to your project's harness settings location and change its UserPromptSubmit `--diagram diagram.mmd` argument to that project's diagram path. The Claude example belongs at `.claude/settings.json` and uses `CLAUDE_PROJECT_DIR` to find the runner. The Codex example belongs at `.codex/hooks.json`; set its runner command to an absolute path as described in `adapters/codex/README.md`. `adapters/AGENTS.md` gives the same routine for harnesses without hooks. `examples/` contains a starting diagram. `editor/` holds mmx-editor, a dependency-free embeddable component for editing the rendered diagram in place (see `editor/README.md`).
