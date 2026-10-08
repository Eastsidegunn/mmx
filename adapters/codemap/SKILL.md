---
name: mmx-codemap
description: "Use when an agent should draw or update a bounded codebase map as a Mermaid flowchart in mmx, so a human can correct dependencies, labels, omissions, and the next area to expand in the mmx cockpit."
---

# Codebase maps in the mmx cockpit

Draw the part of a codebase that answers the current turn. A codemap is not a
fixed architecture level or a complete repository dump: every turn chooses a
fresh focus, selects the useful neighborhood or paths, reduces it to a readable
picture, and uses the human's cockpit edits to choose the next focus.

This skill extends the repository's `mmx` skill. Follow that skill's render,
wait, note, error-repair, generated-file, and one-renderer rules. In particular,
edit only `.mmd`; show the SVG produced by `mmx`; never put these maps in
Mermaid `subgraph` blocks. The pinned renderer makes subgraphs extremely wide
and can fail on large maps.

## Pipeline

1. Read the question and the latest mmx diff.
2. Form the focus set, in this order: files or symbols named in the turn; files
   in the current git diff; nodes annotated by the human with `expand`,
   `explain`, or `펼쳐 줘`; otherwise entry points such as `main`, binaries,
   handlers, or public dispatch functions.
3. Choose one selection strategy from the table below. Selection is per turn;
   do not preserve an old zoom level merely because it was drawn previously.
4. If the selection exceeds the target, apply the reductions in the exact order
   below. Splitting is the last resort.
5. Write an idiomatic `flowchart LR`, render it with `mmx render ... --by
   agent --note "..."`, and invite the human to correct it with `mmx serve`.
6. Read the next diff as graph feedback, update `.mmx/codemap.json`, verify
   claims against source, and repeat from the new focus.

## Question to strategy

| Question or task | Strategy | Selection |
| --- | --- | --- |
| “What is around this file/symbol?” or “How does this flow?” | `neighborhood` | Both incoming and outgoing edges, grown one hop at a time. Start with 1; use 2 on the next expansion or when explicitly useful. If hop 2 would cross a hard cap, retain hop 1 and attach package summaries for hop 2. |
| “How does A reach B?” | `path` | The k shortest directed paths between exactly two focus nodes. The reference script uses `--hops` as k. |
| “What breaks or must change if this changes?” | `impact` | Reverse reachability from the focus, bounded by `--hops`. |
| “Explain/review this change.” | `changeset` | Files in the git diff as focus plus one hop in both directions. |

The host supplies the focus ids. The script does not inspect git or source to
guess them.

## Size and reductions

Target at most 25 nodes and 40 edges per picture. Never exceed the hard cap of
40 nodes and 60 edges while growing a neighborhood. If hop 1 itself exceeds a
hard cap, use that real one-hop selection and reduce it. If adding hop 2 would
exceed a hard cap, keep hop 1, replace hop-2 nodes with package summaries
attached to the hop-1 ring, and stop expanding. The report records
`"hops_used": 1` and `"hop2_summarized": true` for that case.

When a selected graph is above either target, apply these reductions in order.
Re-check both targets after every applied step and stop immediately when the
picture fits; report only steps that actually changed the picture.

1. **Fold bounded hubs.** Compute degree in the selected graph. The threshold
   is `max(p90, 2 * median)`, and at most `ceil(10% of selected nodes)`
   non-focus hubs may be folded (highest degree first, then stable id). A folded
   hub remains as a label-only `hub (N refs)` node. Keep any edge between it and
   a focus node, and keep protected path edges; remove only its other edges. A
   focus node is always drawn normally. The report includes the threshold and
   folded ids. After this and every later reduction, remove non-focus nodes
   with no remaining edge and report their ids in `pruned_orphans`.
2. **Fold distant rings.** Compute hop distance from the focus set. Starting at
   the maximum distance and moving inward, replace two or more nodes in each
   package with `pkg/* (k files)`, redirecting and merging edges. Strip the
   common directory prefix of all selected nodes, then use the first directory
   below it as the package; if one package still contains more than half the
   nodes, use two directory levels. Files directly under the stripped root are
   in `(root)`. Fold ring by ring and package by package, re-checking both
   targets after each fold. One summary may never contain more than half of
   the selected non-focus nodes, and a one-file summary is forbidden. Stop as
   soon as both targets are met. Never fold ring 1 for a `neighborhood` or
   `changeset`, and never fold nodes on a returned `path`.
3. **Drop low-weight non-focus edges.** Remove the smallest `count` first until
   the edge target is met. Focus-incident edges are protected, as are all edges
   on a returned `path`. For `impact`, protect a shortest reverse path from
   every reached node back to the focus. If the focus alone has more incident
   edges than the picture can contain, keep the highest-weight deterministic
   subset that fits both targets (`min(node target - 1, edge target)` for one
   focus), breaking ties by stable edge id, and report how many focus edges
   were kept and hidden. If that leaves edge capacity, restore the
   highest-weight dropped non-focus edges whose endpoints still survive.
4. **Split.** Only if those reductions still cannot meet the target, write
   part 1 to `--out` and companions as `<out-stem>-part2.mmd`,
   `<out-stem>-part3.mmd`, and so on. Explain the reason in the mmx turn note.
   Splitting preserves every retained edge, and every picture contains at
   least one focus node.

Summarize hidden information in one human-readable Mermaid comment, for
example: `%% hidden: 3 hubs (api/file_00.rs 61 refs, …), 118 low-weight edges,
9 packages folded (ring 2)`.

## Drawing contract

- Start with `flowchart LR`; never use `subgraph`.
- Declare focus nodes before all other nodes so they tend to land on the left.
- Derive absent ids from paths by replacing every non-alphanumeric character
  with `_`: `src/serve.rs` becomes `src_serve_rs`. Prefix a derived Mermaid
  reserved word (`end`, `subgraph`, `graph`, `flowchart`, `style`, `class`,
  `classDef`, `click`, `linkStyle`, `direction`, or `default`) with `n_`.
  Encode a non-ASCII run as `_x<hex>` using its first code point. If two paths
  still collide, append `_` plus the first six hex digits of SHA-1(path).
- Keep labels as short paths, including the package prefix. Package membership
  is conveyed by that prefix, not by containment. Truncate long paths in the
  middle (`pkg/…/file.rs`). In quoted labels replace newlines with spaces and
  `"` with `'`; leave `&`, `<`, and `>` raw because the pinned renderer does
  not decode HTML entities.
- Draw `import` and `call` with `-->`. Draw `dynamic` and `test` with `-.->`;
  label tests `test`, or `test ×N` when the count is greater than one. Show
  count on the other edge kinds when it is greater than one.
- Use `classDef focus`, `hub`, `folded`, and `external`. External dependencies
  use the `(( ))` shape.

## Persistent human memory

Store only interaction memory—not source text—in `.mmx/codemap.json`:

```json
{
  "aliases": {"src_serve_rs": "cockpit server"},
  "omitted": ["src_legacy_rs"],
  "last": {
    "focus": ["src_serve_rs"],
    "strategy": "neighborhood",
    "reductions": []
  }
}
```

`aliases` are human-renamed labels keyed by stable node id. `omitted` contains
ids the human deleted and must be filtered before selection. `last` records the
last focus, strategy, and applied reduction reports. Preserve aliases and
omissions across turns.

## Read cockpit edits

Read diff v2 from `mmx wait` using the base mmx skill:

| Human edit | Interpretation and response |
| --- | --- |
| Turn-level `note` names an id, label, or path with `expand`, `explain`, or `펼쳐 줘` | Resolve that reference against the current nodes and make it the next focus. There is no per-node note in diff v2. |
| Node removed | Add its id to `omitted`; keep it out of later selections. If it is a `pkg/* (k files)` summary, add its member file ids instead; the script expands a remembered summary id when loading memory. |
| Node label changed | Store the new label in `aliases`. For a hub or summary, strip the generated ` (N refs)` or `/* (k files)` suffix first; do not store an alias for a generated summary id. |
| Edge added | Treat it as a dependency claim. Verify it in source; keep it if supported, otherwise ask in the turn note. |
| Edge removed | If either endpoint also appears in `nodes.removed`, it is a consequence of deleting that node. Otherwise treat it as “should not depend,” verify the dependency, and propose a concrete decoupling task rather than pretending the code already changed. |
| Edge label or style changed | Treat it as the human's annotation. Preserve it in interaction notes/aliases; do not rewrite the indexed dependency graph. |
| Node shape changed | Treat it as the human's annotation. Preserve it in interaction notes/aliases; do not reinterpret the node kind or change the graph. |
| “Why connected?” | Answer in the mmx note with file/line evidence; do not invent a reason. |
| `moved` entries | Ignore them; they are layout effects, not human graph edits. |

A note with no graph change is still a question and needs an answer. Read the
single top-level `note`, then correlate its references with `nodes`, `edges`,
and `source_hunks`; do not look for a note field inside a node entry.

## Index contract and reference command

Indexing belongs to the host, not this skill. Any index is acceptable: a
Mermaid graph from another tool converted to JSON, grep-derived facts, a
language server, or the example Rust scanner. Feed the reference script:

```json
{
  "nodes": [{"id": "src_serve_rs", "path": "src/serve.rs", "kind": "file", "refs": 12}],
  "edges": [{"from": "src_serve_rs", "to": "src_emit_rs", "kind": "call", "count": 3}]
}
```

`id` may be omitted and will be derived from `path`. Node kinds are `package`,
`file`, `symbol`, or `external`; edge kinds are `import`, `call`, `test`, or
`dynamic`.

Run from the project root:

```bash
python3 adapters/codemap/codemap.py graph.json \
  --focus src_serve_rs \
  --strategy neighborhood \
  --hops 1 \
  --memory .mmx/codemap.json \
  --out cockpit-flow.mmd
mmx render cockpit-flow.mmd --by agent \
  --note "Cockpit turn flow around src/serve.rs; 1-hop neighborhood"
```

The script prints one JSON report with `nodes`, `edges`, `strategy`, ordered
`reductions`, `pruned_orphans`, and `split` filenames. When split, `nodes` and
`edges` are the per-picture maxima. Path reports also contain `paths_found`.
`n_` on an id records reserved-word protection, not a package. With `--lenient`,
unknown edge endpoints are skipped and listed in `skipped_edges`; strict mode
is the default. Defaults are target 25/40 and hard 40/60; they can be set with
`--max-nodes`, `--max-edges`, `--hard-nodes`, and `--hard-edges`.

For a small Rust crate, build a file-level index with only the standard
library:

```bash
python3 adapters/codemap/example/index_rust.py src > graph.json
```

The example scanner recognizes file modules, nested brace imports, inline
`crate::`, `self::`, and `super::` paths, and the Cargo package name in binary
targets. It labels references inside `#[cfg(test)]`/`mod tests` blocks as
`test`; `src/main.rs` and `src/bin/*.rs` are binary roots rather than library
modules. It is deliberately small; verify important edges in the actual source
before answering the human.
