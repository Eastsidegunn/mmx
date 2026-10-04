# mmx v0 JSON reference

Default output names for `diagram.mmd` are `diagram.svg`, `diagram.diff.json`, and `diagram.state.json`. This is a self-contained reference to the current CLI output. The agent reads the diff; state is mmx's comparison memory.

## diff.json

Every written diff has these fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `mmx_diff_version` | integer | Schema version, currently `1`. |
| `format` | string | `"mermaid"` in v0. |
| `by` | string | `--by` value, passed through; default `"unknown"`. It records the render caller, not proven edit authorship. |

| `note` | string or null | `--note` value, passed through; null when absent. Stored only in diff.json. |
| `baseline` | boolean | True when no usable previous state exists. All semantic diff arrays are empty. |
| `source_changed` | boolean | False on baseline; true on every written non-baseline turn, including errors and text-only changes. |
| `kind_changed` | object or null | Diagram kind change as `{"old": string, "new": string}`, otherwise null. |
| `nodes` | object | `added`, `removed`, and `changed` arrays, detailed below. |
| `edges` | object | `added`, `removed`, and `changed` arrays, detailed below. |
| `moved` | array | `{"id": string, "dx": number, "dy": number}` entries for relative center moves over 0.5 px. |
| `stats` | object or null | Layout summary on successful render; null on error. |
| `warnings` | string array | Usually empty. State-recovery warnings appear here. |
| `error` | object or null | Parse/encoding error on exit 2; null otherwise. |

`mmx serve` uses `by: "serve"` for its initial baseline.

`nodes.added` and `nodes.removed` contain node ID strings. `nodes.changed` entries are `{"id": string, "field": "label" | "shape", "old": string, "new": string}`. A renamed ID is reported as remove plus add.

`edges.added` and `edges.removed` contain edge-key strings, such as `"A->B#0"`. `edges.changed` entries are `{"key": string, "field": "label", "old": string | null, "new": string | null}`. The `#k` suffix is the zero-based occurrence number for the same `from`/`to` pair in source order. Key numbers can change after an insertion or removal.

`stats` has `mean_move_px` and `max_move_px` (numbers), `global_shift: {"dx": number, "dy": number}`, and `nodes`/`edges` (integer counts). Movement is measured between shared node centers. `global_shift` is the component-wise median displacement; `moved` and the mean/max values use displacement after subtracting it. Derived coordinates are rounded to one decimal place.

`error` has required `kind` (`"parse"` or `"encoding"`) and `message` (string). Optional `line` and `column` are one-based integers; `column` counts UTF-8 characters. Optional `candidates` is a string array, possibly empty. Unavailable optional fields are omitted, not null. The message is authoritative. On exit 2, `nodes`, `edges`, and `moved` are empty, `stats` is null, and SVG/state stay unchanged.

State recovery adds either `"previous state corrupt; treated as baseline"` or `"previous state version unsupported; treated as baseline"` to `warnings`. The successful render backs up the old state to `<state>.corrupt`. The recovery turn is a baseline, so `--print-if-changed` prints nothing; if recovery is suspected, read `<stem>.diff.json` directly to see the warning. An error turn preserves the old state.

## state.json

| Field | Type | Meaning |
| --- | --- | --- |
| `mmx_state_version` | integer | Schema version, currently `1`. |
| `format` | string | `"mermaid"` in v0. |
| `source_sha256` | string | Lowercase hex SHA-256 of source bytes. |
| `kind` | string | Renderer diagram kind, for example `"Flowchart"`. |
| `nodes` | object keyed by node ID | Each value has `label` and `shape` strings, plus numeric `x`, `y`, `w`, `h`. |
| `edges` | array of objects | Each entry has string `key`, `from`, `to`, and string-or-null `label`. |

`x`/`y` are a node's top-left coordinates; `w`/`h` are its size. State coordinates retain renderer precision. Do not edit state manually.

## Write behavior

A first successful render writes a baseline diff with empty change arrays, zero movement, and populated stats. A source hash match is a no-op: exit 0, no writes, and no `--by`/`--note` update. If the previous diff contains an error, mmx renders even when the source matches the last valid state, so it can clear stale error feedback. `--print-if-changed` prints the exact written diff bytes for non-baseline turns, including exit 2; baseline and no-op runs print nothing. Other failures exit 1.
