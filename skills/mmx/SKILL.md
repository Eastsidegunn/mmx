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

`--note` is recorded in diff.json and the turn log, and `mmx serve` shows it to the human. If a hook (or `mmx serve`) already rendered the same bytes, this command is a no-op: it writes nothing and records no `by`/`note`. To attach a message anyway, or to reply without editing, use:

```bash
mmx note diagram.mmd "What you want to tell the human"
```

`mmx note` always makes a turn (`--by` defaults to `agent`); unrendered edits in the file become part of it. Exit codes match `mmx render`; it prints nothing on success.

## Waiting for the human

After your turn, wait for the human's reply instead of polling by hand:

```bash
mmx wait diagram.mmd --timeout 300
```

- Exit 0: each printed line is one compact diff JSON of a human turn you have not answered yet (oldest first, same format as diff.json). Respond by editing the diagram and running `mmx render diagram.mmd --by agent --note "..."`, or reply without editing via `mmx note diagram.mmd "..."`. Then call `mmx wait` again.
- Exit 3: nothing yet (timeout). Call it again, or stop. `--timeout 0` checks once.

"Unanswered" means: human turns logged after the last non-human turn. With `mmx serve` running, the human speaks through the browser, and direct file edits are attributed to the agent (serve's poller renders them as `by: agent`). Without serve, `mmx wait` itself renders direct file edits (once the file is stable for two polls) as `by: human` and returns them.

## Turn log

Every committed turn (a successful render or a parse-error turn; never a no-op) appends one line to `<stem>.turns.jsonl`: `{"v":1,"at":<unix ms>,"by":..,"note":..,"source_sha256":..,"diff":{...}}`. When the file exceeds 2 MiB it is rewritten atomically to the newest 200 entries. Unparseable lines are skipped. `mmx serve` uses the log to show turns made by other processes and the full history; `mmx wait` reads it to find unanswered human turns. Do not edit it by hand.

## Read and respond

- `baseline: true` means no usable previous state. Diff sections are intentionally empty, while `stats` describes the first render.
- `source_changed: true` means the text changed even when `nodes` and `edges` are empty. Styles, arrow forms, subgraphs, direction, and comments can fall outside the semantic diff.
- `nodes` and `edges` report added, removed, and changed IDs/keys. A node ID rename appears as removal plus addition. `kind_changed` reports a diagram-type change.
- `moved` reports relative node-center movement after subtracting `stats.global_shift`. `stats.mean_move_px` and `max_move_px` measure the remaining layout movement; mmx reports shifts but does not prevent them.
- `by` says who invoked the render, not a proven author of every edit.
- A turn can carry **no graph changes at all** — empty `nodes`/`edges` with a non-empty `note`. That is the human asking a question or leaving a comment through `mmx serve`; respond to the note (edit the diagram, or answer with `mmx note`), don't dismiss it as a no-op.

See [diff-schema.md](references/diff-schema.md) for all diff and state fields.

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
