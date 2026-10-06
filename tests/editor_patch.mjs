// End-to-end check of mmx-editor's source patching: render a source with the
// real binary, apply editor operations to the state model, patch, render the
// patched text again, and compare graphs + preserved text.
//
//   cargo build && node tests/editor_patch.mjs [path/to/mmx]
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { patchSource, PatchFail } = require(join(here, "../editor/mmx-editor.js"));
const MMX = process.argv[2] || join(here, "../target/debug/mmx");

function render(src) {
  const dir = mkdtempSync(join(tmpdir(), "mmx-patch-"));
  try {
    writeFileSync(join(dir, "d.mmd"), src);
    try {
      execFileSync(MMX, ["render", join(dir, "d.mmd"), "--by", "test"], { stdio: "pipe" });
    } catch (e) {
      return { error: String(e.stderr || e) };
    }
    return JSON.parse(readFileSync(join(dir, "d.state.json"), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function modelOf(state) {
  return { nodes: structuredClone(state.nodes), edges: structuredClone(state.edges) };
}
function graph(state) {
  const nodes = Object.keys(state.nodes).sort().map((id) => `${id}:${state.nodes[id].label}`);
  const edges = state.edges.map((e) => `${e.from}->${e.to}:${e.label ?? ""}`).sort();
  return JSON.stringify({ nodes, edges });
}
const edge = (m, key) => {
  const e = m.edges.find((x) => x.key === key);
  if (!e) throw new Error(`no edge ${key}`);
  return e;
};

const OPS = `flowchart TD
    %% dashed = connection not yet attached
    subgraph team [Team]
        A[Request] -.-> B{Review}
    end
    B ==>|Approve| C[Deploy]
    B -- Reject --> D[Reject]
    C -.->|E2| E((Observe))
    D --> E
    classDef warn fill:#fdd
    class D warn
    style C stroke:#333
`;

const cases = [
  {
    name: "rename keeps dashed/thick arrows, comment, subgraph, classDef",
    src: OPS,
    edit(m) { m.nodes.C.label = "Approved deploy"; m.nodes.C.modified = true; },
    expect(s) { s.nodes.C.label = "Approved deploy"; },
    keep: ["%% dashed", "subgraph team [Team]", "A[Request] -.-> B{Review}", "B ==>|Approve| C[Approved deploy]", "-.->|E2|", "classDef warn", "class D warn", "style C"],
  },
  {
    name: "rename a node with special chars quotes it, shape kept",
    src: OPS,
    edit(m) { m.nodes.E.label = "Observe (E2)"; m.nodes.E.modified = true; },
    expect(s) { s.nodes.E.label = "Observe (E2)"; },
    keep: ['E(("Observe (E2)"))', "-.->|E2|"],
  },
  {
    name: "edge label change keeps dashed style",
    src: OPS,
    edit(m) { const e = edge(m, "C->E#0"); e.origLabel = e.label; e.label = "E3"; e.labelChanged = true; },
    expect(s) { s.edges.find((e) => e.key === "C->E#0").label = "E3"; },
    keep: ["C -.->|E3| E((Observe))", "A[Request] -.-> B{Review}"],
  },
  {
    name: "text-form label change converts to pipe, same arrow type",
    src: OPS,
    edit(m) { const e = edge(m, "B->D#0"); e.label = "Hold"; e.labelChanged = true; },
    expect(s) { s.edges.find((e) => e.key === "B->D#0").label = "Hold"; },
    keep: ["B -->|Hold| D[Reject]"],
  },
  {
    name: "edge delete removes only that statement",
    src: OPS,
    edit(m) { edge(m, "D->E#0").deleted = true; },
    expect(s) { s.edges = s.edges.filter((e) => e.key !== "D->E#0"); },
    keep: ["-.->|E2|", "A[Request] -.-> B{Review}"],
    absent: ["D --> E"],
  },
  {
    name: "node delete removes incident edges, class/style refs",
    src: OPS,
    edit(m) { m.nodes.D.deleted = true; },
    expect(s) {
      delete s.nodes.D;
      s.edges = s.edges.filter((e) => e.from !== "D" && e.to !== "D");
    },
    keep: ["-.->|E2|", "classDef warn", "style C"],
    absent: ["class D warn", "Reject"],
  },
  {
    name: "new edge + fresh node appended, everything else verbatim",
    src: OPS,
    edit(m) {
      m.nodes.n1 = { label: "New node", shape: "Rectangle", fresh: true };
      m.edges.push({ from: "E", to: "n1", label: "Next", pending: true });
    },
    expect(s) {
      s.nodes.n1 = { label: "New node" };
      s.edges.push({ from: "E", to: "n1", label: "Next" });
    },
    keepPrefix: true,
  },
  {
    name: "chain split: delete the middle link keeps both ends",
    src: "flowchart LR\n    A[One] -.-> B[Two] ==> C[Three]\n",
    edit(m) { edge(m, "A->B#0").deleted = true; },
    expect(s) { s.edges = s.edges.filter((e) => e.key !== "A->B#0"); },
    keep: ["B[Two] ==> C[Three]"],
  },
  {
    name: "parallel edges: delete the second occurrence only",
    src: "flowchart LR\n    A -->|ok| B\n    A -.->|retry| B\n",
    edit(m) { edge(m, "A->B#1").deleted = true; },
    expect(s) { s.edges = s.edges.filter((e) => e.key !== "A->B#1"); },
    keep: ["A -->|ok| B"],
    absent: ["retry"],
  },
  {
    name: "bare node whose only edge is deleted survives as a declaration",
    src: "flowchart LR\n    A[One] --> B\n",
    edit(m) { edge(m, "A->B#0").deleted = true; },
    expect(s) { s.edges = []; },
  },
  {
    name: "grouped (&) edge op falls back (throws PatchFail)",
    src: "flowchart LR\n    A & B --> C\n",
    edit(m) { edge(m, "A->C#0").deleted = true; },
    throws: true,
  },
  {
    name: "edge after `flowchart LR;` on the header line counts toward #k",
    src: "flowchart LR; A -->|first| B\n    A -->|second| B\n",
    edit(m) { const e = edge(m, "A->B#0"); e.label = "changed"; e.labelChanged = true; },
    expect(s) { s.edges.find((e) => e.key === "A->B#0").label = "changed"; },
    keep: ["A -->|second| B"],
  },
  {
    name: "deleting a node keeps unrelated statements sharing a class line",
    src: "flowchart LR\n    A --> B\n    class B warn; C --> D\n",
    edit(m) { m.nodes.B.deleted = true; },
    expect(s) {
      delete s.nodes.B;
      s.edges = s.edges.filter((e) => e.from !== "B" && e.to !== "B");
    },
    keep: ["C --> D"],
    absent: ["class B"],
  },
  {
    name: "linkStyle indices follow surviving edges after a delete",
    src: "flowchart LR\n    A --> B\n    C --> D\n    E --> F\n    linkStyle 1,2 stroke:#ff0000\n",
    edit(m) { edge(m, "A->B#0").deleted = true; },
    expect(s) { s.edges = s.edges.filter((e) => e.key !== "A->B#0"); },
    keep: ["linkStyle 0,1 stroke:#ff0000"],
  },
  {
    name: "linkStyle entry for a deleted edge is dropped",
    src: "flowchart LR\n    A --> B\n    C --> D\n    linkStyle 0 stroke:#00f\n    linkStyle 1 stroke:#f00\n",
    edit(m) { edge(m, "A->B#0").deleted = true; },
    expect(s) { s.edges = s.edges.filter((e) => e.key !== "A->B#0"); },
    keep: ["linkStyle 0 stroke:#f00"],
    absent: ["#00f"],
  },
  {
    name: "invisible ~~~ links take no #k slot",
    src: "flowchart LR\n    A ~~~ B\n    A -->|real| B\n    A -->|other| B\n",
    edit(m) { edge(m, "A->B#0").deleted = true; },
    expect(s) { s.edges = s.edges.filter((e) => e.key !== "A->B#0"); },
    keep: ["A ~~~ B", "A -->|other| B"],
    absent: ["real"],
  },
  {
    name: "no ops returns the source byte-for-byte",
    src: OPS,
    edit() {},
    identical: true,
  },
];

let fails = 0;
for (const c of cases) {
  const before = render(c.src);
  if (before.error) { console.log("FAIL", c.name, "(source does not render)", before.error); fails++; continue; }
  const m = modelOf(before);
  c.edit(m);
  let out;
  try {
    out = patchSource(c.src, m);
  } catch (e) {
    if (c.throws && e instanceof PatchFail) { console.log("PASS", c.name); continue; }
    console.log("FAIL", c.name, "threw", e.why || e); fails++; continue;
  }
  if (c.throws) { console.log("FAIL", c.name, "expected PatchFail"); fails++; continue; }
  const problems = [];
  if (c.identical && out !== c.src) problems.push("not byte-identical");
  if (c.keepPrefix && !out.startsWith(c.src.trimEnd())) problems.push("original text not kept as prefix");
  for (const k of c.keep || []) if (!out.includes(k)) problems.push(`missing ${JSON.stringify(k)}`);
  for (const a of c.absent || []) if (out.includes(a)) problems.push(`still has ${JSON.stringify(a)}`);
  const after = render(out);
  if (after.error) problems.push("patched source does not render: " + after.error);
  else if (c.expect) {
    const want = structuredClone(before);
    c.expect(want);
    if (graph(after) !== graph(want)) problems.push(`graph\n   got  ${graph(after)}\n   want ${graph(want)}`);
  }
  if (problems.length) {
    fails++;
    console.log("FAIL", c.name, "\n  " + problems.join("\n  ") + "\n--- patched ---\n" + out);
  } else console.log("PASS", c.name);
}
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
