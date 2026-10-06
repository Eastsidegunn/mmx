# Changelog

All notable changes to mmx are documented here. This follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.4.0]: https://github.com/Eastsidegunn/mmx/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Eastsidegunn/mmx/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Eastsidegunn/mmx/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Eastsidegunn/mmx/releases/tag/v0.1.0
