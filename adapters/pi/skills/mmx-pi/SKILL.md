---
name: mmx-pi
description: Use this pi extension's mmx cockpit tools when a Mermaid diagram is being edited or reviewed in pi.
---

When pi edits or writes a `.mmd` file, the extension validates the new source automatically in a temporary directory; validation does not create an mmx turn. Call `mmx_render` with a concise note describing what changed and why to commit the change and send it through mmx. Suggest `/mmx open <path>` when the human should inspect or edit the local cockpit.

Human edits arrive as `mmx-turn` messages. Read the one-line instruction and compact diff, then answer by editing the diagram and calling `mmx_render` with a note. `mmx_wait` is available when you need to synchronously wait for a human turn; the watcher delivers a turn to the model once, while `mmx_wait` shows the human's unanswered turns.

For the full diff schema and generated-file rules, read mmx's own `skills/mmx/SKILL.md` in the mmx repository.
