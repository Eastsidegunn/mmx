# pi-mmx

Sketch with [pi](https://pi.dev/) in the same Mermaid diagram: you edit the
picture in the [mmx](https://github.com/Eastsidegunn/mmx) cockpit (rename,
connect, delete, add a note), pi sees exactly what you changed and answers by
editing the diagram.

## Install (1 minute)

1. Install `mmx` 0.4.0 or newer so that `mmx --version` works in a fresh
   shell:

   ```sh
   curl -LsSf https://github.com/Eastsidegunn/mmx/releases/latest/download/mmx-installer.sh | sh
   # or, with a Rust toolchain:
   cargo install mmx
   ```

   No network or no Rust? See the mmx repository's
   [`INSTALL.md`](https://github.com/Eastsidegunn/mmx/blob/main/INSTALL.md).
2. Install the pi package:

   ```sh
   pi install npm:pi-mmx
   ```

   From a clone of the mmx repository you can use `pi install ./adapters/pi`
   instead.

Requirements: pi 0.82 or newer (it supplies the `typebox` peer). The extension
checks `mmx` at session start; if it is missing or too old, pi's built-in tools
keep working and the mmx tools say what to install.

## First picture (5 minutes)

1. In a project, start pi and ask:

   > Sketch how a signup request flows through our backend as `signup.mmd`
   > (a Mermaid flowchart, left to right). Send it to me with a note.

   pi writes `signup.mmd`, the extension validates it, and pi calls
   `mmx_render` with a note. `signup.svg`, `signup.diff.json`,
   `signup.state.json` and `signup.turns.jsonl` appear next to it.
2. Run `/mmx open signup.mmd` (or just `/mmx open` when it is the only
   `.mmd` in the directory). Your browser opens the local cockpit with pi's
   note.
3. Edit the picture: rename a box, draw a missing arrow, delete a step, or
   type a question in the note field.
4. Press **Send**. Your change arrives in pi as an `mmx-turn` message and pi
   starts answering on its own: it edits the diagram and sends it back with a
   note, which shows up in the cockpit.

## Examples

**Meeting sketch.** "Draw the release process we just discussed as
`release.mmd`, then open it for me." During the meeting you fix the picture
in the cockpit (move the approval before the build, rename "QA" to
"Staging check", add a note "who signs off?"). Each Send is one turn: pi
reads exactly what you changed and answers in the picture or with a note
(`mmx_note`).

**Code change with the `mmx-codemap` skill.** After a change, ask:
"/skill:mmx-codemap explain this branch's change as `change.mmd`". pi draws
one picture: the topic, the functions involved with one line each, how each
changed, and the decisions it needs from you. You answer a decision by
editing its box and pressing Send; pi updates the picture and records the
decision.

## What is automatic and what the model does

Automatic (the extension, no model involvement):

- **Validation.** When pi's built-in `edit` or `write` tool changes a `.mmd`
  file, the extension renders a temporary copy and appends the result
  (pending change, or the parse error with line and column) to the tool
  result. Validation never records a turn. When `bash`, or another tool
  whose input mentions a `.mmd` file or a tracked diagram, changes a tracked
  diagram, the same check is appended to that tool's result and the change
  counts as the agent's edit. Other tools are not checked.
- **Tracking.** A diagram is tracked once it is listed in `.pi/mmx.json`,
  opened with `/mmx open`, used with `mmx_render`, `mmx_note` or `mmx_wait`,
  or edited with `edit`/`write`. Tracking lasts for the session; a new
  session tracks the configured diagrams and any diagram with an unsent agent
  edit again.
- **Your turns at prompt start.** Before a run started by your prompt, the
  extension runs `mmx wait <path> --timeout 0` for each tracked diagram (at
  most 8) and injects the human's unanswered turns (human turns after the
  last non-human turn) as one `mmx-turn` message. Without `mmx serve`
  running, this renders a direct edit of the file as your turn. For diagrams
  in `.pi/mmx.json` (or tracked again in the new session) this includes
  turns made while pi was closed: they are answered on your next prompt.
  Runs started automatically by the watcher do not do this (pi emits
  `before_agent_start` only for prompts); the watcher delivers those turns.
- **Agent edits are not your turns.** Unsent agent edits are remembered as
  the exact bytes the agent left (in `.mmx/pi-pending.json`, so they survive
  `/new`, `/resume`, `/reload` and restarts). While a diagram still holds
  those bytes, no `mmx wait` runs for it and nothing is injected. Each entry
  records which pi process owns it: several pi processes in one project keep
  to their own entries, and a new session takes over only entries whose
  owner has exited. A diagram with an unsent edit of another running pi is
  skipped too. The file is per directory, so start pi from the same
  directory each time, and add `.mmx/pi-pending.json` to your `.gitignore`
  (it holds absolute paths). If the file
  changes again after the agent's edit, the new bytes are treated as yours.
  Two cases remain, both only for direct edits of the file without
  `mmx serve`: a change you make while one of the agent's tool calls is
  running is counted as the agent's (and sent as the agent's), and a change
  you make after an unsent agent edit makes the whole file, the agent's
  unsent change included, your turn at the next prompt. Edit in the cockpit
  (`/mmx open`) to avoid both. A change made by a tool the extension does not
  check (see Validation) looks like a direct edit.
- **Your turns while pi is idle.** New human entries in a tracked
  diagram's `*.turns.jsonl` are coalesced for about a second and delivered
  as an `mmx-turn` follow-up that starts a run. At most three automatic runs
  in a row are started; after that, turns are queued for your next prompt
  and a warning is shown. Only entries with `by: "human"` trigger anything;
  agent and serve entries never do. When mmx compacts a large log, the
  watcher re-reads it and still delivers undelivered human turns.
- **Delivered once.** Within a session, each human turn is delivered to the
  model once, by the watcher or by prompt-start injection, whichever comes
  first; turns `mmx_wait` returned are not injected again. `mmx_wait` itself
  returns every unanswered turn each time it is called. A new session
  (including `/resume`) starts with an empty record, so an unanswered turn
  already present in a resumed conversation is injected again.
- **End-of-run send.** When a run settles (pi's `agent_settled`), an edit the
  model left unsent is sent with
  `mmx render --by agent --note "pi edited this diagram (automatic turn): …"`.
  Several edits in one run become one turn. If the file does not parse,
  nothing is sent: you get a notification with the line and column, and the
  model gets a reminder at its next turn ("if the file still fails to
  parse, fix it"); this repeats at every settle while the broken bytes are
  pending. If the run was stopped (Esc) or ended with a provider error,
  nothing is sent and you are told; the edit stays pending until the model
  sends it, it is edited again, or you run `/mmx send`.
- **Session end.** When pi closes the session (quit, `/new`, `/resume`,
  `/reload`) between runs, unsent edits that parse are sent the same way;
  broken and stopped ones stay pending for the next session. Closing in the
  middle of a run sends nothing: the partial edit is held like a stopped one.
- **With `/mmx open`.** While `mmx serve` runs, its poller records every
  change to the file, including the agent's edits, as its own agent turn
  without a note. A following `mmx_render` with a note then adds a
  note-only turn; the end-of-run send has nothing left to send.

What the model does (the tools teach this even without a skill loaded):

- `mmx_render({path, note?})` sends its edit as one turn with a note saying
  what changed and why. It reports a baseline, a recorded turn, or a true
  no-op; parse errors come back with kind, message, line and column. A note
  written by the model always beats the automatic one.
- `mmx_note({path, text})` replies without editing (an answer, a question).
  It always makes a turn; unsent edits in the file become part of it.
- `mmx_wait({path, timeoutSeconds?})` blocks inside a run for your reply and
  honors pi's abort signal. It refuses while the model has an unsent edit.
- It suggests `/mmx open <path>` when you should look at or edit the picture.

Commands: `/mmx open [path]` starts one local `mmx serve` per diagram and
opens its loopback URL; `/mmx stop [path]` stops the serve and that
diagram's watcher; `/mmx send [path]` sends pending agent edits with the
automatic note (including ones held after a stopped run); `/mmx status`
lists tracked diagrams, URLs and unsent edits. Without a path, `open` picks
a sole `.mmd` in the cwd; multiple candidates are listed. If pi crashes, an
orphaned `mmx serve` may remain; it is harmless and can be stopped by hand.

Skills: the package ships `mmx` (the full diagram-conversation contract) and
`mmx-codemap` (a code change as one picture). Both are derived from the
canonical skills in the mmx repository by `scripts/derive-skills.mjs`, which
replaces the shell routine with the tools above; a test fails when the
copies drift.

## Config

Optional `.pi/mmx.json` in the project (read only when the project is
trusted):

```json
{
  "diagrams": ["docs/architecture.mmd"],
  "injectAtStart": true,
  "autoRender": true
}
```

- `diagrams`: watched from session start (history is not replayed by the
  watcher).
- `injectAtStart` (default `true`): inject unanswered human turns before each
  run. With `false`, only the idle watcher and `mmx_wait` deliver turns.
- `autoRender` (default `true`): send unsent agent edits when a run settles
  and when the session closes. With `false`, an edit stays pending (also
  across sessions) until the model calls `mmx_render` or `mmx_note`, or you
  run `/mmx send`.

## Privacy

Everything is local. The extension runs the `mmx` binary, reads and writes
files next to your diagrams and `.mmx/pi-pending.json` in the project, and
serves the cockpit on a loopback address. No diagram contents or telemetry are sent anywhere by this package; what pi
sends to its model provider is the `mmx-turn` text and tool results, as with
any other tool.

## Development

```sh
npm test                 # node --experimental-strip-types --test test/index.test.mjs
npm run derive-skills    # regenerate skills/ from the canonical mmx skills
npm run check-skills     # exit 1 if skills/ is out of date
```

The tests use the real `mmx` binary and make no model calls. Real
`mmx serve` cases use a bindable port when available and fall back to a stub
otherwise. The package also declares its entry under `omp.extensions` for
oh-my-pi; omp support is manifest-only and untested.
