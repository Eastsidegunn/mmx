# mmx-wasm

One full mmx turn (lint, render, diff, state) as a WebAssembly module, for
hosts that have no `mmx` binary: a browser page, a claude.ai artifact, a
Node service. It is the CLI's own core with files swapped for JSON in and
out, so the SVG, `diff` (diff.json v2) and `state` are the same ones
`mmx render` would write.

## Get it

Both files are attached to every GitHub release:

- `https://github.com/Eastsidegunn/mmx/releases/latest/download/mmx_wasm.wasm`
- `https://github.com/Eastsidegunn/mmx/releases/latest/download/mmx-wasm.js`

`latest` follows new releases. To pin a version, use
`https://github.com/Eastsidegunn/mmx/releases/download/vX.Y.Z/<file>` and keep
the two files from the same release. Download them and serve them from your
own origin: release downloads are a redirect without CORS headers and are
served as `application/octet-stream`, so a page cannot `fetch` or `import`
them directly from GitHub.

`mmx-wasm.js` is a dependency-free ES module (under 200 lines) that provides
the small WASI shim the module needs and wraps the raw ABI.

## Use

```html
<script type="module">
  import { loadMmx } from "./mmx-wasm.js";      // also sets window.MmxWasm
  const mmx = await loadMmx("./mmx_wasm.wasm"); // URL, bytes or WebAssembly.Module

  let state = null;                             // the host keeps prev_state
  function turn(source, by, note) {
    const out = mmx.turn({ source, by, note, prev_state: state });
    if (out.exit === 0 && !out.noop) {
      state = out.state;                        // commit, like state.json
      document.getElementById("pic").innerHTML = out.svg;
    }
    return out;                                 // out.diff is diff.json v2
  }
  turn("flowchart LR\n  a[Start] --> b[Done]\n", "agent", "first draft");
</script>
```

```js
// Node >= 18 (on Node 18 also: globalThis.crypto ??= (await import("node:crypto")).webcrypto)
import { readFile } from "node:fs/promises";
import { loadMmx } from "./mmx-wasm.js";
const mmx = await loadMmx(await readFile("mmx_wasm.wasm"));
const a = mmx.turn({ source: "flowchart LR\n  a --> b\n", by: "agent" });
const b = mmx.turn({ source: "flowchart LR\n  a --> b\n  b --> c\n", by: "human",
                     note: "add c", prev_state: a.state });
console.log(b.diff.nodes.added); // [{ id: "c", label: "c", shape: "Rectangle" }]
```

`node wasm/check.mjs path/to/mmx_wasm.wasm` runs a baseline turn, a
follow-up turn, a no-op, a parse error and a bad request against a build.

## Input and output

`turn(input)` is synchronous (a typical turn takes a few milliseconds; the
first one also warms up the module).

Input:

| field | type | |
| --- | --- | --- |
| `source` | string | the Mermaid text of this turn (required) |
| `by` | string | who made the turn: `"agent"`, `"human"`, ... (default `"unknown"`) |
| `note` | string | optional message; empty means none |
| `prev_state` | object or null | the `state` of the last successful turn; omit or `null` for a baseline |

Output, one of:

| `exit` | shape | meaning |
| --- | --- | --- |
| `0` | `{exit, svg, diff, state}` | rendered. Store `state` as the next `prev_state`. |
| `0` | `{exit, noop: true}` | `source` has the same hash as `prev_state`: nothing to say. |
| `2` | `{exit, diff}` | fixable parse/lint error: `diff.error` has `kind`, `message`, `line`, `column`. No `svg`/`state`; keep the old `prev_state`. |
| `1` | `{exit, error}` | bad request (invalid JSON, missing `source`, a `prev_state` that is not an mmx state); `error` is a string. |

`diff` and `state` follow
[`skills/mmx/references/diff-schema.md`](../skills/mmx/references/diff-schema.md).
A trap inside the module (a bug) makes `turn` throw; the loader then
replaces the instance, so the next call works.

## Raw ABI

For hosts that do not use `mmx-wasm.js` (target `wasm32-wasip1`, memory
exported as `memory`, pointers and lengths are `i32`):

1. `wasm_alloc(len) -> ptr`: reserve `len` bytes; write the UTF-8 request
   JSON there.
2. `wasm_turn(ptr, len) -> out_ptr`: run the turn.
3. `wasm_result_len() -> len`: the length of the UTF-8 response JSON at
   `out_ptr`. It stays valid until the next `wasm_turn`. Re-read
   `memory.buffer` after the call; it may have grown.
4. `wasm_free(ptr, len)` (0.4.1 and later): release the request buffer
   from step 1 once the response has been read. Modules from 0.4.0 lack it
   and leak a few KB per turn; `mmx-wasm.js` calls it when present.

Imports (all `wasi_snapshot_preview1`): `random_get`, `environ_get`,
`environ_sizes_get`, `clock_time_get`, `fd_close`, `fd_fdstat_get`,
`fd_filestat_get`, `fd_prestat_get`, `fd_prestat_dir_name`, `fd_read`,
`fd_write`, `path_create_directory`, `path_filestat_get`, `path_open`,
`proc_exit`. They come from the Rust standard library; a turn does not use
the file system. `mmx-wasm.js` gives it a real clock and randomness,
stdout/stderr on the console, an empty environment, no preopened directories
(`fd_prestat_get` returns `EBADF`) and `ENOSYS` for the path functions. Any
complete WASI preview1 implementation works as well.

## Compared to the CLI

Same turn semantics: the same lint (errors and warnings), renderer,
diff and state. What the CLI does around a turn is the host's job here:

- **The host stores `prev_state`.** The module keeps nothing between calls.
  Pass the last successful `state` back; after an exit-2 turn, keep the
  previous one (the CLI also leaves `state.json` untouched on errors).
- **No turn log, no `serve`, no `wait`/`note`.** Nothing is written to disk.
  Record the `diff`s yourself if you need a history.
- **No-op is stricter.** Identical source returns `noop: true` even when a
  `note` is given or the previous turn was an error. The CLI turns a note on
  unchanged bytes into a note-only turn and treats the first good render
  after an error as a recovery turn. A host that needs either should handle
  it itself (for example, show the note without calling `turn`).
- **No corrupt-state recovery.** A `prev_state` the module cannot read is an
  exit-1 error; the CLI would back it up and start a fresh baseline.
- `source` is a JS string, so the CLI's invalid-UTF-8 error cannot occur.
- Request buffers are freed after each call with `wasm_free` (0.4.1 and
  later). A 0.4.0 module has no `wasm_free` and leaks a few KB per turn;
  reload it if a long-lived page runs very many turns.
