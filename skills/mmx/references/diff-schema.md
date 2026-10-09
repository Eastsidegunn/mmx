# mmx diff format v2

For `diagram.mmd`, mmx writes `diagram.svg`, `diagram.diff.json`, and `diagram.state.json`. The agent reads the diff. State is mmx's memory for the next comparison.

## diff.json

| Field | Type | Meaning |
| --- | --- | --- |
| `mmx_diff_version` | integer | `2`. |
| `format` | string | `"mermaid"`. |
| `by` | string | Render caller (`--by`); does not prove edit authorship. |
| `note` | string or null | `--note` text, null when absent. |
| `baseline` | boolean | No usable previous state. Change sections are empty. |
| `source_changed` | boolean | Source differs from previous state. False for baseline and forced note-only turns. |
| `kind_changed` | object or null | `{old, new}` diagram kind strings. |
| `direction` | object or null | `{old, new}` direction strings, such as `TD` and `LR`; null when unchanged or previous direction unknown. |
| `nodes` | object | `added`, `removed`, `changed` arrays. |
| `edges` | object | `added`, `removed`, `changed` arrays. |
| `subgraphs` | object | `added`, `removed`, `changed` arrays. |
| `source_hunks` | array or null | Unified line diff hunks. Null for baseline, unchanged text, a v1 state whose source is unknown, or an encoding error whose text cannot be decoded. |
| `source_hunks_truncated` | boolean | True if the total hunk lines were capped at 400. |
| `moved` | array | `{id, dx, dy}` entries for relative center moves over 0.5 px. |
| `stats` | object or null | Layout summary on success; null on error. |
| `warnings` | string array | State recovery or diagram coverage warnings. |
| `error` | object or null | Fixable parse/encoding error on exit 2. |

`nodes.added` and `nodes.removed` contain `{id, label, shape}` objects; removed entries carry the last known label and shape. `nodes.changed` contains `{id, field, old, new}` where `field` is `label` or `shape`. An ID rename is a removal plus addition.

`edges.added` and `edges.removed` contain `{key, from, to, label, style}`. `label` is a string or null; `style` is `solid`, `dotted`, or `thick` (null only if removed data came from a v1 state). `edges.changed` contains `{key, field, old, new}` where `field` is `label` or `style`. Style changes are omitted when the old style is unknown. The key is `{from}->{to}#{k}`; `k` is the zero-based occurrence number among edges with the same endpoints in source order. Keys may shift after an insertion or removal.

`subgraphs.added` and `subgraphs.removed` contain `{id, label, nodes, direction}`. `id` and `direction` may be null, and `nodes` is an array of node IDs. Matching uses `id` when present, otherwise the label plus occurrence index (for example `Same X#1`); changing a label with no ID therefore appears as removal plus addition. `subgraphs.changed` contains `{id, field, old, new}` for `label` (strings), `nodes` (arrays), or `direction` (direction string or null); its `id` is the matching key. Subgraph changes are omitted when a v1 state has no prior subgraph data.

A source hunk is `{old_start, old_lines, new_start, new_lines, lines}`. Starts are one-based line numbers, or zero for an empty side; counts describe the included hunk lines on each side. Each line begins with a space (context), `-` (old), or `+` (new); a line without a final newline also has the standard `\\ No newline at end of file` marker. Hunks carry one context line on each side. The total `lines` entries are capped at 400; `source_hunks_truncated` then becomes true. Source hunks show text changes such as `classDef`, `style`, comments, and changes in diagrams whose nodes and edges are partially modeled. They can coexist with semantic changes. A CRLF/LF-only conversion has no line hunks but sets `source_changed` and warns `line endings changed (CRLF/LF)`.

`stats` contains `mean_move_px`, `max_move_px`, `global_shift: {dx, dy}`, `nodes`/`edges` counts, and `crossings`. Movement uses shared node centers after subtracting the component-wise median shift. Derived coordinates are rounded to one decimal place. `moved` reports layout shifts; it does not prevent them. `crossings` is the integer number of edge pairs whose routed lines cross in the rendered picture (`mmx render --layout-search N` reorders the top-level node declaration lines and edge lines of a flowchart to lower it).

`error` has required `kind` (`parse` or `encoding`) and `message`. Optional `line` and `column` are one-based; column counts characters. Optional `candidates` is a string array. Unavailable fields are omitted. On exit 2 the graph change sections are empty, `stats` is null, and SVG/state remain unchanged. A parse error may still include `source_hunks` when the previous source is known. Lint follows mermaid.js and detects missing diagram headers and unclosed flowchart shape brackets before rendering; `A[foo (bar]`, `A[a|b]`, and header-less files are lint errors even if mmdr renders them. These report exact positions. Renderer errors retain the renderer's own message and available position.

A non-flowchart diagram warns `"<kind> diagram: the nodes/edges diff is partial for this diagram type; source_hunks shows every text change"`. On a baseline turn, the warning ends after `diagram type`. A flowchart with no nodes warns `"diagram has no nodes"`. State recovery warns `"previous state corrupt; treated as baseline"` or `"previous state version unsupported; treated as baseline"`; the old file is backed up as `<state>.corrupt` after a successful render.

## state.json

| Field | Type | Meaning |
| --- | --- | --- |
| `mmx_state_version` | integer | `2`. |
| `format` | string | `"mermaid"`. |
| `source_sha256` | string | Lowercase SHA-256 of source bytes. |
| `source` | string | Full committed source text. |
| `kind` | string | Renderer diagram kind. |
| `direction` | string | Renderer graph direction (`TD`, `LR`, `BT`, `RL`). |
| `subgraphs` | array | `{id, label, nodes}` objects. |
| `nodes` | object keyed by ID | `label`, `shape`, and numeric top-left `x`, `y`, size `w`, `h`. |
| `edges` | array | `{key, from, to, label, style}` objects. |
| `crossings` | integer | Edge pairs whose routed lines cross (0 when absent). |

A v1 state loads without corruption recovery. Its missing source, direction, subgraphs, and edge styles are unknown, so mmx does not report changes against those fields on the upgrade turn. The next state is v2. Do not edit state manually.

## Write behavior

The first successful render is a baseline with empty change arrays and populated stats. Matching source hashes normally cause a no-op: exit 0 and no writes. A stale error diff causes a recovery render even if the source matches the last valid state. `--print-if-changed` prints the written diff on non-baseline turns, including exit 2; baseline and no-op runs print nothing. Other failures exit 1. `mmx serve` uses `by: "serve"` for its initial baseline.

## Known limitations

Sequence diagram message order is not modeled; changes appear in `source_hunks` only. Layout positions are not stable across turns: `moved` reports movement but does not prevent it.
