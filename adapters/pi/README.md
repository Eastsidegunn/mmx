# pi-mmx

Sketch with [pi](https://pi.dev/) in the same Mermaid diagram: you edit the
picture in the [mmx](https://github.com/Eastsidegunn/mmx) cockpit (rename,
connect, delete, add a note), pi sees exactly what you changed and answers by
editing the diagram.

```sh
pi install npm:pi-mmx
```

Then in pi: ask for a diagram (*"sketch our deploy flow as flow.mmd"*), run
`/mmx open` to edit it in the browser, and press Send — your change arrives in
pi as the next turn.

What it adds: tools `mmx_render` and `mmx_wait`; commands `/mmx open`,
`/mmx stop`, `/mmx status`; validation of `.mmd` edits made by pi's built-in
`edit`/`write` tools; and delivery of your cockpit edits (new human entries in
`*.turns.jsonl`) to the model as `mmx-turn` messages. pi loads the TypeScript
directly (no build step). From a clone of the mmx repository you can also run
`pi install ./adapters/pi`.

The package also declares the same entry under `omp.extensions` for
oh-my-pi; omp support is manifest-only and untested.

Requirements:

- `mmx` 0.4.0 or newer on `PATH` (the extension checks this at session start)
- pi 0.82 or newer, with the usual `typebox` peer supplied by pi

If mmx is missing or too old, install it using the mmx repository's
[`INSTALL.md`](https://github.com/Eastsidegunn/mmx/blob/main/INSTALL.md); the extension keeps built-in tools usable and
re-checks availability when an mmx feature is used.

The short pi skill in `skills/mmx-pi/SKILL.md` teaches the render/note loop. For
the full diff schema and generated-file rules, read mmx's own
`skills/mmx/SKILL.md`.

## Tools and commands

- `mmx_render({path, note?})` runs `mmx render <path> --by agent
  [--note ...] --print-if-changed`. Use it after every `.mmd` edit, with a note
  explaining what changed and why. The edit/write hook validates a temporary
  copy and never commits a turn; `mmx_render` reports whether it recorded a
  baseline, recorded a noted turn, or was a true no-op. Parse errors include
  the kind, message, line, and column.
- `mmx_wait({path, timeoutSeconds?})` waits for unanswered human turns and
  honors pi's abort signal. If the edit/write hook validated an unsent agent
  change, it refuses until `mmx_render` records that change; direct human file
  edits remain eligible to be returned.
- `/mmx open [path]` starts one local `mmx serve` per diagram and opens its
  loopback URL; `/mmx stop [path]` stops it; `/mmx status` lists tracked
  diagrams and URLs. If `path` is omitted, a sole `.mmd` in the cwd is chosen;
  multiple candidates are listed.

To watch diagrams at startup, optionally add `.pi/mmx.json`:

```json
{"diagrams": ["docs/architecture.mmd"]}
```

Human entries are read only after the current end of each log, so history is
not replayed. Entries are coalesced for about one second; each is delivered to
the model once by the watcher, while `mmx_wait` shows the human's unanswered
turns (calling `mmx_wait` after watcher delivery can show that turn again by
design). At most three consecutive automatic follow-up turns are
triggered; subsequent turns are delivered as `nextTurn` and a warning is shown
until a real interactive/RPC prompt resets the cap. Only log entries with
`by: "human"` trigger the agent; agent and serve entries never do.

`/mmx stop [path]` stops both the serve process and that diagram's background
watcher. `/mmx open [path]` starts watching again. If pi crashes, an orphaned
`mmx serve` process may remain; it is harmless and can be stopped manually.

All processes, files, and browser URLs are local. No diagram contents or
telemetry are sent to a remote service by this package. The test suite uses
the real `mmx` binary for diagram operations and makes no model calls. Real
`mmx serve` cases use a bindable port when available and fall back to a stub
where the environment cannot bind one. Run it here with
`node --experimental-strip-types --test adapters/pi/test/index.test.mjs` (this
machine has Node `v26.5.0`).

The documented `omp` manifest entry is included for discovery but has not been
tested because omp is not installed in this repository's environment.
