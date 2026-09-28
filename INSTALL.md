# Installing mmx

This guide is written for an AI agent (or a human) that needs `mmx` working in
its current environment. Probe your environment in the order below, take the
first path that applies, then verify. Every path installs user-locally: no
`sudo`, no system directories.

## Step 0: is it already installed?

```bash
mmx --version
```

If this prints a version, stop here and read `skills/mmx/SKILL.md` for the turn
routine. If the command is not found, continue.

## Step 1: probe your environment

Run these and note the results:

```bash
command -v cargo        # Rust toolchain present?
command -v rustup       # Rust installer present?
echo "$PATH"            # where can you place a binary?
```

## Step 2: install by the first path that applies

### Path A — Rust toolchain already present (`cargo` found)

```bash
git clone https://github.com/Eastsidegunn/mmx.git /tmp/mmx-src
cargo install --path /tmp/mmx-src --locked
```

This compiles from source (a few minutes) and installs to `~/.cargo/bin/mmx`.

### Path B — no Rust toolchain, but network access and ~1 GB disk

Install Rust user-locally, non-interactively, then follow Path A:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
. "$HOME/.cargo/env"
```

### Path C — a prebuilt `mmx` binary is available to you

If your environment already provides an `mmx` binary (a project checkout with
`target/release/mmx`, a shared tools directory, or a file the user gave you),
place it on `PATH` yourself (see Step 3) instead of compiling. Verify it runs
before relying on it.

### No path applies

If you have no Rust, no network, and no binary, you cannot install mmx.
Say so to your user; do not attempt system package managers or `sudo`.
(Prebuilt release downloads and an npm wrapper are planned; when they exist
they will be listed above Path A.)

## Step 3: make sure `mmx` is on PATH

`cargo install` places the binary in `~/.cargo/bin`, which is not always on
`PATH`. Check, then fix with whichever works in your environment:

```bash
command -v mmx || export PATH="$HOME/.cargo/bin:$PATH"          # this session
command -v mmx || ln -sf ~/.cargo/bin/mmx ~/.local/bin/mmx      # if ~/.local/bin is on PATH
```

Hooks and skills invoke `mmx` by bare name, so a session-only `export` is not
enough if a hook runs in a fresh shell; prefer the symlink or add the export to
the shell profile the harness actually uses.

## Step 4: verify

```bash
cd "$(mktemp -d)"
printf 'flowchart LR\n    A[start] --> B[done]\n' > check.mmd
mmx render check.mmd --by agent && echo OK-RENDER
printf 'notadiagram\n' > broken.mmd
mmx render broken.mmd --by agent; [ $? -eq 2 ] && echo OK-EXIT2
```

Both `OK-RENDER` and `OK-EXIT2` must print. `OK-RENDER` proves rendering and
the three output files work; `OK-EXIT2` proves the repairable-error signal
(exit 2) works. If verification fails, report the exact output to your user
instead of proceeding.

## Step 5: use it

- Turn routine, diff reading, and error recovery: `skills/mmx/SKILL.md`
- Full diff.json / state.json field reference: `skills/mmx/references/diff-schema.md`
- Hook configurations for Claude Code and Codex CLI: `adapters/`
- No hooks in your harness? Follow `adapters/AGENTS.md`.

The one-line summary of usage: render with `--by human --print-if-changed` at
the start of every turn, edit the diagram, render with `--by agent --note
"what and why"` after every edit, and treat exit 2 as an instruction to fix
the diagram and render again.
