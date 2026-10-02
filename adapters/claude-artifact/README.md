# Claude artifact board — a ready conversation surface

`board.html` is a working shell that embeds the `<mmx-editor>` component in a
claude.ai artifact and wires the round trip through the artifact's shared
database. An agent can publish it as-is to give its human a visual editing
surface for the shared diagram.

## How an agent sets it up

1. Publish `board.html` as an artifact with:
   - supporting file `mmx-editor.js` -> `editor/mmx-editor.js` from this repo
   - capability `{"db": {}}`
2. Seed the board: write a `board/current` document containing the latest
   render outputs:
   ```json
   {"seq": 1, "by": "agent", "note": "...",
    "source": "<diagram.mmd text>", "svg": "<diagram.svg text>",
    "nodes": <state.json nodes>, "edges": <state.json edges>}
   ```
3. Each of your turns, check the `inbox` collection for documents with
   `status: "new"` — each one is a human edit: `{source, note}`.
   For each: write `source` to the `.mmd` file, run
   `mmx render <file> --by human --note "<note>"`, do your own response
   edits and render, then write the fresh outputs back to `board/current`
   (bump `seq`) and mark the inbox document done.

The human edits the picture in place and presses Send; their manipulation is
serialized to mermaid and lands in your inbox with their note. The page
updates live when you write `board/current` — no reload.

The page also offers "make a link": the current edit + note encoded in a URL
fragment (`#mmx=...`) the human can paste into the CLI conversation instead.

Korean UI strings are wired in `board.html`'s `strings` object; replace them
to localize. The `--mmx-height` CSS variable controls canvas height.
