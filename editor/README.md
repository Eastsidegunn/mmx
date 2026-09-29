# mmx-editor

A dependency-free, embeddable editing component for mmx diagrams. It renders
an mmx-produced SVG and lets a person manipulate the visible flowchart —
rename a node in place, delete it, connect nodes, add new ones — then hands
the result back as mermaid text.

**Editing only, by design.** The module does not know where the text goes.
The host wires the callbacks: write it to the `.mmd` file, POST it to a
server, store it in a database — whatever fits the project. This is what
makes it embeddable anywhere.

## Use

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

- Serialization targets the flowchart subset (Rectangle/Diamond shapes,
  labeled edges). Comments and style directives in the original source are
  not preserved by direct-manipulation edits; hosts that need them should
  offer raw-source editing as a separate path.
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
