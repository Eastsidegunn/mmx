# Codex CLI adapter

This is an experimental, opt-in adapter. The example in `hooks.json` is inactive while it stays under `adapters/`; copy it to a trusted project's `.codex/hooks.json` and review/trust it with `/hooks`. Current Codex releases have hook support enabled by default, though project hooks do not run until installed and trusted. [Official Hooks guide](https://developers.openai.com/codex/hooks).

Keep `adapters/mmx_hook.py` in the project and install `mmx` on `PATH`. Use an absolute path to the hook script in `hooks.json` so Codex can start from any working directory. Change `--diagram diagram.mmd` in the UserPromptSubmit command to the project's single diagram path; relative diagram paths resolve from `CLAUDE_PROJECT_DIR` when set, otherwise from the hook script's parent project directory. The PostToolUse handler handles `.mmd` paths in Edit/Write and Codex `apply_patch` input. Shell edits need an explicit render by the agent.

On UserPromptSubmit, the wrapper puts a new diff in `hookSpecificOutput.additionalContext` and returns 0 even if mmx returns 2, so a syntax error becomes context rather than a blocked prompt. On PostToolUse, it puts a successful diff in `additionalContext`; exit 2 sends the error diff as tool feedback.
