/*!
 * mmx-editor — in-place diagram editing component for mmx.
 *
 * Editing only, by design: the module renders an mmx-produced SVG, lets the
 * user manipulate the visible flowchart (rename, delete, connect, add, and
 * temporarily rearrange nodes), and hands the result back as mermaid text.
 * Where that text goes — a file, a server, an artifact store — is the host's
 * business.
 *
 * Standard interface: the <mmx-editor> custom element (see bottom).
 * Low-level: MmxEditor.mount(container, opts) with onSubmit/onChange callbacks.
 *
 * Interaction model:
 *  - click a node or an edge  -> small menu (edit / delete)
 *  - drag the ring handle     -> rubber-band connect to another node
 *  - drag a node body         -> temporary placement (thinking aid only:
 *    positions are never serialized; a send or a new load snaps back to
 *    the renderer's layout)
 *
 * No dependencies. Styles are isolated in shadow DOM; theme via CSS custom
 * properties on the host element (--mmx-accent, --mmx-select, ...).
 * Serialization targets the flowchart subset; labels are normalized
 * (newlines to spaces, '"' -> "'", '|' dropped in edge labels). Feed it
 * trusted SVG only (mmx render output) — the svg string is injected as-is.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MmxEditor = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DEFAULT_STRINGS = {
    addNode: "+ node",
    send: "Send",
    sendWithCount: function (n) { return "Send (" + n + ")"; },
    revert: "Revert",
    autoLayout: "auto layout",
    fitView: "fit",
    notePlaceholder: "Say a word (recorded as --note)",
    menuEdit: "✎ edit",
    menuDelete: "✕ delete",
    menuLabel: "label",
    apply: "✓",
    label: "label",
    pendingOps: function (n) { return n + " pending operation(s)"; },
    // What a send would carry, by kind; shown in the status line so a missing
    // edge (e.g. a drop that missed its target) is visible before sending.
    pendingDetail: function (c) {
      var parts = [];
      if (c.nodesAdded) parts.push("+" + c.nodesAdded + " node" + (c.nodesAdded === 1 ? "" : "s"));
      if (c.edgesAdded) parts.push("+" + c.edgesAdded + " connection" + (c.edgesAdded === 1 ? "" : "s"));
      if (c.renamed) parts.push(c.renamed + " renamed");
      if (c.relabeled) parts.push(c.relabeled + " label" + (c.relabeled === 1 ? "" : "s") + " changed");
      if (c.deleted) parts.push(c.deleted + " deleted");
      return "Pending: " + parts.join(" · ");
    },
    idle: "Click a node or an arrow; drag the ● handle to connect; drag a node to rearrange (temporary)",
    manualMode: "Moved nodes are placed temporarily — send or a new turn snaps back to auto layout",
    connected: function (a, b) { return a + " → " + b + " connected"; },
    deleted: function (id) { return id + " deleted — click again to undo"; },
    nothingToSend: "Nothing changed yet",
    staged: "(unplaced)",
    newNodeLabel: "new node",
  };

  var CSS = "\n" +
    ":host{all:initial;display:block;font-family:-apple-system,'Apple SD Gothic Neo','Noto Sans KR',sans-serif;font-size:14px;line-height:1.5;color:var(--mmx-ink,#23272E);}\n" +
    "*{box-sizing:border-box;}\n" +
    ".stage{background:var(--mmx-canvas,#FFFFFF);border:1px solid var(--mmx-border,#E5E2DB);border-radius:10px;padding:8px;}\n" +
    ".viewport{position:relative;height:var(--mmx-height,clamp(360px,60vh,640px));overflow:hidden;border-radius:6px;touch-action:none;}\n" +
    ".viewport.panning{cursor:grabbing;}\n" +
    ".svgbox{position:absolute;left:0;top:0;width:fit-content;transform-origin:0 0;}\n" +
    ".svgbox svg{display:block;max-width:100%;height:auto;}\n" +
    ".hit{position:absolute;border:1.5px dashed transparent;border-radius:8px;cursor:grab;display:flex;align-items:center;justify-content:center;text-align:center;font-size:12.5px;line-height:1.3;padding:2px;color:#23272E;user-select:none;}\n" +
    ".hit:hover{border-color:var(--mmx-select,#2563EB);}\n" +
    ".hit.selected{border-style:solid;border-color:var(--mmx-select,#2563EB);}\n" +
    ".hit.modified,.hit.moved{background:#FFFFFF;border:1.5px solid var(--mmx-accent,#B04A17);}\n" +
    ".hit.deleted{background:rgba(120,120,120,.75);border:1.5px solid #888;color:#fff;text-decoration:line-through;}\n" +
    ".hit.dragging{cursor:grabbing;opacity:.85;z-index:25;}\n" +
    ".ghost{position:absolute;border-radius:8px;background:var(--mmx-canvas,#FFFFFF);opacity:.82;z-index:5;}\n" +
    ".handle{position:absolute;width:14px;height:14px;border-radius:50%;background:var(--mmx-accent,#B04A17);border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.3);cursor:crosshair;z-index:28;}\n" +
    ".menu{position:absolute;z-index:31;display:flex;gap:2px;background:var(--mmx-surface,#FFFFFF);border:1px solid var(--mmx-border,#E5E2DB);border-radius:8px;padding:3px 4px;box-shadow:0 2px 10px rgba(0,0,0,.15);}\n" +
    ".menu button{background:transparent;color:var(--mmx-ink,#23272E);border:none;padding:4px 10px;font-size:12.5px;border-radius:6px;cursor:pointer;white-space:nowrap;font-weight:500;font-family:inherit;}\n" +
    ".menu button:hover{background:rgba(127,127,127,.15);}\n" +
    ".menu button.danger{color:#C0392B;}\n" +
    ".menu input{width:110px;border:1px solid var(--mmx-border,#E5E2DB);border-radius:6px;padding:3px 7px;font-size:12.5px;background:var(--mmx-surface,#FFFFFF);color:var(--mmx-ink,#23272E);font-family:inherit;}\n" +
    ".inline{position:absolute;z-index:30;border:2px solid var(--mmx-select,#2563EB);border-radius:8px;background:#FFFFFF;color:#23272E;font-size:12.5px;text-align:center;padding:2px 4px;outline:none;font-family:inherit;}\n" +
    ".staging{position:relative;display:flex;gap:10px;flex-wrap:wrap;margin-top:12px;justify-content:center;}\n" +
    ".snode{position:relative;border:1.5px dashed var(--mmx-accent,#B04A17);border-radius:8px;background:#FFFFFF;color:#23272E;padding:8px 16px;font-size:12.5px;cursor:pointer;min-width:70px;text-align:center;user-select:none;}\n" +
    ".snode.selected{border-style:solid;border-color:var(--mmx-select,#2563EB);}\n" +
    ".toolbar{position:absolute;left:10px;top:10px;z-index:32;display:flex;gap:4px;background:var(--mmx-surface,#FFFFFF);border:1px solid var(--mmx-border,#E5E2DB);border-radius:8px;padding:3px 4px;box-shadow:0 1px 6px rgba(0,0,0,.08);}\n" +
    ".toolbar button{background:transparent;color:var(--mmx-ink,#23272E);border:none;padding:4px 10px;font-size:12.5px;border-radius:6px;cursor:pointer;white-space:nowrap;font-family:inherit;}\n" +
    ".toolbar button:hover:not(:disabled){background:rgba(127,127,127,.15);}\n" +
    ".toolbar button:disabled{opacity:.4;cursor:default;}\n" +
    ".toolbar button[hidden]{display:none;}\n" +
    ".bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px;}\n" +
    ".bar input{flex:1;min-width:160px;background:var(--mmx-surface,#FFFFFF);color:var(--mmx-ink,#23272E);border:1px solid var(--mmx-border,#E5E2DB);border-radius:8px;padding:9px 12px;font-size:14px;font-family:inherit;}\n" +
    ".bar button{background:var(--mmx-accent,#B04A17);color:#fff;border:none;border-radius:8px;padding:9px 18px;font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit;}\n" +
    ".bar button.ghost{background:transparent;color:var(--mmx-ink,#23272E);border:1px solid var(--mmx-border,#E5E2DB);font-weight:400;}\n" +
    ".bar button[hidden]{display:none;}\n" +
    ".bar button:disabled{opacity:.45;cursor:not-allowed;}\n" +
    ".status{font-size:13px;color:var(--mmx-muted,#6E6A63);min-height:1.2em;margin-top:6px;}\n";

  function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }

  // ---- source patching ----
  // Edits are applied to the confirmed source text instead of regenerating
  // it, so everything the editor does not model — comments, subgraphs,
  // dashed/thick arrows, classDef/style, line order — survives a turn.
  // Statements are parsed just enough to locate nodes and links; anything
  // that cannot be located safely makes patchSource throw, and the caller
  // falls back to full serialization (flagged lossy).
  var KEYWORD_RE = /^(flowchart|graph|subgraph|end|classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/;
  var ARROWISH_RE = /--|==|-\.|~~~/;
  var ID_RE = /[\w\u0080-￿]+(?:[-.](?=[\w\u0080-￿])[\w\u0080-￿]+)*/y;
  var CLS_RE = /:::[\w-]+/y;
  var AMP_RE = /\s*&\s*/y;
  var TEXT_LINKS = [
    { re: /(\s*)(<?)--\s+([^|]*?)\s+(-{2,}[>ox]?)(\s*)/y, type: "normal" },
    { re: /(\s*)(<?)-\.\s+([^|]*?)\s+(\.-+[>ox]?)(\s*)/y, type: "dotted" },
    { re: /(\s*)(<?)==\s+([^|]*?)\s+(={2,}[>ox]?)(\s*)/y, type: "thick" },
  ];
  var PLAIN_LINK = /(\s*)(<?)(-{2,}[>ox]?|-\.+-[>ox]?|={2,}[>ox]?|~{3,})(\s*)(?:\|([^|]*)\|(\s*))?/y;

  function PatchFail(why) { this.why = why; }

  function plainArrow(type, open, lt) {
    var core = type === "dotted" ? (open ? "-.-" : "-.->")
      : type === "thick" ? (open ? "===" : "==>")
      : type === "invisible" ? "~~~"
      : (open ? "---" : "-->");
    return (lt || "") + core;
  }
  function linkType(core) {
    if (core.charAt(0) === "~") return "invisible";
    if (core.charAt(0) === "=") return "thick";
    if (core.charAt(1) === ".") return "dotted";
    return "normal";
  }

  function scanShape(s, i) {
    var c = s.charAt(i);
    if ("([{>".indexOf(c) < 0) return null;
    var stack = [], j = i;
    for (; j < s.length; j++) {
      var ch = s.charAt(j);
      if (ch === '"') {
        var q = s.indexOf('"', j + 1);
        if (q < 0) return null;
        j = q;
        continue;
      }
      if (j === i && ch === ">") { stack.push("]"); continue; }
      if (ch === "(") stack.push(")");
      else if (ch === "[") stack.push("]");
      else if (ch === "{") stack.push("}");
      else if (ch === ")" || ch === "]" || ch === "}") {
        if (stack.pop() !== ch) return null;
        if (!stack.length) break;
      }
    }
    if (j >= s.length) return null;
    var end = j + 1;
    var openLen = 0;
    while (openLen < 3 && "([{/\\>".indexOf(s.charAt(i + openLen)) >= 0) openLen++;
    var innerStart = i + openLen, innerEnd = end - openLen;
    if (innerEnd < innerStart) { innerStart = i + 1; innerEnd = end - 1; }
    var inner = s.slice(innerStart, innerEnd).trim();
    return {
      end: end, innerStart: innerStart, innerEnd: innerEnd,
      quoted: inner.length >= 2 && inner.charAt(0) === '"' && inner.charAt(inner.length - 1) === '"',
    };
  }

  function parseNode(s, p) {
    ID_RE.lastIndex = p;
    var m = ID_RE.exec(s);
    if (!m) return null;
    var node = { id: m[0], start: p, idEnd: p + m[0].length, end: p + m[0].length, shape: null };
    var sh = scanShape(s, node.end);
    if (sh) { node.shape = sh; node.end = sh.end; }
    CLS_RE.lastIndex = node.end;
    var c = CLS_RE.exec(s);
    if (c) node.end += c[0].length;
    return node;
  }
  function parseGroup(s, p) {
    var first = parseNode(s, p);
    if (!first) return null;
    var g = { nodes: [first], start: p, end: first.end };
    for (;;) {
      AMP_RE.lastIndex = g.end;
      var a = AMP_RE.exec(s);
      if (!a) break;
      var n = parseNode(s, g.end + a[0].length);
      if (!n) return null;
      g.nodes.push(n);
      g.end = n.end;
    }
    return g;
  }
  function parseLink(s, p) {
    for (var t = 0; t < TEXT_LINKS.length; t++) {
      var f = TEXT_LINKS[t];
      f.re.lastIndex = p;
      var m = f.re.exec(s);
      if (m) {
        return {
          start: p, end: p + m[0].length, lead: m[1], trail: m[5], lt: m[2],
          type: f.type, open: !/[>ox]$/.test(m[4]), label: m[3], pipe: false, core: null,
        };
      }
    }
    PLAIN_LINK.lastIndex = p;
    var pm = PLAIN_LINK.exec(s);
    if (!pm) return null;
    var hasPipe = pm[5] !== undefined;
    return {
      start: p, end: p + pm[0].length, lead: pm[1],
      trail: hasPipe ? pm[6] : pm[4], lt: pm[2],
      type: linkType(pm[3]), open: !/[>ox]$/.test(pm[3]),
      label: hasPipe ? pm[5] : null, pipe: hasPipe, core: pm[2] + pm[3],
      midWs: hasPipe ? pm[4] : "",
    };
  }
  function parseStatement(s, start, end) {
    var p = start;
    while (p < end && /\s/.test(s.charAt(p))) p++;
    var g = parseGroup(s, p);
    if (!g || g.end > end) return null;
    var st = { groups: [g], links: [] };
    for (;;) {
      var l = parseLink(s, g.end);
      if (!l || l.end > end) break;
      var g2 = parseGroup(s, l.end);
      if (!g2 || g2.end > end) return null;
      st.links.push(l);
      st.groups.push(g2);
      g = g2;
    }
    if (s.slice(g.end, end).trim() !== "") return null;
    return st;
  }
  // Split a line into ';'-separated statement ranges, outside quotes,
  // brackets and |edge labels|.
  function statementRanges(s) {
    var out = [], depth = 0, inPipe = false, start = 0;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === '"') { var q = s.indexOf('"', i + 1); if (q < 0) break; i = q; continue; }
      if (ch === "|") inPipe = !inPipe;
      else if (!inPipe && "([{".indexOf(ch) >= 0) depth++;
      else if (!inPipe && ")]}".indexOf(ch) >= 0) depth--;
      else if (ch === ";" && depth === 0 && !inPipe) { out.push([start, i]); start = i + 1; }
    }
    out.push([start, s.length]);
    return out;
  }

  function declOf(id, n) {
    var l = quoteLabel((n && n.label) || id);
    return (n && n.shape) === "Diamond" ? id + "{" + l + "}" : id + "[" + l + "]";
  }
  function fmtLabel(label, quoted) {
    var l = label.replace(/[\r\n]+/g, " ").trim();
    if (quoted) return '"' + l.replace(/"/g, "'") + '"';
    return /[\[\]{}()|"<>#;]/.test(l) ? '"' + l.replace(/"/g, "'") + '"' : l;
  }

  function patchSource(source, model) {
    var alive = function (id) { var n = model.nodes[id]; return n && !n.deleted; };
    var deletedNodes = {}, renamed = {}, fresh = [];
    Object.keys(model.nodes).forEach(function (id) {
      var n = model.nodes[id];
      if (n.fresh) { if (!n.deleted) fresh.push(id); return; }
      if (n.deleted) deletedNodes[id] = true;
      else if (n.modified) renamed[id] = n.label;
    });
    var delKeys = {}, relabel = {}, newEdges = [], edgeOps = false;
    model.edges.forEach(function (e) {
      if (e.pending) {
        if (!e.deleted && alive(e.from) && alive(e.to)) newEdges.push(e);
        return;
      }
      if (e.deleted) { delKeys[e.key] = true; edgeOps = true; }
      else if (e.labelChanged) { relabel[e.key] = e.label; edgeOps = true; }
    });
    var anyDeleted = Object.keys(deletedNodes).length > 0;
    if (!edgeOps && !anyDeleted && !Object.keys(renamed).length && !newEdges.length && !fresh.length) {
      return source;
    }

    var lines = source.split("\n");
    var front = lines[0] && lines[0].trim() === "---";
    var skip = {}; // front matter / comment lines
    var stmts = [], opaque = [], linkStyles = [];
    lines.forEach(function (line, li) {
      var t = line.trim();
      if (front) { skip[li] = true; if (li > 0 && t === "---") front = false; return; }
      if (!t || t.indexOf("%%") === 0) { skip[li] = true; return; }
      // Keywords are judged per ';' segment: `flowchart LR; A --> B` still
      // defines an edge that counts toward every later #k.
      statementRanges(line).forEach(function (r) {
        var seg = line.slice(r[0], r[1]).trim();
        if (!seg) return;
        if (KEYWORD_RE.test(seg)) {
          if (/^linkStyle\s/.test(seg) && !/^linkStyle\s+default\b/.test(seg)) linkStyles.push(seg);
          return;
        }
        var st = parseStatement(line, r[0], r[1]);
        if (st) { st.line = li; st.range = r; stmts.push(st); }
        else opaque.push(seg);
      });
    });
    if (edgeOps && opaque.some(function (t) { return ARROWISH_RE.test(t); })) {
      throw new PatchFail("unparsed statement may hold edges");
    }
    Object.keys(deletedNodes).concat(Object.keys(renamed)).forEach(function (id) {
      var re = new RegExp("(^|[^\\w\\u0080-\\uFFFF])" + id.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&") + "($|[^\\w\\u0080-\\uFFFF])");
      if (opaque.some(function (t) { return re.test(t); })) throw new PatchFail("node " + id + " in unparsed statement");
    });

    // Edge occurrences in source order give each link its model key, and
    // their global order is what `linkStyle <index>` refers to.
    var seenPair = {}, keyOf = new Map(), edgeOrder = [], invisibleLinks = false;
    stmts.forEach(function (st) {
      st.links.forEach(function (l, i) {
        // The renderer does not list `~~~` links as edges, so they take no
        // #k slot (and no model key).
        if (l.type === "invisible") { invisibleLinks = true; return; }
        var group = st.groups[i].nodes.length > 1 || st.groups[i + 1].nodes.length > 1;
        st.groups[i].nodes.forEach(function (a) {
          st.groups[i + 1].nodes.forEach(function (b) {
            var pk = a.id + "\u0000" + b.id;
            var k = seenPair[pk] || 0;
            seenPair[pk] = k + 1;
            var key = a.id + "->" + b.id + "#" + k;
            edgeOrder.push({ key: key, a: a.id, b: b.id });
            if (group && (delKeys[key] || key in relabel || deletedNodes[a.id] || deletedNodes[b.id])) {
              throw new PatchFail("grouped (&) edge " + key);
            }
            if (!group) keyOf.set(l, key);
          });
        });
      });
    });
    var known = {};
    keyOf.forEach(function (key) { known[key] = true; });

    // linkStyle indices shift when edges disappear: map old -> new.
    var linkIndexMap = null;
    var removesEdges = edgeOrder.some(function (e) {
      return delKeys[e.key] || deletedNodes[e.a] || deletedNodes[e.b];
    });
    if (removesEdges && linkStyles.length) {
      if (invisibleLinks || opaque.some(function (t) { return ARROWISH_RE.test(t); })) {
        throw new PatchFail("linkStyle indices with invisible or unparsed links");
      }
      linkIndexMap = {};
      var next = 0;
      edgeOrder.forEach(function (e, i) {
        if (!(delKeys[e.key] || deletedNodes[e.a] || deletedNodes[e.b])) linkIndexMap[i] = next++;
      });
    }
    Object.keys(delKeys).concat(Object.keys(relabel)).forEach(function (key) {
      if (!known[key]) throw new PatchFail("edge " + key + " not located");
    });

    // Where a renamed node's label lives: every shaped occurrence, else the
    // first bare one.
    var declSites = new Set();
    Object.keys(renamed).forEach(function (id) {
      var shaped = [], bare = null;
      stmts.forEach(function (st) {
        st.groups.forEach(function (g) {
          g.nodes.forEach(function (n) {
            if (n.id !== id) return;
            if (n.shape) shaped.push(n); else if (!bare) bare = n;
          });
        });
      });
      if (shaped.length) shaped.forEach(function (n) { declSites.add(n); });
      else if (bare) declSites.add(bare);
      else throw new PatchFail("node " + id + " not located");
    });

    function nodeText(line, n) {
      if (!declSites.has(n)) return line.slice(n.start, n.end);
      var label = renamed[n.id];
      if (n.shape) {
        return line.slice(n.start, n.shape.innerStart) + fmtLabel(label, n.shape.quoted) +
          line.slice(n.shape.innerEnd, n.end);
      }
      return n.id + "[" + fmtLabel(label, false) + "]" + line.slice(n.idEnd, n.end);
    }
    function groupText(line, g) {
      var out = "", p = g.start;
      g.nodes.forEach(function (n) { out += line.slice(p, n.start) + nodeText(line, n); p = n.end; });
      return out;
    }
    function linkText(line, l) {
      var key = keyOf.get(l);
      if (!key || !(key in relabel)) return line.slice(l.start, l.end);
      var lbl = relabel[key] ? edgeLabelText(relabel[key]) : "";
      var core = l.core || plainArrow(l.type, l.open, l.lt);
      return (l.lead || " ") + core + (lbl ? "|" + lbl + "|" : "") + (l.trail || " ");
    }

    // Rebuild touched statements: removed links split a chain into
    // fragments; a lone bare node fragment is dropped unless it is that
    // node's only remaining mention.
    var lineEdits = {}; // line -> [{range, texts[]}]
    var survivors = {}, bareCandidates = [];
    stmts.forEach(function (st) {
      var line = lines[st.line];
      var hasDeleted = false;
      st.groups.forEach(function (g) {
        g.nodes.forEach(function (n) {
          if (!deletedNodes[n.id]) return;
          hasDeleted = true;
          if (g.nodes.length > 1) throw new PatchFail("deleted node " + n.id + " inside & group");
        });
      });
      var removed = st.links.map(function (l, i) {
        var key = keyOf.get(l);
        var a = st.groups[i].nodes[0].id, b = st.groups[i + 1].nodes[0].id;
        return !!(key && delKeys[key]) || !!deletedNodes[a] || !!deletedNodes[b];
      });
      var frags = [], cur = [0];
      for (var i = 0; i < st.links.length; i++) {
        if (removed[i]) { frags.push(cur); cur = [i + 1]; } else cur.push(i + 1);
      }
      frags.push(cur);
      st.frags = frags.map(function (gs) {
        var text = "";
        gs.forEach(function (gi, j) {
          if (j > 0) text += linkText(line, st.links[gi - 1]);
          text += groupText(line, st.groups[gi]);
        });
        var f = { text: text, keep: true, ids: [] };
        gs.forEach(function (gi) { st.groups[gi].nodes.forEach(function (n) { f.ids.push(n.id); }); });
        if (gs.length === 1) {
          var n = st.groups[gs[0]].nodes[0];
          if (deletedNodes[n.id]) f.keep = false;
          else if (!n.shape && !declSites.has(n) && removed.some(Boolean)) {
            f.keep = false;
            f.bare = n.id;
            bareCandidates.push(f);
          }
        }
        return f;
      });
      st.changed = hasDeleted || removed.some(Boolean) ||
        st.links.some(function (l) { var k = keyOf.get(l); return k && k in relabel; }) ||
        st.groups.some(function (g) { return g.nodes.some(function (n) { return declSites.has(n); }); });
      st.frags.forEach(function (f) {
        if (f.keep) f.ids.forEach(function (id) { survivors[id] = true; });
      });
    });
    bareCandidates.forEach(function (f) {
      if (!survivors[f.bare] && alive(f.bare)) { f.keep = true; survivors[f.bare] = true; }
    });
    stmts.forEach(function (st) {
      if (!st.changed) return;
      (lineEdits[st.line] = lineEdits[st.line] || []).push({
        range: st.range,
        start: st.groups[0].start,
        end: st.groups[st.groups.length - 1].end,
        texts: st.frags.filter(function (f) { return f.keep; }).map(function (f) { return f.text; }),
      });
    });

    // Keyword segments a deletion touches: style/click of a deleted node go,
    // class lists are pruned, linkStyle indices follow the surviving edges.
    // Returns the new segment text, or null to drop it.
    function keywordSeg(seg) {
      var sm = /^(style|click)\s+(\S+)/.exec(seg);
      if (sm && deletedNodes[sm[2]]) return null;
      var cm = /^class\s+(\S+)(\s+.*)$/.exec(seg);
      if (cm && anyDeleted) {
        var ids = cm[1].split(","), left = ids.filter(function (id) { return !deletedNodes[id]; });
        if (!left.length) return null;
        if (left.length !== ids.length) return "class " + left.join(",") + cm[2];
      }
      var lm = /^linkStyle\s+(\d+(?:\s*,\s*\d+)*)(\s+.*)$/.exec(seg);
      if (lm && linkIndexMap) {
        var mapped = lm[1].split(",").map(function (i) { return linkIndexMap[+i.trim()]; })
          .filter(function (v) { return v !== undefined; });
        if (!mapped.length) return null;
        return "linkStyle " + mapped.join(",") + lm[2];
      }
      return seg;
    }

    var out = [];
    lines.forEach(function (line, li) {
      if (skip[li]) { out.push(line); return; }
      var edits = lineEdits[li] || [];
      var ranges = statementRanges(line).filter(function (r) { return line.slice(r[0], r[1]).trim(); });
      var indent = /^\s*/.exec(line)[0];
      var segs = [], changed = false;
      ranges.forEach(function (r) {
        var seg = line.slice(r[0], r[1]).trim();
        var ed = edits.filter(function (e) { return e.range[0] === r[0]; })[0];
        if (ed) { changed = true; segs.push({ texts: ed.texts, ed: ed }); return; }
        if (KEYWORD_RE.test(seg)) {
          var k = keywordSeg(seg);
          if (k !== seg) changed = true;
          if (k !== null) segs.push({ texts: [k] });
          return;
        }
        segs.push({ texts: [seg] });
      });
      if (!changed) { out.push(line); return; }
      if (ranges.length === 1 && segs.length === 1 && segs[0].ed && segs[0].texts.length === 1) {
        // In-place: everything around the statement stays byte-identical.
        var ed0 = segs[0].ed;
        out.push(line.slice(0, ed0.start) + ed0.texts[0] + line.slice(ed0.end));
      } else if (ranges.length === 1) {
        segs.forEach(function (s) { s.texts.forEach(function (x) { out.push(indent + x.trim()); }); });
      } else {
        var parts = [];
        segs.forEach(function (s) { s.texts.forEach(function (x) { parts.push(x.trim()); }); });
        if (parts.length) out.push(indent + parts.join("; "));
      }
    });

    var declared = {};
    function ref(id) {
      var n = model.nodes[id];
      if (n && n.fresh && !declared[id]) { declared[id] = true; return declOf(id, n); }
      return id;
    }
    var tail = [];
    newEdges.forEach(function (e) {
      var l = e.label ? edgeLabelText(e.label) : "";
      tail.push("    " + ref(e.from) + " " + (l ? "-->|" + l + "|" : "-->") + " " + ref(e.to));
    });
    fresh.forEach(function (id) { if (!declared[id]) tail.push("    " + declOf(id, model.nodes[id])); });
    if (tail.length) {
      while (out.length && out[out.length - 1] === "") out.pop();
      out = out.concat(tail);
      out.push("");
    }
    return out.join("\n");
  }

  function quoteLabel(l) {
    l = l.replace(/[\r\n]+/g, " ").trim();
    return /[\[\]{}()|"<>#;]/.test(l) ? '"' + l.replace(/"/g, "'") + '"' : l;
  }
  function edgeLabelText(l) {
    // '|' and newlines would change the mermaid parse; drop them.
    return l.replace(/[|\r\n]+/g, " ").trim();
  }

  function mount(container, opts) {
    opts = opts || {};
    var S = Object.assign({}, DEFAULT_STRINGS, opts.strings || {});
    var host = document.createElement("div");
    container.appendChild(host);
    var shadow = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    var style = document.createElement("style");
    style.textContent = CSS;
    shadow.appendChild(style);

    var rootEl = document.createElement("div");
    rootEl.innerHTML =
      '<div class="stage">' +
      '  <div class="viewport">' +
      '    <div class="svgbox"><div class="svgslot"></div></div>' +
      '    <div class="toolbar">' +
      '      <button class="addnode" type="button"></button>' +
      '      <button class="fit" type="button"></button>' +
      '      <button class="autolayout" type="button" hidden></button>' +
      '      <button class="revert" type="button"></button>' +
      "    </div>" +
      "  </div>" +
      '  <div class="staging"></div>' +
      "</div>" +
      '<div class="bar">' +
      '  <input class="note" type="text">' +
      '  <button class="send" type="button"></button>' +
      "</div>" +
      '<div class="status"></div>';
    shadow.appendChild(rootEl);

    var viewport = rootEl.querySelector(".viewport");
    var svgbox = rootEl.querySelector(".svgbox");
    var svgslot = rootEl.querySelector(".svgslot");
    var staging = rootEl.querySelector(".staging");
    var noteEl = rootEl.querySelector(".note");
    var statusEl = rootEl.querySelector(".status");
    var autoBtn = rootEl.querySelector(".autolayout");
    var sendBtn = rootEl.querySelector(".send");
    var fitBtn = rootEl.querySelector(".fit");
    var revertBtn = rootEl.querySelector(".revert");
    var toolbar = rootEl.querySelector(".toolbar");
    rootEl.querySelector(".addnode").textContent = S.addNode;
    sendBtn.textContent = S.send;
    revertBtn.textContent = S.revert;
    autoBtn.textContent = S.autoLayout;
    fitBtn.textContent = S.fitView;
    noteEl.placeholder = S.notePlaceholder;
    // The toolbar sits inside the pannable viewport; its presses are its own.
    toolbar.addEventListener("pointerdown", function (ev) { ev.stopPropagation(); });
    toolbar.addEventListener("click", function (ev) { ev.stopPropagation(); });

    // model.nodes[id] = {label, shape, x?,y?,w?,h?, tx?,ty? (temp), deleted?, modified?, fresh?}
    // model.edges    = [{from, to, label, deleted?, pending?, labelChanged?, origLabel?}]
    var model = null, baseline = null, selected = null, destroyed = false;
    var manual = false; // true while any node sits on a temporary position
    var nodeVisuals = null; // id -> [svg elements] (classified lazily)
    var edgeInfos = null; // [{el, from, to, extras}] — svg edge groups + their labels/arrowheads
    var looseDecor = []; // decoration that matched no edge (left visible)
    var vz = 1, vx = 0, vy = 0; // camera: zoom + pan (CSS transform on svgbox)
    var camAuto = true; // false once the user pans or zooms; a fit resets it
    function applyView() {
      svgbox.style.transform = "translate(" + vx + "px," + vy + "px) scale(" + vz + ")";
    }
    function fitView() {
      // Scale down (never up) so the whole diagram is visible, centered.
      camAuto = true;
      var w = svgbox.offsetWidth, h = svgbox.offsetHeight;
      var vw = viewport.clientWidth, vh = viewport.clientHeight;
      if (!w || !h || !vw || !vh) { vz = 1; vx = 8; vy = 12; applyView(); return; }
      vz = Math.max(Math.min(1, (vw - 24) / w, (vh - 24) / h), 0.05);
      vx = Math.max((vw - w * vz) / 2, 12);
      vy = Math.max((vh - h * vz) / 2, 12);
      applyView();
    }

    function setStatus(m) { statusEl.textContent = m || ""; }
    function opsDetail() {
      var c = { nodesAdded: 0, edgesAdded: 0, renamed: 0, relabeled: 0, deleted: 0 };
      if (!model) return c;
      Object.keys(model.nodes).forEach(function (id) {
        var d = model.nodes[id];
        if (d.fresh) c.nodesAdded++;
        else if (d.deleted) c.deleted++;
        else if (d.modified) c.renamed++;
      });
      model.edges.forEach(function (e) {
        if (e.pending && !e.deleted) c.edgesAdded++;
        else if (!e.pending && e.deleted) c.deleted++;
        else if (e.labelChanged) c.relabeled++;
      });
      return c;
    }
    function idleStatus() {
      var n = opsCount();
      var pending = n > 0 ? (S.pendingDetail ? S.pendingDetail(opsDetail(), n) : S.pendingOps(n)) : null;
      setStatus(manual ? (pending ? S.manualMode + " — " + pending : S.manualMode) : (pending || S.idle));
      updateSendState();
    }

    function opsCount() {
      if (!model) return 0;
      var n = 0;
      Object.keys(model.nodes).forEach(function (id) {
        var d = model.nodes[id];
        if (d.deleted || d.modified || d.fresh) n++;
      });
      model.edges.forEach(function (e) { if (e.deleted || e.pending || e.labelChanged) n++; });
      return n;
    }
    function updateSendState() {
      // A note alone is a valid turn (a question to the counterpart), so
      // send is disabled only when there is neither a change nor a note.
      var n = opsCount();
      var hasNote = noteEl.value.trim().length > 0;
      sendBtn.disabled = n === 0 && !hasNote;
      sendBtn.title = sendBtn.disabled ? S.nothingToSend : "";
      sendBtn.textContent = n > 0 ? S.sendWithCount(n) : S.send;
      revertBtn.disabled = n === 0 && !manual;
    }
    // The text a send would produce: the confirmed source patched with the
    // pending operations; full serialization only when patching cannot
    // locate something (lossy: formatting outside the model may be lost).
    function currentSource() {
      if (!model) return { source: "", lossy: false };
      if (!baseline || !baseline.source) return { source: serialize(), lossy: true };
      try {
        return { source: patchSource(baseline.source, model), lossy: false };
      } catch (e) {
        if (!(e instanceof PatchFail)) throw e;
        return { source: serialize(), lossy: true, why: e.why };
      }
    }
    function announce() {
      idleStatus();
      if (opts.onChange) {
        var cur = currentSource();
        opts.onChange({ source: cur.source, ops: opsCount(), lossy: cur.lossy });
      }
    }

    // ---- serialization ----
    function alive(id) { var n = model.nodes[id]; return n && !n.deleted; }
    function decl(id) {
      var n = model.nodes[id], l = quoteLabel((n && n.label) || id);
      return (n && n.shape) === "Diamond" ? id + "{" + l + "}" : id + "[" + l + "]";
    }
    function serialize() {
      if (!model) return "";
      var lines = ["flowchart " + (model.dir || "TD")], seen = {};
      function ref(id) { if (seen[id]) return id; seen[id] = true; return decl(id); }
      model.edges.forEach(function (e) {
        if (e.deleted || !alive(e.from) || !alive(e.to)) return;
        var l = e.label ? edgeLabelText(e.label) : "";
        lines.push("    " + ref(e.from) + " " + (l ? "-->|" + l + "|" : "-->") + " " + ref(e.to));
      });
      Object.keys(model.nodes).forEach(function (id) {
        if (alive(id) && !seen[id]) lines.push("    " + decl(id));
      });
      return lines.join("\n") + "\n";
    }

    // ---- geometry ----
    function scaleOf() {
      var svg = svgslot.querySelector("svg");
      if (!svg || !svg.viewBox || !svg.viewBox.baseVal.width) return null;
      return svg.clientWidth / svg.viewBox.baseVal.width;
    }
    function nodeBox(id) {
      // display-space box {l,t,w,h} or null (staged node handled separately)
      var n = model.nodes[id], s = scaleOf();
      if (!n || typeof n.x !== "number" || !s) return null;
      var l = typeof n.tx === "number" ? n.tx : n.x * s;
      var t = typeof n.ty === "number" ? n.ty : n.y * s;
      return { l: l, t: t, w: n.w * s, h: n.h * s };
    }
    function centerOf(id) {
      var b = nodeBox(id);
      if (b) return { x: b.l + b.w / 2, y: b.t + b.h / 2 };
      var el = staging.querySelector('[data-id="' + id + '"]');
      if (el) {
        var r = el.getBoundingClientRect(), br = svgbox.getBoundingClientRect();
        return { x: r.left - br.left + r.width / 2, y: r.top - br.top + r.height / 2 };
      }
      return null;
    }
    function boundsOf(id) {
      var shape = (model.nodes[id] && model.nodes[id].shape) || "Rectangle";
      var b = nodeBox(id);
      if (b) return { cx: b.l + b.w / 2, cy: b.t + b.h / 2, hw: b.w / 2, hh: b.h / 2, shape: shape };
      var el = staging.querySelector('[data-id="' + id + '"]');
      if (el) {
        var r = el.getBoundingClientRect(), br = svgbox.getBoundingClientRect();
        var w = r.width / vz, h = r.height / vz;
        return { cx: (r.left - br.left) / vz + w / 2, cy: (r.top - br.top) / vz + h / 2, hw: w / 2, hh: h / 2, shape: "Rectangle" };
      }
      return null;
    }
    // Trim a center-to-center segment so it starts and ends on the node
    // rectangles' borders instead of plunging into the bodies.
    function exitT(bounds, dx, dy) {
      var ax = Math.abs(dx), ay = Math.abs(dy);
      if (!ax && !ay) return 0;
      var sh = bounds.shape || "Rectangle";
      if (sh === "Diamond") {
        // rhombus |x|/hw + |y|/hh = 1
        return 1 / (ax / bounds.hw + ay / bounds.hh);
      }
      if (sh === "Circle" || sh === "Ellipse" || sh === "Stadium" || sh === "Round") {
        // ellipse (x/hw)^2 + (y/hh)^2 = 1
        return 1 / Math.sqrt((ax * ax) / (bounds.hw * bounds.hw) + (ay * ay) / (bounds.hh * bounds.hh));
      }
      var tx = ax ? bounds.hw / ax : Infinity;
      var ty = ay ? bounds.hh / ay : Infinity;
      return Math.min(tx, ty);
    }
    function clipSegment(A, B) {
      var dx = B.cx - A.cx, dy = B.cy - A.cy;
      if (!dx && !dy) return null;
      var tA = exitT(A, dx, dy), tB = exitT(B, dx, dy);
      if (tA + tB >= 1) return { x1: A.cx, y1: A.cy, x2: B.cx, y2: B.cy }; // overlapping nodes
      return {
        x1: A.cx + dx * tA, y1: A.cy + dy * tA,
        x2: B.cx - dx * tB, y2: B.cy - dy * tB,
      };
    }
    function boxRectOf(id) {
      var el = svgbox.querySelector('.hit[data-id="' + id + '"]');
      if (el) return { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight, host: svgbox };
      var s = staging.querySelector('[data-id="' + id + '"]');
      if (s) return { left: s.offsetLeft, top: s.offsetTop, width: s.offsetWidth, height: s.offsetHeight, host: staging };
      return null;
    }
    function localPoint(ev) {
      var r = svgbox.getBoundingClientRect();
      return { x: (ev.clientX - r.left) / vz, y: (ev.clientY - r.top) / vz };
    }
    function nodeAtPoint(p) {
      var found = null;
      Object.keys(model.nodes).forEach(function (id) {
        if (!alive(id)) return;
        var b = nodeBox(id);
        if (b && p.x >= b.l && p.x <= b.l + b.w && p.y >= b.t && p.y <= b.t + b.h) found = id;
      });
      return found;
    }

    // ---- edge hit targets on the raw SVG (normal mode) ----
    // mmdr marks edge groups with data-edge-id; we identify the logical edge
    // by matching the path's endpoints to node boxes (order in the SVG is not
    // a documented contract, geometry is).
    function logicalEdgeForElement(el) {
      var path = el.tagName === "path" ? el : el.querySelector("path");
      if (!path || !path.getTotalLength) return null;
      var s = scaleOf();
      if (!s) return null;
      var svg = svgslot.querySelector("svg");
      var toDisplay = function (pt) { return { x: pt.x * s, y: pt.y * s }; };
      var a, b;
      try {
        a = toDisplay(path.getPointAtLength(0));
        b = toDisplay(path.getPointAtLength(path.getTotalLength()));
      } catch (e) { return null; }
      function nearNode(p) {
        var best = null, bestD = 1e9;
        Object.keys(model.nodes).forEach(function (id) {
          var n = model.nodes[id];
          if (typeof n.x !== "number") return;
          var cx = (n.x + n.w / 2) * s, cy = (n.y + n.h / 2) * s;
          var dx = Math.max(Math.abs(p.x - cx) - (n.w * s) / 2, 0);
          var dy = Math.max(Math.abs(p.y - cy) - (n.h * s) / 2, 0);
          var d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; best = id; }
        });
        return bestD < 400 ? best : null; // within ~20px of a node border
      }
      var from = nearNode(a), to = nearNode(b);
      if (!from || !to) return null;
      var candidates = model.edges.filter(function (e) {
        return !e.pending && ((e.from === from && e.to === to) || (e.from === to && e.to === from));
      });
      if (!candidates.length) return null;
      var exact = candidates.filter(function (e) { return e.from === from && e.to === to; });
      return (exact[0] || candidates[0]);
    }
    function wireSvgEdgeTargets() {
      var svg = svgslot.querySelector("svg");
      if (!svg) return;
      svg.querySelectorAll("[data-edge-id]").forEach(function (el) {
        el.style.cursor = "pointer";
        el.style.pointerEvents = "auto";
        el.addEventListener("click", function (ev) {
          if (el.style.opacity === "0") return; // replaced by an overlay line
          ev.stopPropagation();
          var e = logicalEdgeForElement(el);
          if (!e) return;
          var p = localPoint(ev);
          openEdgeMenu(e, p.x, p.y);
        });
      });
    }
    // Assign the SVG's own drawing elements to nodes by geometry, so a drag
    // can move the real node visuals (mmdr marks edges with data-edge-id and
    // edge labels with data-label-kind; everything else inside a node's box
    // belongs to that node).
    function classifyNodeVisuals() {
      nodeVisuals = {};
      edgeInfos = [];
      looseDecor = [];
      var svg = svgslot.querySelector("svg");
      if (!svg || !model || !svg.viewBox || !svg.viewBox.baseVal.width) return;
      var vbW = svg.viewBox.baseVal.width, vbH = svg.viewBox.baseVal.height;
      var svgR = svg.getBoundingClientRect();
      if (!svgR.width) return;
      // Measure in screen space and convert back to viewBox units, so
      // elements positioned via their own transform (mmdr's arrowhead <g>
      // wrappers) are located correctly.
      var kx = vbW / svgR.width, ky = vbH / svgR.height;
      var decor = []; // small standalone polygons (arrowheads) — assigned to edges below
      Array.prototype.forEach.call(svg.children, function (el) {
        if (el.tagName === "defs") return;
        if (el.hasAttribute("data-edge-id") || el.hasAttribute("data-label-kind")) return;
        if (el.querySelector && el.querySelector("[data-edge-id],[data-label-kind]")) return; // edge container
        var r = el.getBoundingClientRect();
        if (!r.width && !r.height) return;
        var bw = r.width * kx, bh = r.height * ky;
        var cx = (r.left - svgR.left) * kx + bw / 2;
        var cy = (r.top - svgR.top) * ky + bh / 2;
        if (bw > vbW * 0.9 && bh > vbH * 0.9) return; // background
        // Arrowheads: small standalone polygons/paths (often in a <g>
        // wrapper) without mmdr's data-edge-id marker — edge decoration,
        // never node visuals.
        if (bw <= 24 && bh <= 24) { decor.push({ el: el, x: cx, y: cy }); return; }
        for (var id in model.nodes) {
          var n = model.nodes[id];
          if (typeof n.x !== "number") continue;
          if (cx >= n.x - 1 && cx <= n.x + n.w + 1 && cy >= n.y - 1 && cy <= n.y + n.h + 1) {
            (nodeVisuals[id] = nodeVisuals[id] || []).push(el);
            return;
          }
        }
      });
      // Edge groups: endpoints in viewBox units name the incident nodes, so a
      // drag can hide exactly the edges touching moved nodes and keep the
      // rest of the real rendering intact.
      function nodeNear(p) {
        var best = null, bestD = 400; // within ~20 viewBox units of a border
        for (var id in model.nodes) {
          var n = model.nodes[id];
          if (typeof n.x !== "number") continue;
          var dx = Math.max(Math.abs(p.x - (n.x + n.w / 2)) - n.w / 2, 0);
          var dy = Math.max(Math.abs(p.y - (n.y + n.h / 2)) - n.h / 2, 0);
          var d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; best = id; }
        }
        return best;
      }
      // Label parts (rect + text group) carry the same data-edge-id as
      // their edge path; collect them as that edge's extras directly.
      var infoById = {};
      svg.querySelectorAll("[data-edge-id]").forEach(function (el) {
        if (el.hasAttribute("data-label-kind")) return; // attached below
        var path = el.tagName === "path" ? el : el.querySelector("path");
        var info = { el: el, from: null, to: null, a: null, b: null, mid: null, extras: [] };
        if (path && path.getTotalLength) {
          try {
            var len = path.getTotalLength();
            info.a = path.getPointAtLength(0);
            info.b = path.getPointAtLength(len);
            info.mid = path.getPointAtLength(len / 2);
            info.from = nodeNear(info.a);
            info.to = nodeNear(info.b);
          } catch (e) { /* detached or zero-length path */ }
        }
        var eid = el.getAttribute("data-edge-id");
        if (eid && !infoById[eid]) infoById[eid] = info;
        edgeInfos.push(info);
      });
      function nearestEdge(x, y, pts) {
        var best = null, bestD = Infinity;
        edgeInfos.forEach(function (info) {
          pts(info).forEach(function (p) {
            if (!p) return;
            var dx = p.x - x, dy = p.y - y, d = dx * dx + dy * dy;
            if (d < bestD) { bestD = d; best = info; }
          });
        });
        return bestD <= 2500 ? best : null; // within 50 viewBox units
      }
      // Edge labels: shared data-edge-id names the owner; fall back to the
      // nearest path midpoint when the marker is missing.
      svg.querySelectorAll("[data-label-kind]").forEach(function (el) {
        var eid = el.getAttribute("data-edge-id");
        if (eid && infoById[eid]) { infoById[eid].extras.push(el); return; }
        var r = el.getBoundingClientRect();
        if (!r.width && !r.height) return;
        var x = (r.left - svgR.left) * kx + (r.width * kx) / 2;
        var y = (r.top - svgR.top) * ky + (r.height * ky) / 2;
        var owner = nearestEdge(x, y, function (i) { return [i.mid]; });
        if (owner) owner.extras.push(el);
        else looseDecor.push(el);
      });
      // Arrowheads sit on an edge endpoint.
      decor.forEach(function (d) {
        var owner = nearestEdge(d.x, d.y, function (i) { return [i.a, i.b]; });
        if (owner) owner.extras.push(d.el);
        else looseDecor.push(d.el);
      });
    }
    function moveNodeVisuals(id) {
      if (!nodeVisuals) classifyNodeVisuals();
      var n = model.nodes[id], sc = scaleOf();
      if (!sc) return;
      var els = (nodeVisuals && nodeVisuals[id]) || [];
      var dx = (typeof n.tx === "number") ? (n.tx / sc - n.x) : 0;
      var dy = (typeof n.ty === "number") ? (n.ty / sc - n.y) : 0;
      els.forEach(function (el) {
        if (dx || dy) el.setAttribute("transform", "translate(" + dx + " " + dy + ")");
        else el.removeAttribute("transform");
      });
    }
    function clearNodeTransforms() {
      if (!nodeVisuals) return;
      for (var id in nodeVisuals) nodeVisuals[id].forEach(function (el) { el.removeAttribute("transform"); });
    }
    function movedNodes() {
      var moved = {};
      if (!model) return moved;
      Object.keys(model.nodes).forEach(function (id) {
        var n = model.nodes[id];
        if (typeof n.tx === "number" || typeof n.ty === "number" || n.deleted) moved[id] = true;
      });
      return moved;
    }
    // Hide only the svg edges that touch a moved (or deleted) node; the rest
    // of the real rendering — curves, labels, arrowheads — stays visible.
    function updateEdgeVisibility() {
      if (!edgeInfos) classifyNodeVisuals();
      var moved = manual ? movedNodes() : {};
      var deleted = {};
      if (model) {
        Object.keys(model.nodes).forEach(function (id) {
          if (model.nodes[id].deleted) deleted[id] = true;
        });
      }
      (edgeInfos || []).forEach(function (info) {
        var hide =
          (manual && (info.from === null || info.to === null || moved[info.from] || moved[info.to])) ||
          deleted[info.from] || deleted[info.to];
        var op = hide ? "0" : "";
        info.el.style.opacity = op;
        info.extras.forEach(function (el) { el.style.opacity = op; });
      });
    }

    // ---- overlay rendering ----
    function clearFloat() {
      rootEl.querySelectorAll(".inline,.menu").forEach(function (e) { e.remove(); });
    }
    function render() {
      clearFloat();
      svgbox.querySelectorAll(".hit,.ghost,.handle,.overlaylines").forEach(function (e) { e.remove(); });
      staging.innerHTML = "";
      if (!model) return;
      Object.keys(model.nodes).forEach(function (id) {
        var n = model.nodes[id];
        var b = nodeBox(id);
        if (b) {
          var d = document.createElement("div");
          d.className = "hit" + (n.deleted ? " deleted" : n.modified ? " modified" : "") +
            (id === selected ? " selected" : "");
          d.style.left = b.l + "px"; d.style.top = b.t + "px";
          d.style.width = b.w + "px"; d.style.height = b.h + "px";
          d.dataset.id = id; d.title = id;
          if (n.modified || n.deleted) d.textContent = n.label || id;
          wireNodePointer(d, id);
          svgbox.appendChild(d);
        } else {
          var sn = document.createElement("div");
          sn.className = "snode" + (id === selected ? " selected" : "");
          sn.dataset.id = id;
          sn.textContent = (n.label || id) + (n.deleted ? " ✕" : "");
          wireNodePointer(sn, id);
          staging.appendChild(sn);
        }
      });
      drawOverlayEdges();
    }

    function overlayEdgeList() {
      var moved = manual ? movedNodes() : {};
      return model.edges.filter(function (e) {
        if (e.deleted || !alive(e.from) || !alive(e.to)) return false;
        return e.pending || moved[e.from] || moved[e.to];
      });
    }
    function drawOverlayEdges() {
      var old = svgbox.querySelector(".overlaylines");
      if (old) old.remove();
      updateEdgeVisibility();
      var list = overlayEdgeList();
      if (!list.length) return;
      var NS = "http://www.w3.org/2000/svg";
      var ov = document.createElementNS(NS, "svg");
      ov.setAttribute("class", "overlaylines");
      ov.setAttribute("width", svgbox.offsetWidth);
      ov.setAttribute("height", svgbox.scrollHeight || svgbox.offsetHeight);
      ov.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:20;overflow:visible";
      var accent = getComputedStyle(container).getPropertyValue("--mmx-accent").trim() || "#B04A17";
      var ink = manual ? "#5B6470" : accent;
      var mid = "mmxarrow" + Math.floor(Math.random() * 1e9);
      var defs = document.createElementNS(NS, "defs");
      defs.innerHTML =
        '<marker id="' + mid + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="' + ink + '"/></marker>' +
        '<marker id="' + mid + 'p" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="' + accent + '"/></marker>';
      ov.appendChild(defs);
      function wireEdgeClick(el, e) {
        el.style.pointerEvents = "stroke";
        el.style.cursor = "pointer";
        el.addEventListener("click", function (ev) {
          ev.stopPropagation();
          var p = localPoint(ev);
          openEdgeMenu(e, p.x, p.y);
        });
      }
      function edgeText(x, y, stroke, label) {
        var t = document.createElementNS(NS, "text");
        t.setAttribute("x", x); t.setAttribute("y", y);
        t.setAttribute("fill", stroke); t.setAttribute("font-size", "11");
        t.setAttribute("text-anchor", "middle");
        t.textContent = label;
        ov.appendChild(t);
      }
      // Parallel edges between the same pair get a perpendicular offset so
      // their overlay lines and labels do not coincide.
      var pairCount = {}, pairSeen = {};
      list.forEach(function (e) {
        var k = e.from + "\u0000" + e.to;
        pairCount[k] = (pairCount[k] || 0) + 1;
      });
      list.forEach(function (e) {
        var stroke = e.pending ? accent : ink;
        if (e.from === e.to) {
          // Self-loop: a small lobe on the node's right side (clipSegment
          // degenerates for identical endpoints).
          var N = boundsOf(e.from);
          if (!N) return;
          var x = N.cx + N.hw, y = N.cy;
          var lp = document.createElementNS(NS, "path");
          lp.setAttribute("d", "M " + x + " " + (y - 8) +
            " C " + (x + 36) + " " + (y - 28) + ", " + (x + 36) + " " + (y + 28) +
            ", " + (x + 1) + " " + (y + 8));
          lp.setAttribute("fill", "none");
          lp.setAttribute("stroke", stroke); lp.setAttribute("stroke-width", "2");
          if (e.pending) lp.setAttribute("stroke-dasharray", "6 4");
          lp.setAttribute("marker-end", "url(#" + mid + (e.pending ? "p" : "") + ")");
          wireEdgeClick(lp, e);
          ov.appendChild(lp);
          if (e.label) edgeText(x + 40, y + 4, stroke, e.label);
          return;
        }
        var A = boundsOf(e.from), B = boundsOf(e.to);
        if (!A || !B) return;
        var seg = clipSegment(A, B);
        if (!seg) return;
        var k = e.from + "\u0000" + e.to;
        var idx = pairSeen[k] || 0;
        pairSeen[k] = idx + 1;
        var n = pairCount[k];
        if (n > 1) {
          var ddx = seg.x2 - seg.x1, ddy = seg.y2 - seg.y1;
          var dl = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
          var off = (idx - (n - 1) / 2) * 12;
          var px = (-ddy / dl) * off, py = (ddx / dl) * off;
          seg.x1 += px; seg.y1 += py; seg.x2 += px; seg.y2 += py;
        }
        var ln = document.createElementNS(NS, "line");
        ln.setAttribute("x1", seg.x1); ln.setAttribute("y1", seg.y1);
        ln.setAttribute("x2", seg.x2); ln.setAttribute("y2", seg.y2);
        ln.setAttribute("stroke", stroke); ln.setAttribute("stroke-width", "2");
        if (e.pending) ln.setAttribute("stroke-dasharray", "6 4");
        ln.setAttribute("marker-end", "url(#" + mid + (e.pending ? "p" : "") + ")");
        wireEdgeClick(ln, e);
        ov.appendChild(ln);
        if (e.label) edgeText((seg.x1 + seg.x2) / 2, (seg.y1 + seg.y2) / 2 - 5, stroke, e.label);
      });
      svgbox.appendChild(ov);
    }

    // ---- pointer wiring: click menu / drag placement / handle connect ----
    var DRAG_MIN = 5;
    // Double-click detection is manual: a click re-renders the overlay, so
    // the browser never sees two clicks on the same element and native
    // dblclick does not fire on nodes.
    var lastClick = { id: null, t: 0 };
    function wireNodePointer(el, id) {
      el.addEventListener("pointerdown", function (ev) {
        if (ev.button !== 0) return;
        ev.stopPropagation();
        var start = { x: ev.clientX, y: ev.clientY };
        var startBox = nodeBox(id);
        var isPlaced = !!startBox;
        var moved = false;
        var pid = ev.pointerId;
        el.setPointerCapture && el.setPointerCapture(pid);
        function onMove(mv) {
          if (mv.pointerId !== pid) return;
          var dx = (mv.clientX - start.x) / vz, dy = (mv.clientY - start.y) / vz;
          if (!moved && Math.abs(dx) < DRAG_MIN && Math.abs(dy) < DRAG_MIN) return;
          if (!isPlaced) return; // staged nodes are not draggable
          if (!moved) {
            moved = true;
            clearFloat();
            if (!manual) { manual = true; autoBtn.hidden = false; drawOverlayEdges(); idleStatus(); }
            el.classList.add("dragging");
          }
          var n = model.nodes[id];
          n.tx = startBox.l + dx;
          n.ty = startBox.t + dy;
          el.style.left = n.tx + "px";
          el.style.top = n.ty + "px";
          moveNodeVisuals(id);
          drawOverlayEdges();
        }
        function onUp(uv) {
          if (uv.pointerId !== pid) return;
          document.removeEventListener("pointermove", onMove);
          document.removeEventListener("pointerup", onUp);
          el.classList.remove("dragging");
          if (moved) {
            nudgeClear(id);
            var nb = nodeBox(id);
            if (nb) { el.style.left = nb.l + "px"; el.style.top = nb.t + "px"; }
            moveNodeVisuals(id);
            drawOverlayEdges();
            if (handleEl) { handleEl.remove(); handleEl = null; }
          }
          if (moved || !alive(id)) {
            // A drag, or the undelete click on a dimmed node, never counts
            // toward a double-click.
            lastClick = { id: null, t: 0 };
            if (!moved) onNodeClick(id);
            return;
          }
          var now = Date.now();
          if (lastClick.id === id && now - lastClick.t < 400 && alive(id)) {
            lastClick = { id: null, t: 0 };
            selected = id;
            render();
            openInlineEditor(id);
          } else {
            lastClick = { id: id, t: now };
            onNodeClick(id);
          }
        }
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
      });
      el.addEventListener("pointerenter", function () { showHandle(id); });
    }

    // A dropped node that lands on a neighbor is pushed out along the axis
    // of least overlap, so placements never hide another node.
    var NUDGE_GAP = 8;
    function nudgeClear(id) {
      var n = model.nodes[id];
      for (var pass = 0; pass < 6; pass++) {
        var b = nodeBox(id);
        if (!b) return;
        var hit = null;
        Object.keys(model.nodes).forEach(function (oid) {
          if (hit || oid === id || !alive(oid)) return;
          var o = nodeBox(oid);
          if (!o) return;
          if (b.l < o.l + o.w + NUDGE_GAP && o.l < b.l + b.w + NUDGE_GAP &&
              b.t < o.t + o.h + NUDGE_GAP && o.t < b.t + b.h + NUDGE_GAP) hit = o;
        });
        if (!hit) return;
        var right = hit.l + hit.w + NUDGE_GAP - b.l, left = b.l + b.w + NUDGE_GAP - hit.l;
        var down = hit.t + hit.h + NUDGE_GAP - b.t, up = b.t + b.h + NUDGE_GAP - hit.t;
        var m = Math.min(right, left, down, up);
        n.tx = b.l + (m === right ? right : m === left ? -left : 0);
        n.ty = b.t + (m === down ? down : m === up ? -up : 0);
      }
    }

    var handleEl = null;
    function showHandle(id) {
      if (!alive(id)) return;
      var b = nodeBox(id);
      if (!b) return; // no connect handle on staged nodes (click-connect via menu could come later)
      if (handleEl) handleEl.remove();
      handleEl = document.createElement("div");
      handleEl.className = "handle";
      handleEl.style.left = b.l + b.w - 7 + "px";
      handleEl.style.top = b.t + b.h / 2 - 7 + "px";
      handleEl.title = "drag to connect";
      handleEl.addEventListener("pointerdown", function (ev) {
        if (ev.button !== 0) return;
        ev.stopPropagation(); ev.preventDefault();
        startConnectDrag(id, ev);
      });
      svgbox.appendChild(handleEl);
    }
    function startConnectDrag(fromId, ev) {
      clearFloat();
      var NS = "http://www.w3.org/2000/svg";
      var accent = getComputedStyle(container).getPropertyValue("--mmx-accent").trim() || "#B04A17";
      var band = document.createElementNS(NS, "svg");
      band.setAttribute("width", svgbox.offsetWidth);
      band.setAttribute("height", svgbox.scrollHeight || svgbox.offsetHeight);
      band.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:29;overflow:visible";
      var ln = document.createElementNS(NS, "line");
      var a = centerOf(fromId);
      var fromB = boundsOf(fromId);
      ln.setAttribute("x1", a.x); ln.setAttribute("y1", a.y);
      ln.setAttribute("x2", a.x); ln.setAttribute("y2", a.y);
      ln.setAttribute("stroke", accent); ln.setAttribute("stroke-width", "2");
      ln.setAttribute("stroke-dasharray", "6 4");
      band.appendChild(ln);
      svgbox.appendChild(band);
      var pid = ev.pointerId;
      function onMove(mv) {
        if (mv.pointerId !== pid) return;
        var p = localPoint(mv);
        if (fromB) {
          var seg = clipSegment(fromB, { cx: p.x, cy: p.y, hw: 0, hh: 0 });
          if (seg) { ln.setAttribute("x1", seg.x1); ln.setAttribute("y1", seg.y1); }
        }
        ln.setAttribute("x2", p.x); ln.setAttribute("y2", p.y);
      }
      function onUp(uv) {
        if (uv.pointerId !== pid) return;
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        band.remove();
        // Hit-test what is actually under the pointer first, so a freshly
        // added node (still in the staging row, without a layout box) can be
        // a connection target too.
        var target = null;
        var under = shadow.elementFromPoint ? shadow.elementFromPoint(uv.clientX, uv.clientY) : null;
        var hitEl = under && under.closest ? under.closest(".hit[data-id],.snode[data-id]") : null;
        if (hitEl && alive(hitEl.dataset.id)) target = hitEl.dataset.id;
        if (!target) target = nodeAtPoint(localPoint(uv));
        if (target && target !== fromId) {
          var e = { from: fromId, to: target, label: null, pending: true };
          model.edges.push(e);
          render(); announce();
          setStatus(S.connected(fromId, target));
          var c = centerOf(target);
          if (c) openEdgeMenu(e, c.x, c.y - 20, true);
        } else {
          render(); idleStatus();
        }
      }
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    }

    // ---- menus ----
    function onNodeClick(id) {
      var n = model.nodes[id];
      if (n.deleted) { delete n.deleted; selected = id; render(); announce(); return; }
      selected = id;
      render();
      var b = boxRectOf(id);
      if (!b) return;
      openNodeMenu(id, b);
    }
    function menuEl(x, y, hostEl) {
      clearFloat();
      var m = document.createElement("div");
      m.className = "menu";
      m.style.left = Math.max(x, 0) + "px";
      m.style.top = Math.max(y, 0) + "px";
      m.addEventListener("click", function (ev) { ev.stopPropagation(); });
      m.addEventListener("pointerdown", function (ev) { ev.stopPropagation(); });
      (hostEl || svgbox).appendChild(m);
      return m;
    }
    function mbtn(m, txt, cls, fn) {
      var b = document.createElement("button");
      b.type = "button"; b.textContent = txt; if (cls) b.className = cls;
      b.addEventListener("click", fn);
      m.appendChild(b);
      return b;
    }
    function openNodeMenu(id, r) {
      var m = menuEl(r.left, Math.max(r.top - 36, 0), r.host);
      mbtn(m, S.menuEdit, null, function () { openInlineEditor(id); });
      mbtn(m, S.menuDelete, "danger", function () {
        var n = model.nodes[id];
        if (n.fresh) {
          delete model.nodes[id];
          model.edges = model.edges.filter(function (e) { return e.from !== id && e.to !== id; });
        } else n.deleted = true;
        selected = null; clearFloat(); render(); announce();
        setStatus(S.deleted(id));
      });
    }
    function openInlineEditor(id) {
      clearFloat();
      var r = boxRectOf(id);
      if (!r) return;
      var n = model.nodes[id];
      var inp = document.createElement("input");
      inp.type = "text";
      inp.className = "inline";
      inp.value = n.label || "";
      inp.style.left = r.left + "px";
      inp.style.top = r.top + "px";
      inp.style.width = Math.max(r.width, 110) + "px";
      inp.style.height = r.height + "px";
      inp.addEventListener("click", function (ev) { ev.stopPropagation(); });
      inp.addEventListener("pointerdown", function (ev) { ev.stopPropagation(); });
      r.host.appendChild(inp);
      inp.focus(); inp.select();
      function commit() {
        var v = inp.value.trim();
        if (v) {
          n.label = v;
          var orig = baseline.nodes[id] ? baseline.nodes[id].label : null;
          if (!n.fresh) { if (v !== orig) n.modified = true; else delete n.modified; }
        }
        clearFloat(); render(); announce();
      }
      function cancel() { clearFloat(); render(); idleStatus(); }
      inp.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") { ev.preventDefault(); commit(); }
        if (ev.key === "Escape") { ev.preventDefault(); cancel(); }
      });
      inp.addEventListener("blur", function () { setTimeout(function () { if (rootEl.contains(inp)) commit(); }, 120); });
    }
    function openEdgeMenu(e, x, y, focusLabel) {
      var m = menuEl(x, y);
      var li = document.createElement("input");
      li.value = e.label || "";
      li.placeholder = S.menuLabel;
      li.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") { ev.preventDefault(); applyLabel(); }
        if (ev.key === "Escape") { ev.preventDefault(); clearFloat(); idleStatus(); }
      });
      m.appendChild(li);
      function applyLabel() {
        if (!e.pending && !("origLabel" in e)) e.origLabel = e.label;
        e.label = li.value.trim() || null;
        if (!e.pending) {
          if (e.label === e.origLabel) delete e.labelChanged;
          else e.labelChanged = true;
        }
        clearFloat(); render(); announce();
      }
      mbtn(m, S.apply, null, applyLabel);
      mbtn(m, S.menuDelete, "danger", function () {
        if (e.pending) {
          var i = model.edges.indexOf(e);
          if (i >= 0) model.edges.splice(i, 1);
        } else e.deleted = true;
        clearFloat(); render(); announce();
      });
      if (focusLabel) li.focus();
    }

    // ---- pan & zoom ----
    viewport.addEventListener("wheel", function (ev) {
      ev.preventDefault();
      var r = viewport.getBoundingClientRect();
      var px = ev.clientX - r.left, py = ev.clientY - r.top;
      var nz = Math.min(4, Math.max(0.05, vz * Math.exp(-ev.deltaY * 0.0015)));
      vx = px - (px - vx) * (nz / vz);
      vy = py - (py - vy) * (nz / vz);
      vz = nz;
      camAuto = false;
      applyView();
    }, { passive: false });
    viewport.addEventListener("pointerdown", function (ev) {
      // reaches here only for background presses (nodes/handles/menus stop propagation)
      if (ev.button !== 0 && ev.button !== 1) return;
      if (ev.button === 1) ev.preventDefault();
      var sx = ev.clientX, sy = ev.clientY, bx = vx, by = vy, pid = ev.pointerId, panning = false;
      function onMove(mv) {
        if (mv.pointerId !== pid) return;
        var dx = mv.clientX - sx, dy = mv.clientY - sy;
        if (!panning && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        panning = true;
        viewport.classList.add("panning");
        vx = bx + dx; vy = by + dy;
        camAuto = false;
        applyView();
      }
      function onUp(uv) {
        if (uv.pointerId !== pid) return;
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        viewport.classList.remove("panning");
      }
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    });
    viewport.addEventListener("dblclick", function (ev) {
      if (ev.target.closest && ev.target.closest(".hit,.menu,.inline,.handle,.toolbar")) return;
      fitView();
    });

    // ---- outside click / global controls ----
    rootEl.addEventListener("click", function () {
      clearFloat(); selected = null;
      if (handleEl) { handleEl.remove(); handleEl = null; }
      if (model) render();
      idleStatus();
    });
    rootEl.querySelector(".bar").addEventListener("click", function (ev) { ev.stopPropagation(); });

    rootEl.querySelector(".addnode").addEventListener("click", function () {
      var i = 1; while (model.nodes["n" + i]) i++;
      var id = "n" + i;
      model.nodes[id] = { label: S.newNodeLabel, shape: "Rectangle", fresh: true };
      selected = id; render(); openInlineEditor(id); announce();
    });
    autoBtn.addEventListener("click", function () {
      manual = false; autoBtn.hidden = true;
      Object.keys(model.nodes).forEach(function (id) {
        delete model.nodes[id].tx; delete model.nodes[id].ty;
      });
      clearNodeTransforms();
      render(); idleStatus();
    });
    rootEl.querySelector(".revert").addEventListener("click", function () {
      model = deepCopy(baseline.model);
      manual = false; autoBtn.hidden = true;
      clearNodeTransforms();
      selected = null; render(); announce();
    });
    fitBtn.addEventListener("click", fitView);
    noteEl.addEventListener("input", updateSendState);
    sendBtn.addEventListener("click", function () {
      var note = noteEl.value.trim();
      var ops = opsCount();
      if (ops === 0 && !note) { setStatus(S.nothingToSend); return; }
      var cur = currentSource();
      if (opts.onSubmit) opts.onSubmit({ source: cur.source, note: note, ops: ops, lossy: cur.lossy });
    });

    function onResize() { if (model) render(); }
    window.addEventListener("resize", onResize);

    var api = {
      update: function (d) {
        if (destroyed) return;
        if (d.svg) { svgslot.innerHTML = d.svg; nodeVisuals = null; edgeInfos = null; looseDecor = []; }
        if (d.nodes && d.edges) {
          model = { nodes: deepCopy(d.nodes), edges: deepCopy(d.edges) };
          var dm = /^\s*flowchart\s+(\w+)/.exec(d.source || "");
          model.dir = dm ? dm[1] : "TD";
          baseline = { model: deepCopy(model), nodes: deepCopy(d.nodes), source: d.source || "" };
          selected = null;
          manual = false; autoBtn.hidden = true;
        }
        wireSvgEdgeTargets();
        render();
        // Refit only an untouched camera: an incoming turn must not reset
        // the pan/zoom the user set up.
        if (d.svg && camAuto) fitView();
        idleStatus();
        updateSendState();
      },
      getSource: function () { return currentSource().source; },
      getNote: function () { return noteEl.value.trim(); },
      setNote: function (value) { noteEl.value = value; },
      pendingOps: opsCount,
      destroy: function () {
        destroyed = true;
        window.removeEventListener("resize", onResize);
        host.remove();
      },
    };
    api.update(opts);
    return api;
  }

  // ---- <mmx-editor> custom element (the standard interface) ----
  //   el.load({svg, nodes, edges, source})   partial update, no page reload
  //   el.addEventListener("mmx-submit", e => e.detail /* {source, note, ops} */)
  //   el.addEventListener("mmx-change", e => e.detail /* {source, ops} */)
  //   el.strings = {...}   optional; set before load() (re-mounts if set later)
  //   el.getSource() / el.getNote() / el.pendingOps()
  if (typeof HTMLElement !== "undefined" && typeof customElements !== "undefined") {
    var MmxEditorElement = /** @type {any} */ (function () {
      function El() { return Reflect.construct(HTMLElement, [], El); }
      El.prototype = Object.create(HTMLElement.prototype);
      El.prototype.constructor = El;

      El.prototype._mount = function () {
        var self = this;
        this._editor = mount(this, {
          strings: this._strings,
          onSubmit: function (r) {
            self.dispatchEvent(new CustomEvent("mmx-submit", { detail: r, bubbles: true }));
          },
          onChange: function (r) {
            self.dispatchEvent(new CustomEvent("mmx-change", { detail: r, bubbles: true }));
          },
        });
        if (this._lastLoad) this._editor.update(this._lastLoad);
      };
      El.prototype.connectedCallback = function () {
        if (!this._editor) this._mount();
      };
      El.prototype.disconnectedCallback = function () {
        if (this._editor) { this._editor.destroy(); this._editor = null; }
      };
      El.prototype.load = function (d) {
        this._lastLoad = d;
        if (this._editor) this._editor.update(d);
      };
      Object.defineProperty(El.prototype, "strings", {
        set: function (s) {
          this._strings = s;
          if (this._editor) { this._editor.destroy(); this._mount(); }
        },
      });
      El.prototype.getSource = function () { return this._editor ? this._editor.getSource() : ""; };
      El.prototype.getNote = function () { return this._editor ? this._editor.getNote() : ""; };
      El.prototype.setNote = function (value) { if (this._editor) this._editor.setNote(value); };
      El.prototype.pendingOps = function () { return this._editor ? this._editor.pendingOps() : 0; };
      return El;
    })();
    if (!customElements.get("mmx-editor")) customElements.define("mmx-editor", MmxEditorElement);
  }

  return { mount: mount, patchSource: patchSource, PatchFail: PatchFail, version: "0.5.0" };
});
