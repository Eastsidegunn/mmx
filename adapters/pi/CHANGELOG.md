# Changelog

All notable changes to `pi-mmx`.

## 0.2.0

- Turn-start injection: before a run started by a prompt, unanswered human
  turns of every tracked diagram are collected (`mmx wait <path> --timeout 0`,
  which renders a direct file edit as the human's turn when `mmx serve` is not
  running) and injected as one `mmx-turn` message. For diagrams in
  `.pi/mmx.json` (or tracked again), turns made while pi was closed are
  answered on the next prompt. Configurable with `"injectAtStart"`.
- Unsent agent edits are remembered by content in `.mmx/pi-pending.json`
  (per directory; each entry records its owning pi process), so they are not
  recorded as the human's turn, also across `/new`, `/resume`, `/reload` and
  restarts, and several pi processes in one project keep to their own edits.
  Changes to a tracked diagram made by `bash`, or by a tool whose input names
  a diagram, are detected per tool call and treated like `edit`/`write`
  edits. Exceptions (direct file edits without `mmx serve` while an agent
  edit is pending or a tool call runs) are listed in the README.
- End-of-run send: when a run settles, an unsent agent edit is recorded as one
  agent turn with an automatic note (`pi edited this diagram (automatic
  turn): …`); the same happens when the session closes between runs (closing
  mid-run holds the edit instead). An edit that does not
  parse is not sent: the UI shows the line and column and the model is
  reminded at its next turn, at every settle while it stays broken. After a
  stopped or failed run nothing is sent until the model sends it or you run
  the new `/mmx send`. Configurable with `"autoRender"`.
- New tool `mmx_note({path, text})` to reply without editing the diagram.
- Within a session, each human turn is delivered to the model once, by the
  idle watcher or by turn-start injection; turns returned by `mmx_wait` are
  not injected again. `mmx_wait` itself still returns every unanswered turn.
  A new or resumed session can inject an unanswered turn again.
- The watcher recovers human turns appended while mmx compacts the log.
- Diagrams used with `edit`/`write`, `mmx_note` or `mmx_wait` are tracked.
- Tool descriptions and prompt guidelines teach the routine without a skill.
- Skills: `mmx` and `mmx-codemap` are now derived from the canonical mmx
  skills by `scripts/derive-skills.mjs` (tool calls instead of shell
  commands), with a test that fails when they drift. The short `mmx-pi`
  skill is removed.
- README: install and first-picture walkthrough, examples, what is automatic.

## 0.1.0

- First release: tools `mmx_render` and `mmx_wait`; commands `/mmx open`,
  `/mmx stop`, `/mmx status`; validation of `.mmd` edits made by pi's
  `edit`/`write` tools in a temporary copy; delivery of the human's cockpit
  edits as `mmx-turn` messages with a loop guard of three automatic runs.
