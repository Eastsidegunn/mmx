// Smoke test for mmx_wasm.wasm + mmx-wasm.js in Node >= 18.
//   node wasm/check.mjs path/to/mmx_wasm.wasm
// Exits 0 when every check passes, 1 otherwise.
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { loadMmx } from "./mmx-wasm.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto; // Node 18

const path = process.argv[2];
if (!path) {
  console.error("usage: node wasm/check.mjs path/to/mmx_wasm.wasm");
  process.exit(1);
}

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
}

const mmx = await loadMmx(await readFile(path));

// 1. Baseline turn.
const v1 = "flowchart LR\n    a[Start] --> b[Check]\n    b --> c[Done]\n";
let t0 = performance.now();
const first = mmx.turn({ source: v1, by: "agent", note: "first draft" });
let ms = (performance.now() - t0).toFixed(1);
check("baseline exit 0", first.exit === 0, `exit=${first.exit} (${ms} ms)`);
check("baseline svg starts with <svg", typeof first.svg === "string" && first.svg.startsWith("<svg"),
  `${first.svg?.length} chars`);
check("baseline has state", !!first.state && typeof first.state.source_sha256 === "string");
check("baseline diff by/note", first.diff?.by === "agent" && first.diff?.note === "first draft");

// 2. Second turn against the first state: one node added.
const v2 = v1 + "    c --> d[Ship]\n";
t0 = performance.now();
const second = mmx.turn({ source: v2, by: "human", note: "add shipping", prev_state: first.state });
ms = (performance.now() - t0).toFixed(1);
check("second exit 0", second.exit === 0, `exit=${second.exit} (${ms} ms)`);
check("second diff.nodes.added[0].id === 'd'", second.diff?.nodes?.added?.[0]?.id === "d",
  JSON.stringify(second.diff?.nodes?.added));
check("second diff.edges.added has c->d",
  (second.diff?.edges?.added ?? []).some((e) => e.from === "c" && e.to === "d"),
  JSON.stringify(second.diff?.edges?.added));
check("second svg starts with <svg", second.svg?.startsWith("<svg"));

// 3. Same source again: no-op.
const same = mmx.turn({ source: v2, by: "human", prev_state: second.state });
check("unchanged source is a noop", same.exit === 0 && same.noop === true, JSON.stringify(same));

// 4. Broken Mermaid: exit 2 with a located error, no state.
const broken = mmx.turn({ source: v2 + "    d --> e[Oops\n", by: "human", prev_state: second.state });
check("parse error exit 2", broken.exit === 2, `exit=${broken.exit}`);
check("parse error diff.error", !!broken.diff?.error, JSON.stringify(broken.diff?.error));
check("parse error has no state/svg", broken.state === undefined && broken.svg === undefined);

// 5. Bad request: exit 1 with a string error.
const bad = mmx.turn({ source: v2, by: "human", prev_state: { nonsense: true } });
check("bad prev_state exit 1", bad.exit === 1 && typeof bad.error === "string", bad.error);

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
