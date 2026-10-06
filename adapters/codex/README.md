# Codex CLI adapter

From the project directory, run `mmx init --codex --hooks <diagram.mmd>`, then run `/hooks` in Codex and trust this project's hooks. Run `mmx doctor <diagram.mmd>` to verify setup. The command installs the skill in `~/.codex/skills/mmx/`, copies the hook runner, and writes `.codex/hooks.json` with an absolute hook script path. If `.codex/hooks.json` exists, merge the hooks from the generated `.codex/hooks.mmx.json` sidecar.

Manual fallback: copy this example `hooks.json` to a trusted project's `.codex/hooks.json`, replace `adapters/mmx_hook.py` with the absolute path of the project's copy (`.mmx/mmx_hook.py`), and replace `diagram.mmd` with the project's diagram path. Review and trust the hooks with `/hooks`. [Official Hooks guide](https://developers.openai.com/codex/hooks).

`mmx init --hooks` puts the hook runner at `.mmx/mmx_hook.py` in the project (copy `adapters/mmx_hook.py` there when wiring by hand) and expects `mmx` on `PATH`. Use an absolute path to the hook script in `hooks.json` so Codex can start from any working directory. Change `--diagram diagram.mmd` in the UserPromptSubmit command to the project's single diagram path; relative diagram paths resolve from `CLAUDE_PROJECT_DIR` when set, otherwise from the hook script's parent project directory. The PostToolUse handler handles `.mmd` paths in Edit/Write and Codex `apply_patch` input. Shell edits need an explicit render by the agent.

On UserPromptSubmit, the wrapper puts a new diff in `hookSpecificOutput.additionalContext` and returns 0 even if mmx returns 2, so a syntax error becomes context rather than a blocked prompt. On PostToolUse, it puts a successful diff in `additionalContext`; exit 2 sends the error diff as tool feedback.
