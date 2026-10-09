# Changelog

All notable changes to mmx are documented here. This follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.3] - 2026-10-10

### Added

- The cockpit opens with a one-line banner above the picture: what Send means and the reading order (yellow box, colored boxes, pink decisions, gray finished decisions), plus the first line of the agent's latest note. It collapses to one short line after you send a turn and expands again when the agent answers. Translated for all five cockpit languages.
- `stats.crossings` in `diff.json` (and `crossings` in state): the number of edge pairs whose routed lines cross. `mmx render --layout-search <N>` tries up to N (max 500) deterministic reorderings of a flowchart's top-level node declaration lines and edge lines, keeps the one with the fewest crossings that still parses to the same graph, writes it back to the `.mmd` before the turn, and prints `layout: crossings <before> -> <after> (searched N, node and edge order)`; with a numeric `linkStyle` or a `~~~` link only node declarations move (`node order only`); pictures with subgraphs, a non-flowchart header, a duplicate declaration, a multi-line label or an `accTitle`/`accDescr` print `layout: search skipped (<reason>)` and are left untouched. The file's dominant line ending (LF or CRLF) and a missing final newline are preserved.
- `adapters/codemap`: a skill for explaining a code change as one picture in four layers—topic, the code involved at function level with one line each, how each unit changes, and the human's open decisions—with the first screen saying what the human must do and what Send means, every edge anchored to a `path:line@commit`, Korean labels by default, and a worked example of an mmx commit in English and Korean. `codemap.py` (standard library only) selects candidates for the code layer; `example/index_rust.py` is a small Rust indexer; the skill documents the `graph.v2` facts an index should supply.

### Fixed

- A panic inside the renderer is now exit 1 from the CLI with `renderer failed on this input; the file was not changed` and the panic message, instead of exit 101; `mmx serve` renders a submitted turn before writing the `.mmd`, so a failed turn leaves the file and the state untouched and is answered with its normal error response (which advises restarting serve, since the renderer may be left degraded). The wasm build is unaffected: there a panic still aborts.

## [0.4.2] - 2026-10-08

### Added

- `pi-mmx` (`adapters/pi`), an extension for the pi coding agent: tools `mmx_render` and `mmx_wait`, `/mmx open|stop|status`, validation of `.mmd` edits, and delivery of the human's cockpit edits to pi as the next turn (with a loop guard). Install with `pi install npm:pi-mmx` once published, or `pi install ./adapters/pi` from a clone.
- `adapters/tiro`: an agent skill that turns a finished Tiro meeting note into picture minutes the human corrects in the cockpit (draft, with a synthetic example).

### Fixed

- `mmx doctor` now requires the Codex skill whenever project hooks reference the mmx runner, even if `~/.codex` is missing.

### Documentation

- Documented the `mmx serve` HTTP API and corrected the wasm loader input-error behavior in `wasm/README.md`.

## [0.4.1] - 2026-10-06

### Added

- `mmx-wasm.js`, a dependency-free loader for `mmx_wasm.wasm` (WASI shim included), shipped as a release asset and documented in `wasm/README.md` with the ABI and request/response JSON. The wasm module gains `wasm_free`, so hosts no longer leak the request buffer.

### Fixed

- Repeated `mmx note` messages over unchanged bytes are deduplicated (a retry over an error turn still reports the error).
- A parse error on a first render is printed by `--print-if-changed` again, so hooks deliver it to the agent.
- Parse errors on a first or otherwise unusable baseline are marked as baseline turns and remain visible to `mmx wait`.
- `mmx doctor` validates hook runner paths and gives an appropriate warning for an unused missing Codex skill.

### Changed

- `mmx init` reports identical files as unchanged and the onboarding/artifact defaults are English.
- Docs: where to get `mmx-editor.js`, that a human turn can be an error turn the agent fixes, that a leftover `.serve.json` is harmless, and a PATH hint after install.

## [0.4.0] - 2026-10-06

### Added

- `mmx doctor [diagram.mmd]` checks installation, hooks, rendering, and turn status without changing project files.
- `mmx init --codex [--hooks diagram.mmd]` installs the Codex skill and optional project hooks.
- `mmx serve` opens a local browser cockpit for editing an agent's rendered Mermaid diagram. The editor supports stable dragging, double-click rename, fit view, a toolbar, and note-only turns.
- `mmx wait` blocks for the human's next turn and prints it; `mmx note` sends a message as a turn. A persistent turn log and full history in the cockpit keep the conversation visible.
- The cockpit speaks English by default and Korean, Simplified Chinese, Japanese and Spanish via `?lang=ko|zh-CN|ja|es` or the browser locale. Before sending, it shows what the turn carries (nodes added, connections, renames, deletions).
- README translations (Korean, Simplified Chinese, Japanese, Spanish), a step-by-step `AGENTS.md` for AI agents, `GUIDE.md`, `llms.txt`, and a reproducible demo (`examples/demo/`).
- Diff format v2 includes rich node and edge entries, edge style and direction, subgraphs, source hunks, and lint diagnostics with exact positions (missing header, unclosed brackets, an arrow with no target). Lint errors exit with status 2. State format v2 can read v1 state.

### Changed

- Browser edits patch the Mermaid source instead of regenerating it, preserving comments, dashed arrows, and subgraphs where the source can be patched directly.
- **Breaking:** `nodes.added`, `nodes.removed`, `edges.added`, and `edges.removed` contain objects instead of strings, and `mmx_diff_version` is now `2`. Consumers of `diff.json` must update their parsers.
- A non-empty `--note` always makes a turn: if a hook or `mmx serve` already rendered the same bytes, the note arrives as a note-only turn instead of being dropped.
- `mmx init --hooks` puts the hook runner in `.mmx/mmx_hook.py` instead of a top-level `adapters/` directory, writes hook configs as JSON with a shell-quoted diagram path (paths with spaces work), and re-running it updates its own config instead of asking for a manual merge.

### Fixed

- Connecting a freshly added node by dragging the handle onto it created no edge.
- `mmx serve` answered 404 for the page when a query string was present.

## [0.3.0] - 2026-10-02

### Added

- `mmx init` installs the agent skill after any installation method, with optional Claude Code hooks.

## [0.2.0] - 2026-10-02

### Added

- Prebuilt release downloads and shell and npm installers for macOS, Linux, and Windows.
- The embeddable `<mmx-editor>` web component, with in-place node and edge editing, pan and zoom, and shape-aware edge placement.
- A WASM build for a full browser-side render, diff, and state turn.
- A ready artifact-board adapter and view-layer guidance for agent integrations.

## [0.1.0] - 2026-09-29

### Added

- Initial `mmx render` workflow: render Mermaid to SVG, emit a per-turn `diff.json` and comparison `state.json`, and report parse or encoding errors with exit status 2.
- Agent skill, installation guide, hook examples, and sample diagrams.

[0.4.3]: https://github.com/Eastsidegunn/mmx/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/Eastsidegunn/mmx/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/Eastsidegunn/mmx/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Eastsidegunn/mmx/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Eastsidegunn/mmx/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Eastsidegunn/mmx/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Eastsidegunn/mmx/releases/tag/v0.1.0
