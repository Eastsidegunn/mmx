---
name: mmx
description: "Use when a Mermaid .mmd diagram is shared with a human via the mmx CLI: run mmx render each turn, read diff.json as the human's message, fix exit-2 parse errors."
---

# mmx diagram conversation

The human and agent edit the same `.mmd` file. `mmx render` writes `<stem>.svg`, `<stem>.diff.json`, and `<stem>.state.json`. The diff is the message for one turn; read it to learn what changed. Node IDs are stable names in the conversation.

## Turn routine

At the start of **every** turn, run this before editing the diagram:

```bash
mmx render diagram.mmd --by human --print-if-changed
```

The command prints the exact new diff JSON only for a non-baseline turn it wrote, including an error turn. Baseline and no-op runs print nothing. Read printed JSON, or the newly written `<stem>.diff.json` when handling exit 2. Replace `diagram.mmd` with the project's configured path.

Immediately after **every** `.mmd` edit, including shell or script edits that hooks may miss, run:

```bash
mmx render diagram.mmd --by agent --note "Briefly describe the edit and reason" --print-if-changed
```

`--note` is recorded in diff.json for the next reader of the diff, usually the agent. A separate path that displays it to the human is planned for v1. If a hook already rendered the same bytes, this command is a no-op: it writes nothing and does not replace the previous diff or record a new `by`/`note`.

When hooks are installed, notes for Edit/Write edits are not recorded because the hook renders first. A command to add a note is planned for v1.

## Read and respond

- `baseline: true` means no usable previous state. Diff sections are intentionally empty, while `stats` describes the first render.
- `source_changed: true` means the text changed even when `nodes` and `edges` are empty. Styles, arrow forms, subgraphs, direction, and comments can fall outside the semantic diff.
- `nodes` and `edges` report added, removed, and changed IDs/keys. A node ID rename appears as removal plus addition. `kind_changed` reports a diagram-type change.
- `moved` reports relative node-center movement after subtracting `stats.global_shift`. `stats.mean_move_px` and `max_move_px` measure the remaining layout movement; mmx reports shifts but does not prevent them.
- `by` says who invoked the render, not a proven author of every edit.

See [diff-schema.md](references/diff-schema.md) for all diff and state fields.

## Recover errors

- Exit 0 means a successful render or no-op. No-op leaves all generated files untouched.
- Exit 2 means a repairable parse or UTF-8 encoding error. Read `diff.json.error` (`kind`, `message`, optional `line`, `column`, `candidates`), fix the `.mmd` file, and render again. SVG and state stay at their last valid versions.
- Exit 1 means an I/O, usage, path, or unsupported-format error; inspect stderr.

If the previous state is corrupt or unsupported, mmx backs it up as `<state>.corrupt` after a successful render, starts a baseline, and records a warning in diff.json. This recovery turn prints nothing with `--print-if-changed`; if recovery is suspected, read `<stem>.diff.json` directly for the warning. Do not hand-edit generated state or diff files.

Use idiomatic Mermaid syntax. The strict parser differs from mermaid.js: in a sequence diagram with no participant declarations, it creates participants automatically; once any participant is declared, every participant must be declared. It may accept some text mermaid.js rejects. Exit 0 does not guarantee that a separate Mermaid renderer accepts the source.
