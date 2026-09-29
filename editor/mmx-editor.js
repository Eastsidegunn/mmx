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
    revert: "Revert",
    autoLayout: "auto layout",
    notePlaceholder: "Say a word (recorded as --note)",
    menuEdit: "✎ edit",
    menuDelete: "✕ delete",
    menuLabel: "label",
    apply: "✓",
    label: "label",
    pendingOps: function (n) { return n + " pending operation(s)"; },
    idle: "Click a node or an arrow; drag the ● handle to connect; drag a node to rearrange (temporary)",
    manualMode: "Manual placement (temporary) — send or a new turn snaps back to auto layout",
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
    ".bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px;}\n" +
    ".bar input{flex:1;min-width:160px;background:var(--mmx-surface,#FFFFFF);color:var(--mmx-ink,#23272E);border:1px solid var(--mmx-border,#E5E2DB);border-radius:8px;padding:9px 12px;font-size:14px;font-family:inherit;}\n" +
    ".bar button{background:var(--mmx-accent,#B04A17);color:#fff;border:none;border-radius:8px;padding:9px 18px;font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit;}\n" +
    ".bar button.ghost{background:transparent;color:var(--mmx-ink,#23272E);border:1px solid var(--mmx-border,#E5E2DB);font-weight:400;}\n" +
    ".bar button[hidden]{display:none;}\n" +
    ".status{font-size:13px;color:var(--mmx-muted,#6E6A63);min-height:1.2em;margin-top:6px;}\n";

  function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }

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
      '  <div class="viewport"><div class="svgbox"><div class="svgslot"></div></div></div>' +
      '  <div class="staging"></div>' +
      "</div>" +
      '<div class="bar">' +
      '  <button class="ghost addnode" type="button"></button>' +
      '  <button class="ghost autolayout" type="button" hidden></button>' +
      '  <input class="note" type="text">' +
      '  <button class="send" type="button"></button>' +
      '  <button class="ghost revert" type="button"></button>' +
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
    rootEl.querySelector(".addnode").textContent = S.addNode;
    rootEl.querySelector(".send").textContent = S.send;
    rootEl.querySelector(".revert").textContent = S.revert;
    autoBtn.textContent = S.autoLayout;
    noteEl.placeholder = S.notePlaceholder;

    // model.nodes[id] = {label, shape, x?,y?,w?,h?, tx?,ty? (temp), deleted?, modified?, fresh?}
    // model.edges    = [{from, to, label, deleted?, pending?, labelChanged?, origLabel?}]
    var model = null, baseline = null, selected = null, destroyed = false;
    var manual = false;
    var nodeVisuals = null; // id -> [svg elements] (classified lazily)
    var edgeDecor = []; // standalone arrowhead polygons (no data-edge-id marker)
    var vz = 1, vx = 0, vy = 0; // camera: zoom + pan (CSS transform on svgbox)
    function applyView() {
      svgbox.style.transform = "translate(" + vx + "px," + vy + "px) scale(" + vz + ")";
    }
    function fitView() {
      vz = 1;
      vx = Math.max((viewport.clientWidth - svgbox.offsetWidth) / 2, 8);
      vy = 12;
      applyView();
    } // temporary-placement mode: svg edges hidden, all edges overlay-drawn

    function setStatus(m) { statusEl.textContent = m || ""; }
    function idleStatus() { setStatus(manual ? S.manualMode : (opsCount() > 0 ? S.pendingOps(opsCount()) : S.idle)); }

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
    function announce() {
      idleStatus();
      if (opts.onChange) opts.onChange({ source: serialize(), ops: opsCount() });
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
          if (manual) return;
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
      edgeDecor = [];
      var svg = svgslot.querySelector("svg");
      if (!svg || !model || !svg.viewBox || !svg.viewBox.baseVal.width) return;
      var vbW = svg.viewBox.baseVal.width, vbH = svg.viewBox.baseVal.height;
      var svgR = svg.getBoundingClientRect();
      if (!svgR.width) return;
      // Measure in screen space and convert back to viewBox units, so
      // elements positioned via their own transform (mmdr's arrowhead <g>
      // wrappers) are located correctly.
      var kx = vbW / svgR.width, ky = vbH / svgR.height;
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
        if (bw <= 24 && bh <= 24) { edgeDecor.push(el); return; }
        for (var id in model.nodes) {
          var n = model.nodes[id];
          if (typeof n.x !== "number") continue;
          if (cx >= n.x - 1 && cx <= n.x + n.w + 1 && cy >= n.y - 1 && cy <= n.y + n.h + 1) {
            (nodeVisuals[id] = nodeVisuals[id] || []).push(el);
            return;
          }
        }
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
    function setSvgEdgesVisible(v) {
      var svg = svgslot.querySelector("svg");
      if (!svg) return;
      if (!v && !nodeVisuals) classifyNodeVisuals();
      svg.querySelectorAll("[data-edge-id],[data-label-kind]").forEach(function (el) {
        el.style.opacity = v ? "" : "0";
      });
      edgeDecor.forEach(function (el) { el.style.opacity = v ? "" : "0"; });
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
      if (manual) {
        return model.edges.filter(function (e) { return !e.deleted && alive(e.from) && alive(e.to); });
      }
      return model.edges.filter(function (e) { return e.pending && !e.deleted && alive(e.from) && alive(e.to); });
    }
    function drawOverlayEdges() {
      var old = svgbox.querySelector(".overlaylines");
      if (old) old.remove();
      setSvgEdgesVisible(!manual);
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
      list.forEach(function (e) {
        var a = centerOf(e.from), b = centerOf(e.to);
        if (!a || !b) return;
        var stroke = e.pending ? accent : ink;
        var ln = document.createElementNS(NS, "line");
        ln.setAttribute("x1", a.x); ln.setAttribute("y1", a.y);
        ln.setAttribute("x2", b.x); ln.setAttribute("y2", b.y);
        ln.setAttribute("stroke", stroke); ln.setAttribute("stroke-width", "2");
        if (e.pending) ln.setAttribute("stroke-dasharray", "6 4");
        ln.setAttribute("marker-end", "url(#" + mid + (e.pending ? "p" : "") + ")");
        if (manual) { // clickable in manual mode
          ln.style.pointerEvents = "stroke";
          ln.style.cursor = "pointer";
          ln.addEventListener("click", function (ev) {
            ev.stopPropagation();
            var p = localPoint(ev);
            openEdgeMenu(e, p.x, p.y);
          });
        }
        ov.appendChild(ln);
        if (e.label) {
          var t = document.createElementNS(NS, "text");
          t.setAttribute("x", (a.x + b.x) / 2); t.setAttribute("y", (a.y + b.y) / 2 - 5);
          t.setAttribute("fill", stroke); t.setAttribute("font-size", "11");
          t.setAttribute("text-anchor", "middle");
          t.textContent = e.label;
          ov.appendChild(t);
        }
      });
      svgbox.appendChild(ov);
    }

    // ---- pointer wiring: click menu / drag placement / handle connect ----
    var DRAG_MIN = 5;
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
          if (!moved) onNodeClick(id);
        }
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
      });
      el.addEventListener("pointerenter", function () { showHandle(id); });
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
        ln.setAttribute("x2", p.x); ln.setAttribute("y2", p.y);
      }
      function onUp(uv) {
        if (uv.pointerId !== pid) return;
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        band.remove();
        var target = nodeAtPoint(localPoint(uv));
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
      var nz = Math.min(4, Math.max(0.2, vz * Math.exp(-ev.deltaY * 0.0015)));
      vx = px - (px - vx) * (nz / vz);
      vy = py - (py - vy) * (nz / vz);
      vz = nz;
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
      if (ev.target.closest && ev.target.closest(".hit,.menu,.inline,.handle")) return;
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
    rootEl.querySelector(".send").addEventListener("click", function () {
      if (opsCount() === 0) { setStatus(S.nothingToSend); return; }
      if (opts.onSubmit) opts.onSubmit({ source: serialize(), note: noteEl.value.trim(), ops: opsCount() });
      noteEl.value = "";
    });

    function onResize() { if (model) render(); }
    window.addEventListener("resize", onResize);

    var api = {
      update: function (d) {
        if (destroyed) return;
        if (d.svg) { svgslot.innerHTML = d.svg; nodeVisuals = null; }
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
        if (d.svg) fitView();
        idleStatus();
      },
      getSource: serialize,
      getNote: function () { return noteEl.value.trim(); },
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
      El.prototype.pendingOps = function () { return this._editor ? this._editor.pendingOps() : 0; };
      return El;
    })();
    if (!customElements.get("mmx-editor")) customElements.define("mmx-editor", MmxEditorElement);
  }

  return { mount: mount, version: "0.3.0" };
});
