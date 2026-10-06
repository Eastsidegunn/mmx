---
name: mmx
description: "Use when a Mermaid .mmd diagram is shared with a human via the mmx CLI — including when DISPLAYING or publishing that diagram (artifact, web page): run mmx render each turn, read diff.json as the human's message, fix exit-2 parse errors, and show only mmx-rendered SVG, never a different mermaid renderer."
---

# mmx diagram conversation

If `mmx` is not on your PATH, install it first: follow `INSTALL.md` at the
repository root (https://github.com/Eastsidegunn/mmx/blob/main/INSTALL.md) —
it tells you how to probe your environment and install user-locally.

The human and agent edit the same `.mmd` file. `mmx render` writes `<stem>.svg`, `<stem>.diff.json`, and `<stem>.state.json`. The diff is the message for one turn; read it to learn what changed. Node IDs are stable names in the conversation.

## Turn routine

At the start of **every** turn, run this before editing the diagram:

```bash
mmx render diagram.mmd --by human --print-if-changed
```

The command prints the exact new diff JSON only for a non-baseline turn it wrote, including an error turn. Baseline and no-op runs print nothing; to tell them apart, check `baseline` in `<stem>.diff.json` — `true` means this was the first render (no previous state), `false` with no printed output means nothing changed. Read printed JSON, or the newly written `<stem>.diff.json` when handling exit 2. Replace `diagram.mmd` with the project's configured path.

Immediately after **every** `.mmd` edit, including shell or script edits that hooks may miss, run:

```bash
mmx render diagram.mmd --by agent --note "Briefly describe the edit and reason" --print-if-changed
```

`--note` is recorded in diff.json for the next reader of the diff, usually the agent. A separate path that displays it to the human is planned for v1. If a hook already rendered the same bytes, this command is a no-op: it writes nothing and does not replace the previous diff or record a new `by`/`note`.

When hooks are installed, notes for Edit/Write edits are not recorded because the hook renders first. A command to add a note is planned for v1.

## Read and respond

- `baseline: true` means no usable previous state. Change sections are empty; `stats` describes the first render.
- Added and removed nodes include their IDs, labels, and shapes. Added and removed edges include keys, endpoints, labels, and styles. Read these entries directly to understand the change; an ID rename appears as removal plus addition.
- `edges.changed` reports labels and solid/dotted/thick style changes. `direction` reports graph direction changes. `subgraphs` reports additions, removals, labels, membership, and direction changes.
- Read `source_hunks` for `classDef`, `style`, comments, and other source details. This is especially important when a non-flowchart warning says node/edge coverage is limited. `source_hunks: null` means there is no known previous source or the text is unchanged; `source_hunks_truncated: true` means only the first 400 hunk lines are present.
- `moved` reports relative node-center movement after subtracting `stats.global_shift`. The mean and max values measure remaining layout movement; mmx reports shifts but does not prevent them.
- `warnings` can flag a non-flowchart diagram, an empty flowchart, or recovery from corrupt/unsupported state. Treat non-flowchart changes through `source_hunks`.
- Quote labels containing brackets or pipes: `A["foo (bar"]`.
- `by` identifies the render caller, not proven edit authorship. A turn can carry no graph change and still contain a human `note`; respond to the note (edit the diagram or answer with your own `--note`).

See [diff-schema.md](references/diff-schema.md) for all diff and state fields.

### Known limitations

Sequence diagram message order is not modeled; changes are visible through `source_hunks` only. Layout positions are not stable across turns; `moved` reports movement but does not prevent it.

## Showing the diagram (one renderer, one picture)

When you display this diagram to the human — in an artifact, a web page, a
report — use the SVG that `mmx render` produced (`<stem>.svg`). Do NOT
re-render the same source with a different mermaid renderer (a native
```mermaid fence, mermaid.js, mermaid-cli): layouts differ between renderers,
so the human would see a different picture than the one this conversation's
diffs and coordinates describe. If the surrounding environment offers native
mermaid rendering, still prefer embedding mmx's SVG.

If the human should EDIT the diagram visually, embed the repo's
`editor/mmx-editor.js` (`<mmx-editor>` web component; zero dependencies):
feed it `{svg, nodes, edges, source}` from the render outputs and handle its
`mmx-submit` event. See `editor/README.md`. For a claude.ai artifact there is
a ready-made shell with the full round trip (shared-db inbox you poll each
turn): publish `adapters/claude-artifact/board.html` as described in
`adapters/claude-artifact/README.md` — do not invent your own transport
before reading it.

## Recover errors

- Exit 0 means a successful render or no-op. No-op leaves all generated files untouched.
- Exit 2 means a repairable parse or UTF-8 encoding error. Read `diff.json.error` (`kind`, `message`, optional `line`, `column`, `candidates`), fix the `.mmd` file, and render again. SVG and state stay at their last valid versions.
- Exit 1 means an I/O, usage, path, or unsupported-format error; inspect stderr.

If the previous state is corrupt or unsupported, mmx backs it up as `<state>.corrupt` after a successful render, starts a baseline, and records a warning in diff.json. This recovery turn prints nothing with `--print-if-changed`; if recovery is suspected, read `<stem>.diff.json` directly for the warning. Do not hand-edit generated state or diff files.

Use idiomatic Mermaid syntax. The strict parser differs from mermaid.js: in a sequence diagram with no participant declarations, it creates participants automatically; once any participant is declared, every participant must be declared. It may accept some text mermaid.js rejects. Exit 0 does not guarantee that a separate Mermaid renderer accepts the source.
