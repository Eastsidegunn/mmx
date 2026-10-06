# AGENTS.md: using mmx as an AI agent

mmx lets a human edit your Mermaid diagram directly on the rendered picture
and hands you exactly what they changed. This file is the mechanical setup and
loop, written for an AI agent starting from a clean machine. Follow the steps
in order.

Contributing to mmx itself (working on this repository's code)? See
[CONTRIBUTING.md](CONTRIBUTING.md); the steps below are for *using* mmx and do
not change how you work on this codebase.

## 0. Prerequisites

- A POSIX shell (or PowerShell on Windows) where you can run commands.
- Either network access for the prebuilt installer, or a Rust toolchain
  (`cargo`).
- `python3`, only if you want hooks (`--hooks`).
- `mmx` must resolve on `PATH` from a **fresh** shell, because hooks and skills
  call it by bare name. A session-only `export PATH=...` is not enough.

## 1. Install

If `mmx --version` already prints **0.4.0 or newer**, skip to step 2.
`serve`, `wait`, `note`, `doctor` and diff format v2 do not exist in older
versions; an older `mmx` must be upgraded with one of the commands below.
Otherwise use one of:

```bash
curl -LsSf https://github.com/Eastsidegunn/mmx/releases/latest/download/mmx-installer.sh | sh
# or, with a Rust toolchain:
cargo install mmx
```

Both install to `$CARGO_HOME/bin` (default `~/.cargo/bin`). If the commands fail, or you need to probe
the environment (no network, no Rust, no write access to `~/.cargo`, PATH
problems), follow [INSTALL.md](INSTALL.md). Never use `sudo` or system
package managers.

## 2. Install the skill

```bash
mmx init            # Claude Code: skill in ~/.claude/skills/mmx
mmx init --codex    # also Codex: skill in ~/.codex/skills/mmx
```

## 3. Check

```bash
mmx doctor <diagram.mmd>
```

Exit 0 means the installation, hooks and diagram are fine. Exit 1 means it
found problems: fix each one it reports and run it again. Until the diagram
exists (step 4), omit the argument to check only the installation.

## 4. Connect a project

1. Create or choose the diagram file, e.g. `diagram.mmd`. Use idiomatic
   Mermaid with a header line (`flowchart LR`). Flowcharts are fully
   supported; other kinds get a partial diff.
2. Make the first turn:

   ```bash
   mmx render diagram.mmd --by agent --note "First draft: what it shows"
   ```

3. Tell the human to run, in their own terminal:

   ```bash
   mmx serve diagram.mmd
   ```

   and open the URL it prints. The human runs serve; you never need to.

4. Optional, once the diagram exists: render every `.mmd` edit automatically
   with hooks, then check again:

   ```bash
   mmx init --hooks diagram.mmd            # Claude Code hooks
   mmx init --codex --hooks diagram.mmd    # Codex hooks as well
   mmx doctor diagram.mmd
   ```

   The hook runner goes to `.mmx/mmx_hook.py` in the project and needs
   `python3`. Hooks load when a session starts; tell the human to restart the
   session (Codex also asks the human to trust the hooks via `/hooks`).
   Re-running `mmx init --hooks` updates its own settings; a settings file
   with other content gets a side file and a manual-merge instruction.

## 5. The conversation loop

```bash
mmx wait diagram.mmd --timeout 300
```

- **Exit 0**: each printed line is one human turn you have not answered,
  oldest first, as compact diff v2 JSON. Read `note` (their message) and the
  changes: `nodes`, `edges`, `subgraphs`, `direction`, `source_hunks`. Field
  reference: [skills/mmx/references/diff-schema.md](skills/mmx/references/diff-schema.md).
  A turn with a note and no changes is a question; answer it.
- Respond by editing the `.mmd` file, then:

  ```bash
  mmx render diagram.mmd --by agent --note "What you changed and why"
  ```

  or reply without editing:

  ```bash
  mmx note diagram.mmd "Your answer"
  ```

  Then run `mmx wait` again.
- **Exit 3**: nothing yet (timeout). Run `mmx wait` again, or stop.
- **Exit 2 from `render` or `note`**: the diagram has a syntax error. Read
  `error` in `diagram.diff.json` (`message`, `line`, `column`), fix the `.mmd`,
  and render again. Quote labels that contain brackets or pipes:
  `A["Charge (Stripe)"]`.
- **Exit 1**: I/O or usage problem; read stderr.

A non-empty `--note` always makes a turn, even if a hook or serve already
rendered your edit. Repeating the identical note on unchanged bytes does
nothing.

## 6. Rules

- **One renderer.** When you show the diagram (artifact, web page, report),
  use the SVG mmx produced (`diagram.svg`). Never re-render the source with
  another Mermaid engine (mermaid.js, mermaid-cli, a native ```mermaid
  block): its layout differs from the picture the human edits.
- **Never edit generated files**: `.svg`, `.diff.json`, `.state.json`,
  `.turns.jsonl`, `.serve.json`. Edit only the `.mmd`.
- **Attribution**: while `mmx serve` runs, any direct edit to the file
  (yours) is recorded as `by: agent`. The human speaks through the browser.
- Layout can move between turns; `moved` and `stats` report it. Do not treat
  movement as a human edit.

## 7. Reference

- [skills/mmx/SKILL.md](skills/mmx/SKILL.md): the full agent contract
  (installed by `mmx init`).
- [skills/mmx/references/diff-schema.md](skills/mmx/references/diff-schema.md):
  every diff and state field.
- [adapters/AGENTS.md](adapters/AGENTS.md): the routine as two paragraphs to
  paste into a project's own instructions (Codex and harnesses without hooks).
- [INSTALL.md](INSTALL.md): environment probing and every install path.
