# mmx-editor

A dependency-free, embeddable editing component for mmx diagrams. It renders
an mmx-produced SVG and lets a person manipulate the visible flowchart —
rename a node in place, delete it, connect nodes, add new ones — then hands
the result back as mermaid text.

**Editing only, by design.** The module does not know where the text goes.
The host wires the callbacks: write it to the `.mmd` file, POST it to a
server, store it in a database — whatever fits the project. This is what
makes it embeddable anywhere.

## Use — `<mmx-editor>` (standard interface)

```html
<script src="mmx-editor.js"></script>
<mmx-editor id="ed"></mmx-editor>
<script>
  const ed = document.getElementById("ed");
  ed.load({svg, nodes, edges, source});   // from `mmx render` + state.json
  ed.addEventListener("mmx-submit", e => {
    // e.detail = {source, note, ops} — persist it, run
    // `mmx render --by human --note ...`, then push the fresh render back:
    ed.load(newRender);                    // partial update, no page reload
  });
  ed.addEventListener("mmx-change", e => {
    // fires after each committed operation: e.detail = {source, ops}.
    // A local host with mmx on hand can live-render here (~3 ms).
  });
</script>
```

Works as a plain tag in any framework (React, Vue, Svelte, none). Optional
`ed.strings = {...}` overrides UI strings — set it before `load()`.
`ed.getSource()`, `ed.getNote()`, `ed.pendingOps()` are also available.

## Use — low-level `mount()` (when you want callbacks instead of events)

```html
<div id="editor"></div>
<script src="mmx-editor.js"></script>
<script>
  const editor = MmxEditor.mount(document.getElementById("editor"), {
    svg:    svgText,      // output of `mmx render` (<stem>.svg)
    nodes:  state.nodes,  // from <stem>.state.json
    edges:  state.edges,  // from <stem>.state.json (from/to/label)
    source: mmdText,      // the mermaid source of that render
    onSubmit(r) {
      // r = {source, note, ops} — the user pressed Send.
      // Host's job: persist r.source, run `mmx render --by human --note r.note`,
      // then feed the fresh render back via editor.update(...).
    },
    onChange(r) {
      // fires after every committed operation: r = {source, ops}.
      // A local host with mmx on hand can live-render here (~3 ms).
    },
  });

  // When a new confirmed render arrives (any source — file watcher, poll,
  // realtime store), reset the editor to it:
  editor.update({svg, nodes, edges, source});
</script>
```

Also available: `editor.getSource()` (serialize the current edit state),
`editor.getNote()` (current note text, for hosts building alternate
transports such as share links), `editor.pendingOps()` (count of unsent
operations), `editor.destroy()`.

## Data contract

Everything the module needs is already produced by `mmx render`:

| input | comes from |
|---|---|
| `svg` | `<stem>.svg` |
| `nodes` (`{id: {label, shape, x, y, w, h}}`) | `<stem>.state.json` |
| `edges` (`[{from, to, label}]`) | `<stem>.state.json` |
| `source` | the `.mmd` file |

The node coordinates are what make direct manipulation possible: the module
overlays click targets on the SVG at those positions. Layout is never edited —
positions belong to the renderer, not the source.

## Behavior notes

- **Feed it trusted SVG only.** The module injects the `svg` string into the
  DOM as-is. It is designed for mmx's own render output; passing SVG from an
  untrusted source is an XSS risk the module does not defend against.
- Labels are normalized on serialization: newlines become spaces, `"` inside
  a quoted label becomes `'`, and `|` in edge labels is dropped (all three
  would change the mermaid parse). The flowchart direction (`TD`, `LR`, ...)
  of the confirmed source is preserved.
- Shadow DOM is required for style isolation. In an environment without it,
  the module still runs but its styles apply to the whole page.

- Serialization targets the flowchart subset (Rectangle/Diamond shapes,
  labeled edges). Comments and style directives in the original source are
  not preserved by direct-manipulation edits; hosts that need them should
  offer raw-source editing as a separate path.
- Dragging a node is a temporary placement: only the edges touching moved
  nodes are redrawn as overlay lines; the rest of the real rendering stays.
  Positions are never serialized — send or a new load snaps back to the
  renderer's layout ("auto layout" undoes it immediately).
- Double-click a node to rename it in place (single click opens the
  edit/delete menu). The canvas pans by dragging the background, zooms with
  the wheel, and refits on background double-click or the "fit" button.
- Send is disabled while there is nothing to send — no pending operation and
  an empty note. A note alone counts: hosts may treat a note-only submit as
  a real turn (mmx serve does).
- New nodes appear in a staging row until the next real render assigns them
  a position. Pending connections are drawn as dashed overlay arrows.
- Deleting is reversible until Send: deleted nodes stay visible, dimmed;
  click again to undo.
- Styles are isolated in shadow DOM. Theme via CSS custom properties on the
  container: `--mmx-accent`, `--mmx-select`, `--mmx-surface`, `--mmx-border`,
  `--mmx-ink`, `--mmx-muted`, `--mmx-canvas`.
- UI strings are English by default; override any of them via the `strings`
  option.

## Demo

Open `demo.html` in a browser — self-contained, built from a real
`mmx render` of `examples/diagram.mmd`.
