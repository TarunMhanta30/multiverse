"use strict";
/* one palette for everything drawn in JS (charts, badges, schedule); style.css holds the same values */
const MVC = { ink: "#141413", ink2: "#4f4d48", ink3: "#8a877f", paper: "#e9e7e1", paper2: "#f4f2ed", line: "#c9c6be",
  signal: "#ff4a1c", signalInk: "#c2330b", gray: "#5f5c56", white: "#fbfaf7" };
/* Multiverse graph view (console build 5): a small SVG renderer for the company graph (no library).

   Layout, left to right: every asset sits to the LEFT of what it depends on, so a failure
   travels right-to-left (against the arrows).
     1. level = longest chain of dependencies leading into an asset (FED_BY links are drawn but
        do not count, they point the other way); assets nobody depends on sit just left of what
        they use
     2. a link that skips columns gets a waypoint in each column it crosses, so it runs in its own lane
     3. each column is ordered by the average position of its neighbours (sweeps left and right),
        which keeps crossings low
   Assets connected to nothing are placed in a separate row underneath. */

const SVGNS = "http://www.w3.org/2000/svg";
const REL_WORD = { CALLS: "calls", READS: "reads", WRITES: "writes to", USES_SECRET: "uses the secret", DEPENDS_ON: "depends on", FED_BY: "is fed by" };
const KIND_ICON = { Service: "box", Datastore: "database", Job: "calendar-clock", Secret: "key-round" };

function svgEl(tag, attrs, parent) {
  const e = document.createElementNS(SVGNS, tag);
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

let _measure = null;
function textWidth(text, font) {
  if (!_measure) _measure = document.createElement("canvas").getContext("2d");
  _measure.font = font;
  return _measure.measureText(text).width;
}

/* ------------------------------------------------------------------------------------- layout */
function layoutWorld(world) {
  const FONT = "500 12px Archivo, system-ui, sans-serif";
  const BOX_H = 26, ROW = 36, GAP = 44, PAD_L = 28, PAD_R = 12;
  const names = world.nodes.map((n) => n.name).sort();
  const byName = Object.fromEntries(world.nodes.map((n) => [n.name, n]));

  // visual edges: one per (from, to); keep every underlying link key
  const groups = {};
  for (const e of world.edges) {
    if (!(e.from in byName) || !(e.to in byName)) continue;
    const id = `${e.from}>${e.to}`;
    const g = (groups[id] ||= { id, from: e.from, to: e.to, keys: [], rels: [], conf: 1, soft: true, fed: true, answered: null, links: [] });
    g.keys.push(e.key || `${e.from}|${e.rel}|${e.to}`);
    g.rels.push(e.rel);
    g.links.push(e);
    g.conf = Math.min(g.conf, e.answered ? (e.answered.exists ? 1 : 0) : e.confidence);
    g.soft = g.soft && !!e.soft;
    g.fed = g.fed && e.rel === "FED_BY";
    if (e.answered) g.answered = e.answered;
  }
  const edges = Object.values(groups);
  const out = {}, inn = {};
  names.forEach((n) => { out[n] = []; inn[n] = []; });
  // layering edges: no FED_BY; break any remaining cycle with a depth-first search
  const layerEdges = edges.filter((g) => !g.fed);
  const adj = {};
  names.forEach((n) => (adj[n] = []));
  layerEdges.forEach((g) => adj[g.from].push(g.to));
  const state = {}, keep = new Set();
  const dfs = (n) => {
    state[n] = 1;
    for (const m of adj[n].slice().sort()) {
      if (state[m] === 1) continue;                     // back edge: ignore for layering
      keep.add(`${n}>${m}`);
      if (!state[m]) dfs(m);
    }
    state[n] = 2;
  };
  names.forEach((n) => { if (!state[n]) dfs(n); });
  for (const g of layerEdges) if (keep.has(g.id)) { out[g.from].push(g.to); inn[g.to].push(g.from); }

  const connected = new Set(edges.flatMap((g) => [g.from, g.to]));
  const islands = names.filter((n) => !connected.has(n));
  const main = names.filter((n) => connected.has(n));

  const level = {};
  const visit = (n, stack) => {
    if (level[n] != null) return level[n];
    if (stack.has(n)) return 0;
    stack.add(n);
    level[n] = inn[n].length ? Math.max(...inn[n].map((p) => visit(p, stack))) + 1 : 0;
    stack.delete(n);
    return level[n];
  };
  main.forEach((n) => visit(n, new Set()));
  for (const n of main) if (!inn[n].length && out[n].length) level[n] = Math.max(0, Math.min(...out[n].map((c) => level[c])) - 1);
  for (const n of main) if (!inn[n].length && !out[n].length) level[n] = 0;   // only FED_BY links

  // waypoints for links that skip columns (FED_BY included, so they get lanes too)
  const up = {}, down = {}, all = main.slice();
  all.forEach((n) => { up[n] = []; down[n] = []; });
  const lanes = {};
  let w = 0;
  for (const g of edges) {
    const a = g.from, b = g.to;
    if (!(a in level) || !(b in level)) continue;
    const step = level[b] > level[a] ? 1 : -1;
    const pts = [];
    let prev = a;
    for (let l = level[a] + step; step > 0 ? l < level[b] : l > level[b]; l += step) {
      const id = `~${w++}`;
      level[id] = l; up[id] = []; down[id] = []; all.push(id); pts.push(id);
      down[prev].push(id); up[id].push(prev); prev = id;
    }
    down[prev].push(b); up[b].push(prev);
    lanes[g.id] = pts;
  }
  const cols = {};
  all.forEach((n) => (cols[level[n]] ||= []).push(n));
  const keys = Object.keys(cols).map(Number).sort((x, y) => x - y);
  const pos = {};
  const place = (k) => cols[k].forEach((n, i) => { pos[n] = i - (cols[k].length - 1) / 2; });
  keys.forEach((k) => { cols[k].sort(); place(k); });
  const bary = (n, nb) => (nb.length ? nb.reduce((s, m) => s + pos[m], 0) / nb.length : pos[n]);
  for (let it = 0; it < 16; it++) {
    const order = it % 2 ? keys.slice().reverse() : keys;
    for (const k of order) {
      const nb = (n) => (it % 2 ? down[n] : up[n]);
      cols[k].sort((x, y) => bary(x, nb(x)) - bary(y, nb(y)) || (x < y ? -1 : 1));
      place(k);
    }
  }

  // sizes
  const boxW = {};
  for (const n of names) boxW[n] = Math.ceil(PAD_L + textWidth(n, FONT) + PAD_R + (byName[n].criticality === 3 ? 10 : 0));
  const colW = {};
  keys.forEach((k) => { colW[k] = Math.max(60, ...cols[k].filter((n) => !n.startsWith("~")).map((n) => boxW[n])); });
  const colX = {};
  let x = 0;
  keys.forEach((k) => { colX[k] = x; x += colW[k] + GAP; });

  const P = {};
  keys.forEach((k) => cols[k].forEach((n, i) => {
    const y = (i - (cols[k].length - 1) / 2) * ROW;
    P[n] = { x: colX[k], y, w: n.startsWith("~") ? colW[k] : boxW[n], h: BOX_H, col: k };
  }));
  let minY = Infinity, maxY = -Infinity, maxX = 0;
  for (const n of main) { minY = Math.min(minY, P[n].y); maxY = Math.max(maxY, P[n].y); maxX = Math.max(maxX, P[n].x + P[n].w); }
  if (!main.length) { minY = 0; maxY = 0; }
  // islands: one row underneath
  let ix = 0;
  const iy = maxY + ROW * 1.9;
  for (const n of islands) { P[n] = { x: ix, y: iy, w: boxW[n], h: BOX_H, col: -1, island: true }; ix += boxW[n] + 24; maxX = Math.max(maxX, ix); }

  // edge geometry
  for (const g of edges) {
    const a = P[g.from], b = P[g.to];
    if (!a || !b) continue;
    const twin = groups[`${g.to}>${g.from}`];
    const off = twin ? (g.from < g.to ? -5 : 5) : 0;
    const forward = b.x > a.x;
    const pts = [[forward ? a.x + a.w : a.x, a.y + off]];
    for (const id of lanes[g.id] || []) {
      const p = P[id];
      if (forward) pts.push([p.x - 6, p.y + off], [p.x + p.w + 6, p.y + off]);
      else pts.push([p.x + p.w + 6, p.y + off], [p.x - 6, p.y + off]);
    }
    pts.push([forward ? b.x - 3 : b.x + b.w + 3, b.y + off]);
    g.points = pts;
    g.forward = forward;
  }
  const bbox = { x: -8, y: minY - BOX_H, w: maxX + 16, h: (islands.length ? iy : maxY) - minY + BOX_H * 2 + 12 };
  return { P, edges, byName, islands, bbox, BOX_H };
}

function curve(pts) {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i - 1], [x2, y2] = pts[i];
    if (Math.abs(y2 - y1) < 0.5) { d += ` L${x2},${y2}`; continue; }
    const dx = (x2 - x1) * 0.5;
    d += ` C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  }
  return d;
}

/* ------------------------------------------------------------------------------------- view */
class MVGraph {
  constructor(el, opts = {}) {
    this.el = el;
    this.opts = opts;
    this.view = { k: 1, x: 0, y: 0 };
    this.svg = svgEl("svg", { role: "img", "aria-label": opts.label || "Company graph" }, el);
    const defs = svgEl("defs", {}, this.svg);
    const mk = (id, cls) => {
      const m = svgEl("marker", { id, viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse", markerUnits: "userSpaceOnUse" }, defs);
      svgEl("path", { d: "M1,1.5 L9,5 L1,8.5 Z", class: cls }, m);
    };
    this.uid = `g${Math.random().toString(36).slice(2, 7)}`;
    mk(`${this.uid}-arrow`, "g-arrow");
    mk(`${this.uid}-arrow-crit`, "g-arrow crit");
    this.root = svgEl("g", {}, this.svg);
    this.layers = { edges: svgEl("g", {}, this.root), pills: svgEl("g", {}, this.root), nodes: svgEl("g", {}, this.root), fx: svgEl("g", {}, this.root) };
    this._bindPanZoom();
    this.ro = new ResizeObserver(() => this._resize());
    this.ro.observe(el);
  }

  /* -------------------------------------------------------------- data */
  setWorld(world) {
    this.world = world;
    this.L = layoutWorld(world);
    this.keyToGroup = {};
    for (const g of this.L.edges) g.keys.forEach((k) => (this.keyToGroup[k] = g));
    this._render();
    this.fit(false);
  }

  _render() {
    const { edges, P, byName, islands } = this.L;
    Object.values(this.layers).forEach((l) => (l.textContent = ""));
    this.nodeEls = {};
    this.edgeEls = {};
    for (const g of edges) {
      if (!g.points) continue;
      const d = curve(g.points);
      const cls = ["g-edge"];
      if (g.conf < 1 && !g.answered) cls.push("uncertain");
      if (g.answered && !g.answered.exists) cls.push("answered-no");
      if (g.soft) cls.push("soft");
      if (g.fed) cls.push("fed");
      const path = svgEl("path", { d, class: cls.join(" "), "marker-end": `url(#${this.uid}-arrow)` }, this.layers.edges);
      const hit = svgEl("path", { d, class: "g-edge-hit" }, this.layers.edges);
      hit.addEventListener("pointerenter", (ev) => this._hoverEdge(g, ev));
      hit.addEventListener("pointermove", (ev) => this._tipMove(ev));
      hit.addEventListener("pointerleave", () => this._unhover());
      hit.addEventListener("click", (ev) => { ev.stopPropagation(); this.opts.onSelect && this.opts.onSelect("link", g.keys[0], g); });
      this.edgeEls[g.id] = { path, hit, g };
      if (g.conf < 1 && !g.answered) {
        const len = path.getTotalLength();
        const mid = path.getPointAtLength(len / 2);
        const gp = svgEl("g", { class: "g-pillg" }, this.layers.pills);
        const label = `${Math.round(g.conf * 100)}%`;
        const wpx = textWidth(label, "600 10px Inter, sans-serif") + 10;
        svgEl("rect", { x: mid.x - wpx / 2, y: mid.y - 8, width: wpx, height: 16, rx: 8, class: "g-pill-bg" }, gp);
        svgEl("text", { x: mid.x, y: mid.y + 3.5, "text-anchor": "middle", class: "g-pill" }, gp).textContent = label;
        this.edgeEls[g.id].pill = gp;
      }
    }
    for (const name of Object.keys(byName)) {
      const n = byName[name], p = P[name];
      if (!p) continue;
      const g = svgEl("g", { class: `g-node ${n.criticality === 3 ? "crit3" : ""}`, transform: `translate(${p.x},${p.y})`, tabindex: "0", role: "button", "aria-label": `${name}, ${n.kind}${n.owner ? ", owned by " + n.owner : ""}` }, this.layers.nodes);
      svgEl("rect", { x: 0, y: -p.h / 2, width: p.w, height: p.h, rx: 2, class: "g-shape" }, g);
      const ic = svgEl("g", { transform: `translate(9,${-6}) scale(.5)`, class: "g-kind", fill: "none", stroke: "currentColor", "stroke-width": "2.2", "stroke-linecap": "round", "stroke-linejoin": "round" }, g);
      ic.innerHTML = ICONS[KIND_ICON[n.kind]] || "";
      const t = svgEl("text", { x: 27, y: 4, class: "g-label" }, g);
      t.textContent = name;
      if (n.criticality === 3) svgEl("rect", { x: p.w - 11, y: -3, width: 6, height: 6, class: "g-crit-dot" }, g);
      g.addEventListener("pointerenter", (ev) => this._hoverNode(name, ev));
      g.addEventListener("pointermove", (ev) => this._tipMove(ev));
      g.addEventListener("pointerleave", () => this._unhover());
      g.addEventListener("click", (ev) => { ev.stopPropagation(); this.opts.onSelect && this.opts.onSelect("asset", name); });
      g.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); this.opts.onSelect && this.opts.onSelect("asset", name); } });
      this.nodeEls[name] = { g, rect: g.firstChild, icon: ic, p };
    }
    if (islands.length) {
      const p = P[islands[0]];
      svgEl("text", { x: p.x, y: p.y - 22, class: "g-group-label" }, this.layers.nodes).textContent = "Not connected to anything";
    }
  }

  /* -------------------------------------------------------------- view: fit, zoom, pan */
  _resize() {
    const r = this.el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const first = !this.size;
    this.size = { w: r.width, h: r.height };
    this.svg.setAttribute("viewBox", `0 0 ${r.width} ${r.height}`);
    if (first || this.autoFit) this.fit(false); else this._apply();
  }

  fit(animate = true, ignoreFocus = false) {
    if (!this.L || !this.size) return;
    if (this.focusNames && !ignoreFocus) return this.fitTo(this.focusNames, this.focusK || 1.2, 0, true);
    const b = this.L.bbox, pad = 24;
    const k = Math.min((this.size.w - pad * 2) / b.w, (this.size.h - pad * 2) / b.h, 1.35);
    const free = this.size.h - b.h * k;
    this.view = { k, x: (this.size.w - b.w * k) / 2 - b.x * k, y: Math.min(free / 2, pad + free * 0.12) - b.y * k };
    this.autoFit = true;
    this._apply(animate);
  }

  /* keep a set of assets in view whenever the graph is resized (null = the whole company) */
  focus(names, maxK = 1.2) {
    this.focusNames = names && names.length ? names : null;
    this.focusK = maxK;
    this.fit();
  }

  /* zoom to a set of assets (what a rehearsal or a future is about), keeping some context */
  fitTo(names, maxK = 1.2, padTop = 0, keepAuto = false) {
    if (!this.L || !this.size) return;
    const ps = names.map((n) => this.L.P[n]).filter(Boolean);
    if (!ps.length) return this.fit(true, true);
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const p of ps) { x1 = Math.min(x1, p.x); x2 = Math.max(x2, p.x + p.w); y1 = Math.min(y1, p.y - p.h / 2 - 12); y2 = Math.max(y2, p.y + p.h / 2); }
    const minW = 520, minH = padTop ? 170 : 220, cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    const bw = Math.max(x2 - x1, minW), bh = Math.max(y2 - y1, minH), pad = 36;
    const full = this.L.bbox;
    const availH = Math.max(160, this.size.h - padTop);
    const k = Math.min((this.size.w - pad * 2) / bw, (availH - pad * 2) / bh, maxK);
    const kFull = Math.min((this.size.w - 48) / full.w, (this.size.h - 48) / full.h, 1.35);
    if (k <= kFull * 1.08 && !padTop) return this.fit(true, true);   // nearly everything: just fit
    // centre on the assets, but never leave empty space beside the company: if the zoomed company
    // is wider (or taller) than the view, slide it so it touches both edges; if it fits, centre it
    let x = this.size.w / 2 - cx * k, y = padTop + availH / 2 - cy * k;
    const edge = 24, gw = full.w * k, gh = full.h * k;
    if (gw + edge * 2 <= this.size.w) x = (this.size.w - gw) / 2 - full.x * k;
    else x = Math.min(edge - full.x * k, Math.max(this.size.w - edge - (full.x + full.w) * k, x));
    if (gh + edge * 2 <= availH) { const free = availH - gh; y = padTop + Math.min(free / 2, edge + free * 0.12) - full.y * k; }
    else y = Math.min(padTop + edge - full.y * k, Math.max(this.size.h - edge - (full.y + full.h) * k, y));
    this.view = { k, x, y };
    this.autoFit = keepAuto;
    this._apply(true);
  }

  zoom(f, cx, cy) {
    if (!this.size) return;
    cx ??= this.size.w / 2; cy ??= this.size.h / 2;
    const k = Math.max(0.3, Math.min(3, this.view.k * f));
    const r = k / this.view.k;
    this.view = { k, x: cx - (cx - this.view.x) * r, y: cy - (cy - this.view.y) * r };
    this.autoFit = false;
    this._apply();
  }

  centerOn(name, rightInset = 0) {
    const p = this.L && this.L.P[name];
    if (!p || !this.size) return;
    const k = Math.max(this.view.k, 1);
    this.view = { k, x: (this.size.w - rightInset) / 2 - (p.x + p.w / 2) * k, y: this.size.h / 2 - p.y * k };
    this.autoFit = false;
    this._apply(true);
  }

  _apply(animate) {
    const { k, x, y } = this.view;
    this.root.style.transition = animate && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "transform 260ms cubic-bezier(.2,.8,.2,1)" : "none";
    this.root.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
  }

  _bindPanZoom() {
    let drag = null;
    this.el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest(".g-node") || e.target.closest(".g-edge-hit")) return;
      drag = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y, moved: false, id: e.pointerId };
      this.el.setPointerCapture(e.pointerId);
    });
    this.el.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      this.el.classList.add("dragging");
      this.view.x = drag.vx + dx; this.view.y = drag.vy + dy;
      this.autoFit = false;
      this._apply();
    });
    const end = (e) => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      this.el.classList.remove("dragging");
      if (!moved && this.opts.onBackground) this.opts.onBackground();
    };
    this.el.addEventListener("pointerup", end);
    this.el.addEventListener("pointercancel", end);
    this.el.addEventListener("wheel", (e) => {
      if (!e.ctrlKey && !e.metaKey) return;              // plain wheel scrolls the page
      e.preventDefault();
      const r = this.el.getBoundingClientRect();
      this.zoom(Math.exp(-e.deltaY * 0.0022), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
  }

  /* -------------------------------------------------------------- hover + tooltip */
  _tip() { return document.getElementById("tip"); }
  _tipMove(ev) {
    const t = this._tip();
    if (!t || t.hidden) return;
    const pad = 14, r = t.getBoundingClientRect();
    let x = ev.clientX + pad, y = ev.clientY + pad;
    if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - pad;
    if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - pad;
    t.style.left = `${x}px`; t.style.top = `${y}px`;
  }
  _showTip(html, ev) {
    const t = this._tip();
    if (!t) return;
    t.innerHTML = html;
    t.hidden = false;
    this._tipMove(ev);
  }
  _hoverNode(name, ev) {
    const n = this.L.byName[name];
    const extra = this.opts.nodeTip ? this.opts.nodeTip(name) : "";
    this._showTip(`<b>${escapeHtml(name)}</b><span>${escapeHtml(n.kind)}${n.owner ? ", owned by " + escapeHtml(n.owner) : ""}${n.criticality === 3 ? ", business-critical" : ""}</span>${n.note ? `<br><span>${escapeHtml(n.note)}</span>` : ""}${extra}`, ev);
    const lit = new Set([name]), edges = new Set();
    for (const g of this.L.edges) if (g.from === name || g.to === name) { lit.add(g.from); lit.add(g.to); edges.add(g.id); }
    this.hoverLit = { nodes: lit, edges };
    this._applyDim();
  }
  _hoverEdge(g, ev) {
    const parts = g.links.map((l) => {
      const conf = l.answered ? (l.answered.exists ? "a team confirmed it" : "a team said it does not exist") : (l.confidence < 1 ? `${Math.round(l.confidence * 100)}% sure` : "certain");
      return `${escapeHtml(g.from)} ${REL_WORD[l.rel] || l.rel} ${escapeHtml(g.to)}: ${conf}${l.soft ? ", works without it" : ""}`;
    });
    this._showTip(`<b>${escapeHtml(g.from)} → ${escapeHtml(g.to)}</b><span>${parts.join("<br>")}</span>`, ev);
    this.hoverLit = { nodes: new Set([g.from, g.to]), edges: new Set([g.id]) };
    this._applyDim();
  }
  _unhover() {
    const t = this._tip();
    if (t) t.hidden = true;
    this.hoverLit = null;
    this._applyDim();
  }

  /* -------------------------------------------------------------- dimming: a hover wins over a state */
  _applyDim() {
    const lit = this.hoverLit || this.stateLit;
    this.svg.querySelectorAll(".lit").forEach((e) => e.classList.remove("lit"));
    this.svg.classList.toggle("dimmed", !!lit);
    if (!lit) return;
    for (const n of lit.nodes) if (this.nodeEls[n]) this.nodeEls[n].g.classList.add("lit");
    for (const id of lit.edges) { const e = this.edgeEls[id]; if (e) { e.path.classList.add("lit"); if (e.pill) e.pill.classList.add("lit"); } }
  }
  undim() {
    this.stateLit = null;
    this._applyDim();
  }

  /* -------------------------------------------------------------- state overlays */
  clear() {
    if (!this.L) return;
    this._token = (this._token || 0) + 1;              // cancels running animations
    const nodeCls = ["origin", "deleted", "broken", "minor", "stale", "degraded", "overloaded", "ok", "near", "over", "hl", "island", "sel"];
    for (const n of Object.values(this.nodeEls)) { n.g.classList.remove(...nodeCls); n.g.style.opacity = ""; }
    for (const e of Object.values(this.edgeEls)) { e.path.classList.remove("path", "hl", "missing", "idle", "added", "removed"); e.path.setAttribute("marker-end", `url(#${this.uid}-arrow)`); }
    this.layers.fx.textContent = "";
    this.undim();
    if (this.selected) this.select(this.selected);
  }

  select(name) {
    this.selected = name;
    for (const [n, e] of Object.entries(this.nodeEls || {})) e.g.classList.toggle("sel", n === name);
  }

  nodeClass(name, cls) { const n = this.nodeEls[name]; if (n) n.g.classList.add(...cls.split(" ").filter(Boolean)); }
  edgeClassByKey(key, cls) { const g = this.keyToGroup[key]; if (g && this.edgeEls[g.id]) this.edgeEls[g.id].path.classList.add(cls); return g; }
  groupIdOf(key) { const g = this.keyToGroup[key]; return g ? g.id : null; }

  badge(name, text, tone = "crit") {
    const n = this.nodeEls[name];
    if (!n) return;
    const color = { crit: MVC.signal, minor: MVC.gray, clear: MVC.ink, accent: MVC.ink, chance: MVC.ink, plain: MVC.ink2 }[tone] || tone;
    const p = n.p;
    const w = textWidth(text, "600 10.5px \"JetBrains Mono\", monospace") + 12;
    const g = svgEl("g", { transform: `translate(${p.x + p.w - w - 4},${p.y - p.h / 2})`, class: "g-badgeg" }, this.layers.fx);
    svgEl("rect", { x: 0, y: -7.5, width: w, height: 15, rx: 0, fill: color, stroke: color, class: "g-badge-bg" }, g);
    svgEl("text", { x: w / 2, y: 3.6, "text-anchor": "middle", fill: tone === "crit" ? MVC.ink : MVC.white, class: "g-badge" }, g).textContent = text;
  }

  ring(name, color, pulse = true) {
    const n = this.nodeEls[name];
    if (!n) return;
    const p = n.p;
    svgEl("rect", { x: p.x - 4, y: p.y - p.h / 2 - 4, width: p.w + 8, height: p.h + 8, rx: 3, class: `g-ring ${pulse ? "pulse" : ""}`, stroke: color }, this.layers.fx);
  }

  kindIcon(name, iconName, color) {
    const n = this.nodeEls[name];
    if (!n) return;
    n.icon.innerHTML = ICONS[iconName] || "";
    n.icon.style.color = color || "";
  }

  resetIcons() {
    for (const [name, n] of Object.entries(this.nodeEls || {})) {
      n.icon.innerHTML = ICONS[KIND_ICON[this.L.byName[name].kind]] || "";
      n.icon.style.color = "";
    }
  }

  dimExcept(names, keys = []) {
    const ids = new Set(keys.map((k) => this.groupIdOf(k)).filter(Boolean));
    this.stateLit = { nodes: new Set(names), edges: ids };
    this._applyDim();
  }

  /* a spark travelling along a link, from the dependency to the asset that depends on it */
  spark(key, ms = 520) {
    const g = this.keyToGroup[key];
    if (!g || !this.edgeEls[g.id] || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const path = this.edgeEls[g.id].path;
    const len = path.getTotalLength();
    const dot = svgEl("circle", { r: 4, class: "g-spark" }, this.layers.fx);
    const t0 = performance.now();
    const token = this._token;
    const step = (now) => {
      if (token !== this._token) { dot.remove(); return; }
      const f = Math.min(1, (now - t0) / ms);
      const pt = path.getPointAtLength(len * (1 - f));     // against the arrow
      dot.setAttribute("cx", pt.x); dot.setAttribute("cy", pt.y);
      if (f < 1) requestAnimationFrame(step); else dot.remove();
    };
    requestAnimationFrame(step);
  }

  markX(name) {
    const n = this.nodeEls[name];
    if (!n) return;
    n.icon.innerHTML = '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>';
    n.icon.style.color = "";
  }

  token() { return this._token; }

  /* normalised positions for the small copies of the company drawn in each future's square */
  normalized() {
    const out = {};
    const b = this.L.bbox;
    for (const [name, p] of Object.entries(this.L.P)) {
      if (name.startsWith("~")) continue;
      out[name] = [(p.x + p.w / 2 - b.x) / b.w, (p.y - b.y) / b.h];
    }
    return out;
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
