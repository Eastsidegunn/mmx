/*!
 * mmx-editor — in-place diagram editing component for mmx.
 *
 * Editing only, by design: the module renders an mmx-produced SVG, lets the
 * user manipulate the visible flowchart (rename, delete, connect, add nodes),
 * and hands the result back as mermaid text through callbacks. Where that
 * text goes — a file, a server, an artifact store — is the host's business.
 *
 * const editor = MmxEditor.mount(container, {
 *   svg,            // string: the rendered SVG (from `mmx render`)
 *   nodes,          // {id: {label, shape, x, y, w, h}} (from state.json)
 *   edges,          // [{from, to, label}]              (from state.json)
 *   source,         // string: the mermaid source of that render
 *   onSubmit(r) {}, // user pressed send: r = {source, note, ops}
 *   onChange(r) {}, // after each committed operation: r = {source, ops}
 *   strings,        // optional UI-string overrides (see DEFAULT_STRINGS)
 * });
 * editor.update({svg, nodes, edges, source})  // new confirmed turn from host
 * editor.getSource()                          // serialize current edits
 * editor.pendingOps()                         // count of unsent operations
 * editor.destroy()
 *
 * No dependencies. Styles are isolated in shadow DOM; hosts can theme via
 * CSS custom properties on the container (--mmx-accent, --mmx-surface, ...).
 * Serialization targets the flowchart subset (node shapes Rectangle/Diamond,
 * labeled edges); comments and style directives of the original source are
 * not preserved in direct-manipulation mode.
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
    notePlaceholder: "Say a word (recorded as --note)",
    apply: "✓ apply",
    connect: "connect →",
    edges: "edges",
    remove: "delete",
    restore: "restore",
    label: "label",
    noEdges: "no connected edges",
    pendingOps: function (n) { return n + " pending operation(s)"; },
    idle: "Click a node to edit it in place",
    connectFrom: function (id) { return id + ": click a target node to connect"; },
    connected: function (a, b) { return a + " → " + b + " connected"; },
    deleted: function (id) { return id + " deleted — click again to undo"; },
    nothingToSend: "Nothing changed yet",
    staged: "(unplaced)",
    newNodeLabel: "new node",
  };

  var CSS = "\n" +
    ":host{all:initial;display:block;font-family:-apple-system,'Apple SD Gothic Neo','Noto Sans KR',sans-serif;font-size:14px;line-height:1.5;color:var(--mmx-ink,#23272E);}\n" +
    "*{box-sizing:border-box;}\n" +
    ".stage{background:var(--mmx-canvas,#FFFFFF);border:1px solid var(--mmx-border,#E5E2DB);border-radius:10px;padding:16px;overflow:auto;}\n" +
    ".svgbox{position:relative;width:fit-content;margin:0 auto;}\n" +
    ".svgbox svg{display:block;max-width:100%;height:auto;}\n" +
    ".hit{position:absolute;border:1.5px dashed transparent;border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;text-align:center;font-size:12.5px;line-height:1.3;padding:2px;color:#23272E;}\n" +
    ".hit:hover{border-color:var(--mmx-select,#2563EB);}\n" +
    ".hit.selected{border-style:solid;border-color:var(--mmx-select,#2563EB);}\n" +
    ".hit.modified{background:#FFFFFF;border:1.5px solid var(--mmx-accent,#B04A17);}\n" +
    ".hit.deleted{background:rgba(120,120,120,.75);border:1.5px solid #888;color:#fff;text-decoration:line-through;}\n" +
    ".hit.linksrc{border:2px solid var(--mmx-accent,#B04A17);}\n" +
    ".inline{position:absolute;z-index:30;border:2px solid var(--mmx-select,#2563EB);border-radius:8px;background:#FFFFFF;color:#23272E;font-size:12.5px;text-align:center;padding:2px 4px;outline:none;font-family:inherit;}\n" +
    ".toolbar{position:absolute;z-index:31;display:flex;gap:4px;background:var(--mmx-surface,#FFFFFF);border:1px solid var(--mmx-border,#E5E2DB);border-radius:8px;padding:4px 6px;box-shadow:0 2px 10px rgba(0,0,0,.12);}\n" +
    ".toolbar button{background:transparent;color:var(--mmx-ink,#23272E);border:none;padding:3px 8px;font-size:12.5px;border-radius:6px;cursor:pointer;white-space:nowrap;font-weight:500;font-family:inherit;}\n" +
    ".toolbar button:hover{background:rgba(127,127,127,.15);}\n" +
    ".toolbar button.danger{color:#C0392B;}\n" +
    ".toolbar button.primary{color:var(--mmx-select,#2563EB);font-weight:700;}\n" +
    ".edgepop{position:absolute;z-index:32;min-width:240px;background:var(--mmx-surface,#FFFFFF);border:1px solid var(--mmx-border,#E5E2DB);border-radius:10px;padding:10px 12px;box-shadow:0 4px 16px rgba(0,0,0,.15);display:flex;flex-direction:column;gap:6px;font-size:13px;}\n" +
    ".edgepop .edgeline{display:flex;gap:6px;align-items:center;}\n" +
    ".edgepop .edgeline.struck{text-decoration:line-through;opacity:.6;}\n" +
    ".edgepop code{background:rgba(127,127,127,.15);padding:1px 6px;border-radius:4px;font-size:12px;font-family:ui-monospace,Menlo,monospace;}\n" +
    ".edgepop input{width:90px;border:1px solid var(--mmx-border,#E5E2DB);border-radius:6px;padding:3px 7px;font-size:12.5px;background:var(--mmx-surface,#FFFFFF);color:var(--mmx-ink,#23272E);font-family:inherit;}\n" +
    ".edgepop button{background:transparent;border:none;color:#C0392B;cursor:pointer;font-size:12.5px;padding:2px 4px;font-family:inherit;}\n" +
    ".edgepop button.undo{color:var(--mmx-select,#2563EB);}\n" +
    ".staging{position:relative;display:flex;gap:10px;flex-wrap:wrap;margin-top:12px;justify-content:center;}\n" +
    ".snode{border:1.5px dashed var(--mmx-accent,#B04A17);border-radius:8px;background:#FFFFFF;color:#23272E;padding:8px 16px;font-size:12.5px;cursor:pointer;min-width:70px;text-align:center;}\n" +
    ".snode.selected{border-style:solid;border-color:var(--mmx-select,#2563EB);}\n" +
    ".snode.linksrc{border-style:solid;border-color:var(--mmx-accent,#B04A17);border-width:2px;}\n" +
    ".bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px;}\n" +
    ".bar input{flex:1;min-width:160px;background:var(--mmx-surface,#FFFFFF);color:var(--mmx-ink,#23272E);border:1px solid var(--mmx-border,#E5E2DB);border-radius:8px;padding:9px 12px;font-size:14px;font-family:inherit;}\n" +
    ".bar button{background:var(--mmx-accent,#B04A17);color:#fff;border:none;border-radius:8px;padding:9px 18px;font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit;}\n" +
    ".bar button.ghost{background:transparent;color:var(--mmx-ink,#23272E);border:1px solid var(--mmx-border,#E5E2DB);font-weight:400;}\n" +
    ".status{font-size:13px;color:var(--mmx-muted,#6E6A63);min-height:1.2em;margin-top:6px;}\n";

  function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }

  function quoteLabel(l) {
    l = l.replace(/[\r\n]+/g, " ").trim();
    return /[\[\]{}()|"<>#;]/.test(l) ? '"' + l.replace(/"/g, "'") + '"' : l;
  }
  function edgeLabel(l) {
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
      '  <div class="svgbox"><div class="svgslot"></div></div>' +
      '  <div class="staging"></div>' +
      "</div>" +
      '<div class="bar">' +
      '  <button class="ghost addnode" type="button"></button>' +
      '  <input class="note" type="text">' +
      '  <button class="send" type="button"></button>' +
      '  <button class="ghost revert" type="button"></button>' +
      "</div>" +
      '<div class="status"></div>';
    shadow.appendChild(rootEl);

    var svgbox = rootEl.querySelector(".svgbox");
    var svgslot = rootEl.querySelector(".svgslot");
    var staging = rootEl.querySelector(".staging");
    var noteEl = rootEl.querySelector(".note");
    var statusEl = rootEl.querySelector(".status");
    rootEl.querySelector(".addnode").textContent = S.addNode;
    rootEl.querySelector(".send").textContent = S.send;
    rootEl.querySelector(".revert").textContent = S.revert;
    noteEl.placeholder = S.notePlaceholder;

    var model = null, baseline = null, selected = null, linking = null;
    var destroyed = false;

    function setStatus(m) { statusEl.textContent = m || ""; }

    function opsCount() {
      if (!model) return 0;
      var n = 0;
      Object.keys(model.nodes).forEach(function (id) {
        var d = model.nodes[id];
        if (d.deleted || d.modified || d.fresh) n++;
      });
      model.edges.forEach(function (e) {
        if (e.deleted || e.pending || e.labelChanged) n++;
      });
      return n;
    }
    function announce() {
      var n = opsCount();
      setStatus(n > 0 ? S.pendingOps(n) : S.idle);
      if (opts.onChange) opts.onChange({ source: serialize(), ops: n });
    }

    // ---- serialization (flowchart subset; deleted entries skipped) ----
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
        var l = e.label ? edgeLabel(e.label) : "";
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
      return { s: svg.clientWidth / svg.viewBox.baseVal.width };
    }
    function centerOf(id) {
      var n = model.nodes[id], sc = scaleOf();
      if (n && typeof n.x === "number" && sc)
        return { x: (n.x + n.w / 2) * sc.s, y: (n.y + n.h / 2) * sc.s };
      var el = staging.querySelector('[data-id="' + id + '"]');
      if (el) {
        var b = el.getBoundingClientRect(), r = svgbox.getBoundingClientRect();
        return { x: b.left - r.left + b.width / 2, y: b.top - r.top + b.height / 2 };
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

    // ---- rendering ----
    function clearFloat() {
      rootEl.querySelectorAll(".inline,.toolbar,.edgepop").forEach(function (e) { e.remove(); });
    }
    function render() {
      clearFloat();
      svgbox.querySelectorAll(".hit,.pendlines").forEach(function (e) { e.remove(); });
      staging.innerHTML = "";
      if (!model) return;
      var sc = scaleOf();
      Object.keys(model.nodes).forEach(function (id) {
        var n = model.nodes[id];
        if (typeof n.x === "number" && sc) {
          var d = document.createElement("div");
          d.className = "hit" + (n.deleted ? " deleted" : n.modified ? " modified" : "") +
            (id === selected ? " selected" : "") + (id === linking ? " linksrc" : "");
          d.style.left = n.x * sc.s + "px";
          d.style.top = n.y * sc.s + "px";
          d.style.width = n.w * sc.s + "px";
          d.style.height = n.h * sc.s + "px";
          d.dataset.id = id;
          d.title = id;
          if (n.modified || n.deleted) d.textContent = n.label || id;
          d.addEventListener("click", function (ev) { ev.stopPropagation(); onNode(id); });
          svgbox.appendChild(d);
        } else {
          var s = document.createElement("div");
          s.className = "snode" + (id === selected ? " selected" : "") + (id === linking ? " linksrc" : "");
          s.dataset.id = id;
          s.textContent = (n.label || id) + " " + S.staged;
          s.addEventListener("click", function (ev) { ev.stopPropagation(); onNode(id); });
          staging.appendChild(s);
        }
      });
      drawPendingEdges();
    }
    function drawPendingEdges() {
      var old = svgbox.querySelector(".pendlines");
      if (old) old.remove();
      var pend = model.edges.filter(function (e) { return e.pending && !e.deleted && alive(e.from) && alive(e.to); });
      if (!pend.length) return;
      var NS = "http://www.w3.org/2000/svg";
      var box = svgbox.getBoundingClientRect();
      var ov = document.createElementNS(NS, "svg");
      ov.setAttribute("class", "pendlines");
      ov.setAttribute("width", box.width);
      ov.setAttribute("height", svgbox.scrollHeight || box.height);
      ov.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:20;overflow:visible";
      var accent = getComputedStyle(container).getPropertyValue("--mmx-accent").trim() || "#B04A17";
      var defs = document.createElementNS(NS, "defs");
      var mid = "mmxpend" + Math.floor(Math.random() * 1e9);
      defs.innerHTML = '<marker id="' + mid + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="' + accent + '"/></marker>';
      ov.appendChild(defs);
      pend.forEach(function (e) {
        var a = centerOf(e.from), b = centerOf(e.to);
        if (!a || !b) return;
        var ln = document.createElementNS(NS, "line");
        ln.setAttribute("x1", a.x); ln.setAttribute("y1", a.y);
        ln.setAttribute("x2", b.x); ln.setAttribute("y2", b.y);
        ln.setAttribute("stroke", accent); ln.setAttribute("stroke-width", "2");
        ln.setAttribute("stroke-dasharray", "6 4");
        ln.setAttribute("marker-end", "url(#" + mid + ")");
        ov.appendChild(ln);
        if (e.label) {
          var t = document.createElementNS(NS, "text");
          t.setAttribute("x", (a.x + b.x) / 2); t.setAttribute("y", (a.y + b.y) / 2 - 4);
          t.setAttribute("fill", accent); t.setAttribute("font-size", "11");
          t.setAttribute("text-anchor", "middle");
          t.textContent = e.label;
          ov.appendChild(t);
        }
      });
      svgbox.appendChild(ov);
    }

    // ---- interaction ----
    function onNode(id) {
      var n = model.nodes[id];
      if (linking && linking !== id) {
        if (!n.deleted) {
          model.edges.push({ from: linking, to: id, label: null, pending: true });
          setStatus(S.connected(linking, id));
        }
        var src = linking;
        linking = null; selected = id;
        render(); openEditor(id); announce();
        return;
      }
      linking = null;
      if (n.deleted) {
        delete n.deleted;
        selected = id; render(); announce();
        return;
      }
      selected = id; render(); openEditor(id);
    }

    function openEditor(id) {
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
      r.host.appendChild(inp);
      inp.focus(); inp.select();
      inp.addEventListener("click", function (ev) { ev.stopPropagation(); });
      function commit() {
        var v = inp.value.trim();
        if (v) {
          n.label = v;
          var orig = baseline.nodes[id] ? baseline.nodes[id].label : null;
          if (!n.fresh) { if (v !== orig) n.modified = true; else delete n.modified; }
        }
        done();
      }
      function done() { clearFloat(); render(); announce(); }
      function cancel() { clearFloat(); render(); setStatus(opsCount() > 0 ? S.pendingOps(opsCount()) : S.idle); }
      inp.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") { ev.preventDefault(); commit(); }
        if (ev.key === "Escape") { ev.preventDefault(); cancel(); }
      });

      var tb = document.createElement("div");
      tb.className = "toolbar";
      tb.style.left = r.left + "px";
      tb.style.top = Math.max(r.top - 38, 0) + "px";
      tb.addEventListener("click", function (ev) { ev.stopPropagation(); });
      function tbtn(txt, cls, fn) {
        var b = document.createElement("button");
        b.type = "button"; b.textContent = txt; if (cls) b.className = cls;
        b.addEventListener("click", fn);
        tb.appendChild(b);
      }
      tbtn(S.apply, "primary", commit);
      tbtn(S.connect, null, function () {
        linking = id; clearFloat(); render(); setStatus(S.connectFrom(id));
      });
      tbtn(S.edges, null, function () { openEdgePop(id, r); });
      tbtn(S.remove, "danger", function () {
        if (n.fresh) {
          delete model.nodes[id];
          model.edges = model.edges.filter(function (e) { return e.from !== id && e.to !== id; });
        } else n.deleted = true;
        selected = null; clearFloat(); render(); announce();
        setStatus(S.deleted(id));
      });
      r.host.appendChild(tb);
    }

    function openEdgePop(id, r) {
      var old = rootEl.querySelector(".edgepop");
      if (old) { old.remove(); return; }
      var pop = document.createElement("div");
      pop.className = "edgepop";
      pop.style.left = r.left + "px";
      pop.style.top = r.top + r.height + 6 + "px";
      pop.addEventListener("click", function (ev) { ev.stopPropagation(); });
      var any = false;
      model.edges.forEach(function (e, i) {
        if (e.from !== id && e.to !== id) return;
        any = true;
        var row = document.createElement("div");
        row.className = "edgeline" + (e.deleted ? " struck" : "");
        var c = document.createElement("code");
        c.textContent = e.from + " → " + e.to;
        row.appendChild(c);
        var li = document.createElement("input");
        li.value = e.label || "";
        li.placeholder = S.label;
        li.addEventListener("change", function () {
          if (!e.pending && !("origLabel" in e)) e.origLabel = e.label;
          e.label = li.value.trim() || null;
          if (!e.pending) {
            if (e.label === e.origLabel) delete e.labelChanged;
            else e.labelChanged = true;
          }
          drawPendingEdges(); announce();
        });
        row.appendChild(li);
        var del = document.createElement("button");
        del.type = "button";
        del.textContent = e.deleted ? S.restore : S.remove;
        if (e.deleted) del.className = "undo";
        del.addEventListener("click", function () {
          if (e.pending && !e.deleted) model.edges.splice(i, 1);
          else e.deleted = !e.deleted;
          pop.remove(); render(); announce();
          var rr = boxRectOf(id);
          if (rr) openEdgePop(id, rr);
        });
        row.appendChild(del);
        pop.appendChild(row);
      });
      if (!any) {
        var no = document.createElement("span");
        no.textContent = S.noEdges;
        pop.appendChild(no);
      }
      r.host.appendChild(pop);
    }

    function outsideClick() { clearFloat(); selected = null; linking = null; if (model) render(); }
    rootEl.addEventListener("click", outsideClick);
    rootEl.querySelector(".bar").addEventListener("click", function (ev) { ev.stopPropagation(); });

    rootEl.querySelector(".addnode").addEventListener("click", function () {
      var i = 1; while (model.nodes["n" + i]) i++;
      var id = "n" + i;
      model.nodes[id] = { label: S.newNodeLabel, shape: "Rectangle", fresh: true };
      selected = id; render(); openEditor(id); announce();
    });
    rootEl.querySelector(".revert").addEventListener("click", function () {
      model = deepCopy(baseline.model);
      selected = null; linking = null; render(); announce();
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
        if (d.svg) svgslot.innerHTML = d.svg;
        if (d.nodes && d.edges) {
          model = { nodes: deepCopy(d.nodes), edges: deepCopy(d.edges) };
          var dm = /^\s*flowchart\s+(\w+)/.exec(d.source || "");
          model.dir = dm ? dm[1] : "TD";
          baseline = { model: deepCopy(model), nodes: deepCopy(d.nodes), source: d.source || "" };
          selected = null; linking = null;
        }
        render();
        setStatus(S.idle);
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
  // Data flows in through properties/methods, out through DOM events:
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

  return { mount: mount, version: "0.2.0" };
});
