"use strict";
/* Multiverse console, build 5 (editorial). Every number on screen comes from the server (FalkorDB); nothing here is
   precomputed. Live parts are Server-Sent Events that read the memory graph, so a rehearsal started
   by Claude Desktop through MCP shows up exactly like one started here. */

/* ======================================================================= helpers */
const $ = (id) => document.getElementById(id);
const esc = escapeHtml;
const LOCALE = undefined;                                  // the browser's own locale
const PCT = new Intl.NumberFormat(LOCALE, { style: "percent", maximumFractionDigits: 0 });
const PCT1 = new Intl.NumberFormat(LOCALE, { style: "percent", maximumFractionDigits: 1 });
const pct = (x, d = 0) => (x == null || isNaN(x) ? "–" : (d ? PCT1 : PCT).format(x));
const DT = new Intl.DateTimeFormat(LOCALE, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat(LOCALE, { weekday: "short", day: "numeric", month: "short" });
const CLOCK = new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const HM = new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit" });
const YMD = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short", year: "numeric" });
const parse = (iso) => { const d = new Date(iso); return isNaN(d) ? null : d; };
const when = (iso) => { const d = parse(iso); return d ? DT.format(d) : String(iso || ""); };
const clock = (iso) => { const d = parse(iso); return d ? CLOCK.format(d) : ""; };
const dayOf = (iso) => { const d = parse(iso); return d ? DAY.format(d) : ""; };
const hm = (iso) => { const d = parse(iso); return d ? HM.format(d) : ""; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)");
const wait = (ms) => sleep(REDUCED.matches ? 0 : ms);
const storage = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private window */ } },
};

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch (_) { /* not JSON */ }
  if (!res.ok) throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
  return data;
}
const post = (path, data) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data || {}) });

function hydrateIcons(root = document) {
  const map = { play: "play", plus: "plus", shield: "shield-check", stop: "square", plane: "plane", ask: "message-square-text", route: "route", tour: "circle-help", reset: "rotate-ccw" };
  root.querySelectorAll("[class^='i-'], [class*=' i-']").forEach((el) => {
    const cls = [...el.classList].find((c) => c.startsWith("i-"));
    if (!cls || el.dataset.done) return;
    el.outerHTML = icon(map[cls.slice(2)] || cls.slice(2), 16);
  });
}

const REL_3RD = { CALLS: "calls", READS: "reads", WRITES: "writes to", USES_SECRET: "uses", DEPENDS_ON: "depends on", FED_BY: "is fed by" };
const REL_BASE = { CALLS: "call", READS: "read", WRITES: "write to", USES_SECRET: "use", DEPENDS_ON: "depend on", FED_BY: "get data from" };
const relWord = (r) => REL_3RD[r] || String(r || "").toLowerCase();
const relBase = (r) => REL_BASE[r] || String(r || "").toLowerCase();
const STATUS_WORD = { deleted: "deleted", overloaded: "overloaded", broken: "broken", stale: "goes stale", degraded: "degraded", offline: "offline", rotated: "rotated" };
const CLIENTS = { "claude-ai": ["Claude Desktop", "claude"], "multiverse-agent": ["agent.py", "agentpy"], "multiverse-console": ["Console", "console"], "": ["Console", "console"] };
function clientBadge(c) {
  const [name, cls] = CLIENTS[c ?? ""] || [c || "MCP client", ""];
  return `<span class="client ${cls}">${esc(name)}</span>`;
}
const isExternal = (c) => c && c !== "multiverse-console";

/* ======================================================================= toasts, dialogs */
function toast(title, body = "", kind = "", action = null, ms = 6500) {
  const box = $("toasts");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === "bad" ? "circle-alert" : kind === "good" ? "circle-check" : "activity", 16)}
    <div class="body"><b>${esc(title)}</b>${body ? `<span class="muted small">${esc(body)}</span>` : ""}</div>`;
  if (action) {
    const b = document.createElement("button");
    b.className = "btn small";
    b.textContent = action.label;
    b.onclick = () => { action.run(); el.remove(); };
    el.appendChild(b);
  }
  box.appendChild(el);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => el.remove(), ms);
}

function confirmDialog({ title, body, confirm = "Confirm", danger = false, cancel = "Cancel" }) {
  return new Promise((resolve) => {
    const root = $("dialog-root");
    root.hidden = false;
    root.innerHTML = `<div class="scrim" data-close><div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dlg-t" aria-describedby="dlg-b">
      <h2 id="dlg-t">${esc(title)}</h2><p id="dlg-b">${esc(body)}</p>
      <div class="actions"><button class="btn" data-no>${esc(cancel)}</button><button class="btn ${danger ? "danger" : "primary"}" data-yes>${esc(confirm)}</button></div></div></div>`;
    const done = (v) => { root.hidden = true; root.innerHTML = ""; document.removeEventListener("keydown", onKey); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") done(false); };
    document.addEventListener("keydown", onKey);
    root.querySelector("[data-yes]").onclick = () => done(true);
    root.querySelector("[data-no]").onclick = () => done(false);
    root.querySelector(".scrim").onclick = (e) => { if (e.target.hasAttribute("data-close")) done(false); };
    root.querySelector("[data-yes]").focus();
  });
}

function notice(id, text, kind = "") {
  const n = $(id);
  if (!n) return;
  n.hidden = !text;
  n.className = `notice ${kind}`;
  n.innerHTML = text ? `${icon(kind === "bad" ? "circle-alert" : kind === "good" ? "circle-check" : "info", 16)}<span>${esc(text)}</span>` : "";
}

/* ======================================================================= state */
const S = {
  status: null, world: null, scenarios: [], twoAgents: [], plan: { title: "", steps: [] }, planAgent: "you",
  scenarioId: null, mode: "decide", run: null, es: null, summary: null, executing: null, selfChangedAt: 0,
  feed: [], plans: [], inbox: [], insights: null, overlay: "plain", selected: null, launch: null,
  page: null, graphs: {}, tourOn: false,
};

/* ======================================================================= plans in plain words */
function describeStep(s) {
  switch (s.action) {
    case "delete": return `Delete ${s.asset}`;
    case "offline": return `Take ${s.asset} offline ${when(s.start)} for ${s.hours} h`;
    case "rotate_secret": return `Rotate ${s.asset}`;
    case "launch": return `Launch: ${s.surge}× traffic (1 in 10: over ${s.surge_p90 ?? s.surge}×) for ${s.hours ?? 6} h${s.start ? " from " + when(s.start) : ""}`;
    case "repoint": return `Point ${s.asset} at ${s.new} instead of ${s.old}`;
    case "reschedule": return `Move ${s.asset} to ${s.schedule}`;
    case "scale": return `Scale ${s.asset} ×${s.factor}`;
    case "add_service": return `Add a new service ${s.asset}`;
    case "assume": { const [a, r, b] = s.link.split("|"); return `What if ${a} ${relWord(r)} ${b} is ${pct(s.confidence)} likely`; }
    default: return JSON.stringify(s);
  }
}
const planTitle = (p) => p.title || (p.steps.length <= 2 ? p.steps.map(describeStep).join(", then ")
  : `${describeStep(p.steps[p.steps.length - 1])}, after ${p.steps.length - 1} other steps`);
const SCEN_ICON = { "cleanup-archive": "trash-2", "delete-legacy-db": "trash-2", "delete-export": "trash-2", "migrate-billing": "arrow-right-left", "rotate-key": "key-round", "replica-maintenance": "wrench", "festival-sale": "rocket", "festival-sale-scaled": "trending-up", "gift-cards": "gift" };
const node = (name) => S.world && S.world.nodes.find((n) => n.name === name);
const isCrit3 = (name) => { const n = node(name); return !!n && n.criticality === 3; };
function nextHour(h = 1) {
  const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + h);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:00`;
}

/* ======================================================================= router + nav */
const PAGES = [
  { id: "home", label: "Home", icon: "layers", short: "Home" },
  { id: "rehearse", label: "Rehearse", icon: "flask-conical", short: "Rehearse", desc: "Play a change in many copies of the company" },
  { id: "launch", label: "Launch day", icon: "rocket", short: "Launch", desc: "What breaks if traffic spikes" },
  { id: "agents", label: "Agents", icon: "radar", short: "Agents", desc: "Air traffic control for AI agents" },
  { id: "company", label: "Company graph", icon: "network", short: "Company", desc: "The graph, its evidence and its algorithms" },
  { id: "inbox", label: "Inbox", icon: "inbox", short: "Inbox", desc: "Questions for the teams, and what was learned" },
  { id: "how", label: "How it works", icon: "book-open", short: "How", desc: "Six steps, all in FalkorDB" },
];
function renderNav() {
  $("nav").innerHTML = PAGES.filter((p) => p.id !== "home").map((p) => `<a href="#/${p.id}" data-page="${p.id}" title="${esc(p.label)}"><span class="label">${esc(p.short || p.label)}</span>${p.id === "inbox" ? '<span class="badge" id="inbox-badge" hidden>0</span>' : ""}</a>`).join("");
  const m = $("menu-links");
  if (m) m.innerHTML = PAGES.map((p, i) => `<a href="#/${p.id}" data-page="${p.id}" style="--i:${i}"><span class="ml-n">${String(i).padStart(2, "0")}</span><span class="ml-t">${esc(p.label)}</span><span class="ml-d">${esc(p.desc || "Rehearsals for AI agents")}</span></a>`).join("");
}
function go(page, extra = "") { location.hash = `#/${page}${extra ? "/" + extra : ""}`; }
function route() {
  const [page = "home", ...rest] = location.hash.replace(/^#\/?/, "").split("/");
  const id = PAGES.some((p) => p.id === page) ? page : "home";
  const changed = S.page !== id;
  if (S.page && changed) $("main").scrollTop = 0;
  document.querySelectorAll(".page").forEach((p) => p.classList.toggle("active", p.dataset.page === id));
  document.querySelectorAll("#nav a, #menu-links a").forEach((a) => (a.getAttribute("data-page") === id ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  S.page = id;
  document.body.dataset.page = id;
  document.title = id === "home" ? "Multiverse — rehearsals for AI agents" : `Multiverse: ${PAGES.find((p) => p.id === id).label}`;
  if (changed) document.dispatchEvent(new CustomEvent("mv:page", { detail: id }));
  const g = S.graphs[id];
  if (g) requestAnimationFrame(() => g._resize());
  if (id === "launch") loadLaunch();
  if (id === "agents") { loadPlans(); renderConnect(); renderFeed(); }
  if (id === "company") { loadInsights(); if (rest[0] === "asset" && rest[1]) selectThing("asset", decodeURIComponent(rest[1])); if (rest[0] === "link" && rest[1]) selectThing("link", decodeURIComponent(rest[1])); }
  if (id === "inbox") loadInbox();
  if (id === "how") renderHow();
  if (id === "rehearse" && rest[0] && (!S.run || S.run.rid !== rest[0])) openStream(rest[0]);
}
addEventListener("hashchange", route);

/* ======================================================================= boot */
async function loadStatus() {
  S.status = await api("/api/status");
  const f = S.status.falkordb;
  $("db-dot").className = "dot ok";
  $("db-line").textContent = `FalkorDB ${f.version}, ${S.status.algorithms.length} graph algorithms`;
  renderAgentsLine();
}
function renderAgentsLine() {
  const agents = (S.status && S.status.agents) || [];
  const ext = agents.filter((a) => isExternal(a.client));
  $("agents-dot").className = `dot ${ext.length ? "ok" : ""}`;
  $("agents-line").textContent = agents.length ? `${agents.length} agent${agents.length > 1 ? "s" : ""} seen${ext.length ? `, ${ext.map((a) => (CLIENTS[a.client] || [a.client])[0]).filter((v, i, x) => x.indexOf(v) === i).join(", ")}` : ""}` : "No AI agent connected yet";
}

async function loadWorld() {
  S.world = await api("/api/world");
  window.mvWorld = S.world;
  document.dispatchEvent(new CustomEvent("mv:world", { detail: S.world }));
  if ($("h-assets")) { $("h-assets").dataset.count = S.world.nodes.length; $("h-assets").textContent = S.world.nodes.length; $("h-links").textContent = S.world.edges.length; }
  for (const id of ["rehearse", "launch", "company"]) S.graphs[id] && S.graphs[id].setWorld(S.world);
  buildSilhouette();
  const real = S.world.nodes.filter((n) => n.source === "online-boutique").length;
  $("g1-sub").textContent = `${S.world.nodes.length} assets, ${real} of them from Google's real Kubernetes file`;
  fillAssetSelects();
  renderCounts();
  if (S.summary) showHeat(S.summary);
  if (S.page === "launch") paintLaunch();
}

function fillAssetSelects() {
  const opts = S.world.nodes.map((n) => n.name).sort().map((n) => `<option>${esc(n)}</option>`).join("");
  for (const id of ["path-a", "path-b", "mem-asset"]) {
    const el = $(id);
    const cur = el.value;
    el.innerHTML = opts;
    if (cur && S.world.nodes.some((n) => n.name === cur)) el.value = cur;
  }
  if (!$("path-a").dataset.set) { $("path-a").value = "payouts"; $("path-b").value = "legacy_orders_db"; $("path-a").dataset.set = 1; }
  if (!$("mem-asset").dataset.set) { $("mem-asset").value = "orders_archive"; $("mem-asset").dataset.set = 1; }
}

async function loadScenarios() {
  const d = await api("/api/scenarios");
  S.scenarios = d.presets;
  S.twoAgents = d.two_agents;
  $("scenarios").innerHTML = d.presets.map((p) => `<button class="scenario" type="button" data-id="${esc(p.id)}" aria-pressed="false" title="${esc(p.story)}">${icon(SCEN_ICON[p.id] || "play", 15)}<span>${esc(shortTitle(p))}</span></button>`).join("");
  $("scenarios").querySelectorAll(".scenario").forEach((b) => (b.onclick = () => pickScenario(b.dataset.id)));
  if (!S.plan.steps.length) pickScenario(d.presets[0].id);
}
function shortTitle(p) {
  return ({ "cleanup-archive": "Clean up the old archive", "delete-legacy-db": "Delete the legacy orders DB", "delete-export": "Delete an old CSV export", "migrate-billing": "Migrate billing, then delete", "rotate-key": "Rotate the payment key", "replica-maintenance": "Replica maintenance", "festival-sale": "Festival sale 3×", "festival-sale-scaled": "Sale + scaling advice", "gift-cards": "Launch gift cards" })[p.id] || p.title;
}
function pickScenario(id) {
  const p = S.scenarios.find((x) => x.id === id);
  if (!p) return;
  S.scenarioId = id;
  S.planAgent = p.agent || "you";
  S.plan = JSON.parse(JSON.stringify(p.plan));
  $("plan-story").textContent = p.story;
  renderPlan();
  previewPlan();
}
/* a new plan replaces the last result on screen, and the graph previews what the plan touches */
function previewPlan() {
  const g = S.graphs.rehearse;
  if (!g || !g.L || (S.run && !S.run.done)) return;
  if (S.es) S.es.close();
  S.summary = null; S.run = null; S.viewing = null;
  $("future-banner").hidden = true;
  $("details").hidden = true;
  resetLanes(); pipeline("init"); renderVerdict("idle");
  g.clear(); g.resetIcons();
  markOrigins(S.plan, g);
  const names = blastRadius(S.plan);
  if (names.length && S.previewZoom) { g.dimExcept(names); if (S.page === "rehearse") g.fitTo(names, 1.05); }
  S.previewZoom = true;
}

/* ======================================================================= rehearse: the plan */
function renderPlan() {
  const steps = S.plan.steps;
  const pills = steps.length ? steps.map((s, i) => `<span class="step-pill">${steps.length > 1 ? `<span class="n">${i + 1}</span>` : ""}<span class="txt">${esc(describeStep(s))}</span><button type="button" data-i="${i}" aria-label="Remove step ${i + 1}">${icon("x", 14)}</button></span>`).join("")
    : '<span class="faint">no steps yet: pick a scenario or add a step</span>';
  $("plan-sentence").innerHTML = `<span class="who">${esc(S.planAgent)}</span><span class="verb">wants to</span>${pills}`;
  $("plan-sentence").querySelectorAll("button[data-i]").forEach((b) => (b.onclick = () => {
    S.plan.steps.splice(Number(b.dataset.i), 1);
    S.plan.title = "";
    markCustom();
    renderPlan();
  }));
  $("scenarios").querySelectorAll(".scenario").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.id === S.scenarioId)));
}
function markCustom() {
  if (S.scenarioId) { S.scenarioId = null; S.planAgent = "you"; $("plan-story").textContent = "Your own plan."; }
}
function addStep(step) {
  markCustom();
  const launchAt = S.plan.steps.findIndex((s) => s.action === "launch");
  if (step.action === "scale" && launchAt >= 0) S.plan.steps.splice(launchAt, 0, step); else S.plan.steps.push(step);
  S.plan.title = "";
  renderPlan();
}

const ACTIONS = [
  ["delete", "Delete an asset"], ["offline", "Take an asset offline for a while"], ["rotate_secret", "Rotate a secret"],
  ["launch", "Launch: a traffic surge"], ["repoint", "Point an asset at something else"], ["reschedule", "Move a job to a new schedule"],
  ["scale", "Scale a service"], ["assume", "What if a link were more or less likely"],
];
function renderStepFields() {
  const box = $("add-step-fields");
  const a = box.querySelector("#f-action")?.value || "delete";
  const assets = (f = () => true) => S.world.nodes.filter(f).map((n) => n.name).sort().map((n) => `<option>${esc(n)}</option>`).join("");
  const sel = (id, label, opts) => `<label class="field"><span>${label}</span><select id="${id}">${opts}</select></label>`;
  const inp = (id, label, value, type = "text", extra = "") => `<label class="field"><span>${label}</span><input id="${id}" type="${type}" value="${esc(value)}" autocomplete="off" ${extra}></label>`;
  let html = sel("f-action", "Step", ACTIONS.map(([v, l]) => `<option value="${v}" ${v === a ? "selected" : ""}>${esc(l)}</option>`).join(""));
  if (a === "delete") html += sel("f-asset", "Asset", assets());
  if (a === "offline") html += sel("f-asset", "Asset", assets()) + inp("f-start", "Start", nextHour(2), "datetime-local") + inp("f-hours", "Hours", 3, "number", 'min="1" max="336"');
  if (a === "rotate_secret") html += sel("f-asset", "Secret", assets((n) => n.kind === "Secret"));
  if (a === "launch") html += inp("f-surge", "Traffic (× normal)", 3, "number", 'min="1" step="0.5"') + inp("f-p90", "1 in 10: over (×)", 6, "number", 'min="1" step="0.5"') + inp("f-hours", "Hours", 6, "number") + inp("f-start", "Start", nextHour(24), "datetime-local");
  if (a === "repoint") html += sel("f-asset", "Asset", assets((n) => S.world.edges.some((e) => e.from === n.name))) + sel("f-old", "Stop using", "") + sel("f-new", "Use instead", assets());
  if (a === "reschedule") html += sel("f-asset", "Job", assets((n) => n.kind === "Job" && n.schedule)) + inp("f-schedule", "New schedule", "daily@02:00");
  if (a === "scale") html += sel("f-asset", "Service", assets((n) => n.capacity != null)) + inp("f-factor", "Factor", 2, "number", 'min="0.5" max="20" step="0.5"');
  if (a === "assume") {
    const links = S.world.edges.filter((e) => e.key).sort((x, y) => x.confidence - y.confidence);
    html += sel("f-link", "Link", links.map((e) => `<option value="${esc(e.key)}">${esc(e.from)} ${relWord(e.rel)} ${esc(e.to)} (${pct(e.confidence)})</option>`).join("")) + inp("f-conf", "Assume (%)", 90, "number", 'min="0" max="100"');
  }
  box.innerHTML = html;
  box.querySelector("#f-action").onchange = renderStepFields;
  if (a === "repoint") {
    const fill = () => { const src = $("f-asset").value; $("f-old").innerHTML = S.world.edges.filter((e) => e.from === src).map((e) => `<option>${esc(e.to)}</option>`).join(""); };
    $("f-asset").onchange = fill; fill();
  }
}
function readStep() {
  const a = $("f-action").value, v = (id) => $(id) && $(id).value;
  switch (a) {
    case "delete": return { action: a, asset: v("f-asset") };
    case "offline": return { action: a, asset: v("f-asset"), start: v("f-start"), hours: Number(v("f-hours")) };
    case "rotate_secret": return { action: a, asset: v("f-asset") };
    case "launch": return { action: a, surge: Number(v("f-surge")), surge_p90: Number(v("f-p90")), hours: Number(v("f-hours")), start: v("f-start") };
    case "repoint": return { action: a, asset: v("f-asset"), old: v("f-old"), new: v("f-new") };
    case "reschedule": return { action: a, asset: v("f-asset"), schedule: v("f-schedule") };
    case "scale": return { action: a, asset: v("f-asset"), factor: Number(v("f-factor")) };
    case "assume": return { action: a, link: v("f-link"), confidence: Number(v("f-conf")) / 100 };
  }
  return null;
}

/* ======================================================================= rehearse: running */
function runOptions() {
  const seed = $("seed").value.trim();
  return { seed: seed || null, mode: S.mode === "decide" ? "decide" : "precise", futures: S.mode === "decide" ? null : Number(S.mode) };
}
async function startRehearsal(plan = S.plan) {
  if (!plan.steps.length) { notice("plan-notice", "Add at least one step first.", "bad"); return null; }
  notice("plan-notice", "");
  try {
    const { rid } = await post("/api/rehearse", { plan: { title: planTitle(plan), steps: plan.steps }, by: S.planAgent === "you" ? "console" : S.planAgent, ...runOptions() });
    if (S.page !== "rehearse") go("rehearse");
    openStream(rid);
    requestAnimationFrame(() => $("stage").scrollIntoView({ behavior: REDUCED.matches ? "auto" : "smooth", block: "start" }));
    return rid;
  } catch (e) { notice("plan-notice", e.message, "bad"); return null; }
}

async function executeForReal(plan = S.plan, acceptMinor = false) {
  if (!plan.steps.length) return;
  if (!acceptMinor) {
    const ok = await confirmDialog({ title: "Change the real company?", body: `“${planTitle(plan)}”. Multiverse runs a fresh rehearsal first. Only a SAFE verdict lets it through, applied with the same Cypher that was rehearsed.`, confirm: "Rehearse, then execute", danger: true });
    if (!ok) return;
  }
  try {
    const { rid } = await post("/api/execute", { plan: { title: planTitle(plan), steps: plan.steps }, accept_minor: acceptMinor });
    S.executing = rid;
    openStream(rid);
  } catch (e) { notice("plan-notice", e.message, "bad"); }
}

function openStream(rid) {
  if (S.es) S.es.close();
  S.run = { rid, n: 0, points: [], meta: null, done: false, counts: { critical: 0, minor: 0, clear: 0 }, hits: {}, lastFuture: null };
  S.summary = null;
  S.viewing = null;
  $("future-banner").hidden = true;
  $("details").hidden = true;
  $("stop").hidden = false;
  $("run").disabled = true;
  $("execute").disabled = true;
  resetLanes();
  renderVerdict("starting");
  pipeline("start");
  const g = S.graphs.rehearse;
  g.clear(); g.resetIcons();
  const es = new EventSource(`/api/rehearsals/${rid}/stream`);
  S.es = es;
  es.addEventListener("meta", (e) => onMeta(JSON.parse(e.data)));
  es.addEventListener("future", (e) => onFuture(JSON.parse(e.data)));
  es.addEventListener("progress", (e) => onProgress(JSON.parse(e.data)));
  es.addEventListener("done", (e) => { es.close(); onDone(JSON.parse(e.data)); });
  es.addEventListener("failed", (e) => {
    es.close();
    endRun();
    renderVerdict("idle");
    notice("plan-notice", `The rehearsal failed: ${JSON.parse(e.data).error}`, "bad");
  });
}

function onMeta(m) {
  S.run.meta = m;
  const dense = m.mode === "precise" && m.target_futures > 150;
  setDense(dense);
  pipeline("meta", m);
  markOrigins(m.plan, S.graphs.rehearse);
  S.graphs.rehearse.fitTo(blastRadius(m.plan), 1.05);
  if (m.status === "done") $("field-sub").textContent = "Finished earlier: showing the stored futures";
  else $("field-sub").textContent = m.mode === "exact" ? "Exact: nothing uncertain, one future is enough" : m.mode === "precise" ? `${m.target_futures} futures, one copy each` : "Adds futures until the answer is clear";
  renderVerdict("running");
  if (isExternal(m.client)) toast(`Following ${m.by}'s rehearsal`, `${m.title} (started via ${(CLIENTS[m.client] || [m.client])[0]})`);
}

/* everything a plan could reach: the assets it names plus everything that depends on them */
function blastRadius(plan) {
  if (!plan || !plan.steps || !S.world) return [];
  const names = new Set();
  for (const s of plan.steps) {
    ["asset", "old", "new"].forEach((f) => s[f] && names.add(s[f]));
    if (s.link) { const [a, , b] = s.link.split("|"); names.add(a); names.add(b); }
    if (s.action === "launch") S.world.nodes.filter((n) => n.capacity != null).forEach((n) => names.add(n.name));
  }
  let frontier = [...names];
  while (frontier.length) {
    const next = [];
    for (const e of S.world.edges) if (frontier.includes(e.to) && !names.has(e.from)) { names.add(e.from); next.push(e.from); }
    frontier = next;
  }
  return [...names];
}

function markOrigins(plan, g) {
  if (!plan || !plan.steps) return;
  for (const s of plan.steps) {
    if (s.action === "delete") { g.nodeClass(s.asset, "deleted"); g.markX(s.asset); }
    if (s.action === "offline" || s.action === "rotate_secret") g.nodeClass(s.asset, "origin");
    if (s.action === "launch" && S.world.meta) g.ring(S.world.meta.traffic_entry, MVC.signal, true);
  }
}

let heatTimer = null;
function onFuture(f) {
  const r = S.run;
  r.n = Math.max(r.n, f.i);
  r.counts[f.outcome] = (r.counts[f.outcome] || 0) + 1;
  for (const [name, status] of Object.entries(f.hit || {})) {
    const h = (r.hits[name] ||= { n: 0, crit: 0 });
    h.n += 1;
    if (["broken", "overloaded", "deleted"].includes(status) && isCrit3(name)) h.crit += 1;
  }
  r.lastFuture = f;
  if (r.n > 150 && !$("futures").classList.contains("dense")) setDense(true);
  addTile(f);
  updateSplit();
  pipeline("future", f);
  if (!heatTimer) heatTimer = setTimeout(() => { heatTimer = null; liveHeat(); }, 220);
}

function onProgress(p) {
  if (!p.futures) return;
  S.run.points.push(p);
  S.run.progress = p;
  renderVerdict("running");
}

async function onDone(s) {
  S.summary = s;
  S.run.done = true;
  endRun();
  liveHeat(true);
  pipeline("done", s);
  renderVerdict("done", s);
  renderDetails(s);
  showHeat(s);
  refreshInbox();
  if (S.executing === s.rid) await finishExecution(s);
  if (S.tourWaiter) { const w = S.tourWaiter; S.tourWaiter = null; w(s); }
}

function endRun() {
  $("stop").hidden = true;
  $("run").disabled = false;
  $("execute").disabled = false;
}

async function finishExecution(s) {
  for (let i = 0; i < 60; i++) {
    const out = await api(`/api/executions/${s.rid}`).catch(() => null);
    if (out && out.state !== "checking") {
      S.executing = null;
      if (out.executed) {
        S.selfChangedAt = Date.now();
        await loadWorld();
        toast("Executed on the real company", out.reason, "good");
        renderVerdict("done", s, out);
      } else {
        const minor = out.rehearsal && out.rehearsal.verdict === "REVIEW" && !(out.rehearsal.unverified || []).length;
        renderVerdict("done", s, out);
        if (minor && await confirmDialog({ title: "Only minor things may break", body: `${out.reason} Accept the minor impact and execute?`, confirm: "Accept and execute", danger: true })) {
          executeForReal(s.plan, true);
        } else {
          toast("Not executed", out.reason, "bad", null, 9000);
        }
      }
      return;
    }
    await sleep(250);
  }
  S.executing = null;
}

/* the graph shows, live, how often each asset has broken so far */
function liveHeat(final = false) {
  const r = S.run;
  if (!r || S.viewing) return;
  const g = S.graphs.rehearse;
  g.layers.fx.querySelectorAll(".g-badgeg").forEach((b) => b.remove());
  const n = Math.max(r.n, 1);
  for (const [name, h] of Object.entries(r.hits)) {
    const crit = h.crit > 0;
    const isOrigin = r.meta && r.meta.plan && r.meta.plan.steps.some((s) => s.asset === name && s.action === "delete");
    if (isOrigin) continue;
    g.badge(name, pct(h.n / n), crit ? "crit" : "minor");
    g.nodeEls[name] && g.nodeEls[name].g.classList.toggle(crit ? "broken" : "minor", h.n / n >= 0.5);
  }
  if (final) return;
}

function showHeat(s) {
  const g = S.graphs.rehearse;
  if (S.viewing) return;
  g.clear(); g.resetIcons();
  markOrigins(s.plan, g);
  for (const a of s.affected) {
    if (s.plan.steps.some((st) => st.action === "delete" && st.asset === a.name)) continue;
    g.badge(a.name, pct(a.probability), a.critical ? "crit" : "minor");
    if (a.probability >= 0.5) g.nodeClass(a.name, a.critical ? "broken" : "minor");
  }
  for (const c of s.changes || []) {
    if (c.kind === "link_added") g.edgeClassByKey(c.key, "added");
    if (c.kind === "link_removed") g.edgeClassByKey(c.key, "removed");
  }
}

/* ======================================================================= the multiverse field */
function buildSilhouette() {
  const g = S.graphs.rehearse;
  if (!g || !g.L) return;
  S.norm = g.normalized();
  const pts = Object.values(S.norm).map(([x, y]) => `<circle cx="${(4 + x * 92).toFixed(1)}" cy="${(5 + y * 56).toFixed(1)}" r="2.6"/>`).join("");
  $("sil-defs").innerHTML = `<symbol id="sil" viewBox="0 0 100 66"><g class="tile-sil">${pts}</g></symbol>`;
}
const OUTCOMES = [["critical", "critical broke", "octagon-x", "crit"], ["minor", "only minor broke", "triangle-alert", "minor"], ["clear", "nothing broke", "circle-check", "clear"]];
function resetLanes() {
  $("field-legend").innerHTML = OUTCOMES.map(([id, label, ic, cls]) => `<span class="lane"><span class="lane-top">${icon(ic, 14, cls)}<b id="lane-n-${id}">0</b><span class="share" id="lane-p-${id}"></span></span><span class="lane-label">${esc(label)}</span></span>`).join("");
  $("split-bar").innerHTML = '<i class="critical" style="flex-grow:0"></i><i class="minor" style="flex-grow:0"></i><i class="clear" style="flex-grow:0"></i>';
  $("futures").innerHTML = "";
  setDense(false);
  $("field-note").textContent = "Sorted by outcome. Click a square to open it.";
}
function setDense(on) {
  const f = $("futures");
  f.classList.toggle("dense", on);
  f.style.setProperty("--tile-w", on ? "11px" : "26px");
  f.style.setProperty("--tile-h", on ? "11px" : "18px");
}
function addTile(f) {
  const field = $("futures");
  const b = document.createElement("button");
  b.type = "button";
  b.className = `tile ${f.outcome}`;
  b.dataset.i = f.i;
  b.setAttribute("role", "listitem");
  const broke = Object.entries(f.hit || {}).filter(([, st]) => st !== "deleted").map(([n]) => n);
  const what = f.outcome === "clear" ? "nothing broke" : `${f.outcome === "critical" ? "critical" : "minor"}: ${broke.slice(0, 4).join(", ")}${broke.length > 4 ? "…" : ""}`;
  b.setAttribute("aria-label", `Future ${f.i}, ${what}`);
  b.title = `Future ${f.i}: ${what}`;
  if (S.norm && !field.classList.contains("dense")) {
    let dots = "";
    for (const [name, st] of Object.entries(f.hit || {})) {
      const p = S.norm[name];
      if (!p) continue;
      const cls = st === "deleted" ? "hit-origin" : (["broken", "overloaded"].includes(st) && isCrit3(name)) ? "hit-critical" : "hit-minor";
      dots += `<circle class="${cls}" cx="${(4 + p[0] * 92).toFixed(1)}" cy="${(5 + p[1] * 56).toFixed(1)}" r="7"/>`;
    }
    b.innerHTML = `<svg viewBox="0 0 100 66" preserveAspectRatio="none" aria-hidden="true"><use href="#sil"/>${dots}</svg>`;
  }
  b.onclick = () => openFuture(f.i);
  // keep the grid sorted: critical, then minor, then clear (each in the order they finished)
  const before = f.outcome === "critical" ? field.querySelector(".tile.minor, .tile.clear") : f.outcome === "minor" ? field.querySelector(".tile.clear") : null;
  field.insertBefore(b, before);
}
function updateSplit() {
  const c = S.run.counts, n = Math.max(S.run.n, 1);
  const bars = $("split-bar").children;
  ["critical", "minor", "clear"].forEach((k, i) => {
    bars[i].style.flexGrow = c[k] || 0;
    $(`lane-n-${k}`).textContent = c[k] || 0;
    $(`lane-p-${k}`).textContent = c[k] ? pct(c[k] / n) : "";
  });
}

/* ======================================================================= the pipeline strip */
const PIPE = [
  ["snap", "Snapshot", "layers"], ["fork", "Fork a copy", "git-fork"], ["dice", "Roll the dice", "dice-5"],
  ["ripple", "Ripple", "activity"], ["count", "Count", "gauge"], ["clean", "Clean up", "shield-check"],
];
function pipeline(phase, d) {
  const el = $("pipeline");
  if (phase === "init" || !el.children.length) {
    el.innerHTML = PIPE.map(([id, label, ic]) => `<div class="pipe" id="pipe-${id}"><div class="t">${icon(ic, 14)}${esc(label)}</div><div class="d" id="pipe-${id}-d"></div></div>`).join("");
    const idle = { snap: "copy the company", fork: "one copy per future", dice: "unsure links: real?", ripple: "spread hop by hop", count: "count what broke", clean: "delete the copy" };
    for (const [id] of PIPE) $(`pipe-${id}-d`).textContent = idle[id];
    if (phase === "init") return;
  }
  const set = (id, text, on = true, done = false, mono = false) => {
    const p = $(`pipe-${id}`);
    p.classList.toggle("on", on);
    p.classList.toggle("done", done);
    const dd = $(`pipe-${id}-d`);
    dd.textContent = text;
    dd.classList.toggle("mono", mono);
  };
  if (phase === "start") { PIPE.forEach(([id]) => set(id, "…", false)); set("snap", "copying the company…"); }
  if (phase === "meta") {
    const snap = (d.prep_trace || [])[0];
    set("snap", snap ? `1 copy, ${Math.round(snap.ms)} ms` : "copied", true, true);
    $("pipe-snap").title = snap ? snap.query : "";
    set("dice", `${d.sources_of_chance} source${d.sources_of_chance === 1 ? "" : "s"} of chance`);
  }
  if (phase === "future") {
    set("fork", `#${d.i} in ${Math.round(d.ms)} ms`);
    $("pipe-fork").title = d.fork || "";
    set("dice", `${d.dropped} link${d.dropped === 1 ? "" : "s"} not real`);
    set("ripple", d.affected ? `${d.hops} hop${d.hops === 1 ? "" : "s"}, ${d.affected} hit` : "nothing spread");
    set("count", `${S.run.counts.critical} of ${S.run.n} critical`);
    set("clean", `copy #${d.i} deleted`);
  }
  if (phase === "done") {
    PIPE.forEach(([id]) => $(`pipe-${id}`).classList.add("done"));
    set("count", `${d.critical_futures} of ${d.futures} critical`, true, true);
    set("clean", d.fingerprint.unchanged ? "real one untouched" : "WARNING: changed", true, true);
    $("pipe-clean").title = d.fingerprint.unchanged ? `Fingerprint before = after; ${d.forks_left.length} copies left behind` : "";
  }
}

/* ======================================================================= the verdict panel */
const WORD = { BLOCK: "Blocked", REVIEW: "Needs review", SAFE: "Safe" };
const VICON = { BLOCK: "octagon-x", REVIEW: "triangle-alert", SAFE: "shield-check" };
function plainSentence(s) {
  const crit = s.affected.filter((a) => a.critical);
  const top = crit[0] || s.affected[0];
  const asked = [...new Set((s.unverified || []).map((u) => u.ask))];
  const askText = asked.length ? ` It hinges on ${s.unverified.length === 1 ? "a link" : "links"} nobody is sure about, so ${asked.join(" and ")} ${asked.length === 1 ? "has" : "have"} been asked.` : "";
  if (s.verdict === "SAFE") {
    return s.exact ? "Nothing important breaks. Nothing uncertain touches this plan, so a single future is the whole answer."
      : `Nothing critical broke in any of the ${s.futures} futures.`;
  }
  if (s.verdict === "BLOCK" && top) {
    const others = crit.length > 1 ? ` (and ${crit.length - 1} more critical asset${crit.length > 2 ? "s" : ""})` : "";
    return `${top.name}${others} breaks in ${pct(top.probability)} of futures, well above the 5% safety line.${askText}`;
  }
  if (top) return `Only minor things break: ${top.name} (${STATUS_WORD[top.status] || top.status}) in ${pct(top.probability)} of futures.${askText}`;
  return "";
}
function chartSVG(points, nMax) {
  if (!points.length) return '<svg class="chart" aria-hidden="true"></svg>';
  const W = Math.max(260, ($("verdict").clientWidth || 380) - 34), H = window.innerHeight < 860 ? 62 : 78, pl = 30, pr = 8, pt = 6, pb = 16;
  const yMax = Math.min(1, Math.max(0.2, ...points.map((p) => p.high)) * 1.1);
  const x = (n) => pl + (W - pl - pr) * (n / nMax);
  const y = (v) => pt + (H - pt - pb) * (1 - v / yMax);
  const band = points.map((p) => `${x(p.futures).toFixed(1)},${y(p.high).toFixed(1)}`).concat(points.slice().reverse().map((p) => `${x(p.futures).toFixed(1)},${y(p.low).toFixed(1)}`)).join(" ");
  const line = points.map((p) => `${x(p.futures).toFixed(1)},${y(p.p_crit).toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  const ticks = [0, yMax / 2, yMax].map((v) => `<text x="${pl - 6}" y="${y(v) + 3.5}" text-anchor="end">${pct(v)}</text><line class="c-grid" x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" stroke="${MVC.line}"/>`).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" style="height:${H}px" role="img" aria-label="Estimate of the chance of critical breakage as futures were added: ${pct(last.p_crit)} after ${last.futures}">
    ${ticks}
    <polygon class="c-band" points="${band}" fill="${MVC.ink}" fill-opacity=".09"/>
    <line class="c-safe" x1="${pl}" x2="${W - pr}" y1="${y(0.05)}" y2="${y(0.05)}" stroke="${MVC.signal}" stroke-dasharray="4 3" stroke-width="1.4"/>
    <text x="${W - pr}" y="${y(0.05) - 4}" text-anchor="end" fill="${MVC.signalInk}" class="c-safe-t">5% safety line</text>
    <polyline class="c-line" points="${line}" fill="none" stroke="${MVC.ink}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    <circle cx="${x(last.futures)}" cy="${y(last.p_crit)}" r="4" fill="${MVC.signal}" stroke="${MVC.ink}" stroke-width="1.5"/>
    <text x="${pl}" y="${H - 3}">0</text><text x="${W - pr}" y="${H - 3}" text-anchor="end">${nMax} futures</text></svg>`;
}
function renderVerdict(state, s, exec) {
  const el = $("verdict");
  el.classList.remove("reveal");
  el.dataset.v = state === "done" && s ? s.verdict : state;
  if (state === "idle") {
    el.innerHTML = `<div class="idle-intro">${bigMark()}<div><h2 style="font-size:16px">What you will see</h2><ol>
      <li>Pick a scenario on the left, or add your own steps.</li>
      <li>Press <b>Rehearse</b>. Each square that appears below is one copy of the company with the change played out in it.</li>
      <li>Read the verdict, then click any square to see exactly why.</li></ol></div></div>`;
    return;
  }
  if (state === "starting") { el.innerHTML = `<div class="v-word running">${icon("git-fork", 22)}Copying the company…</div>`; return; }
  const r = S.run;
  if (state === "running") {
    const p = r.progress;
    const nMax = r.meta && r.meta.mode === "precise" ? r.meta.target_futures : Math.max(25, Math.ceil((p ? p.futures : 1) / 25) * 25);
    el.innerHTML = `<div class="verdict-top"><div class="v-word running">${icon("orbit", 22)}Rehearsing…</div><div class="v-sub num">${p ? p.futures : 0} futures${r.meta && r.meta.mode === "precise" ? ` of ${r.meta.target_futures}` : ""}</div></div>
      <div><span class="v-num num">${p ? Math.round(p.p_crit * 100) : 0}<small>%</small></span> <span class="muted">of futures so far break something critical</span></div>
      ${chartSVG(r.points, nMax)}
      <div class="v-chips">${p && !(r.meta && r.meta.exact) ? `<span class="chip num">95% range ${pct(p.low)} to ${pct(p.high)}</span>` : ""}${r.meta ? `<span class="chip">${icon("dice-5", 13)}replay code ${esc(r.meta.seed)}</span><span class="chip">${r.meta.sources_of_chance} source${r.meta.sources_of_chance === 1 ? "" : "s"} of chance</span>` : ""}</div>`;
    return;
  }
  // done
  const pts = r.points.length ? r.points : [{ futures: s.futures, p_crit: s.p_crit, low: s.range[0], high: s.range[1] }];
  const nMax = s.mode === "precise" ? s.futures : Math.max(25, Math.ceil(s.futures / 25) * 25);
  const execLine = exec ? `<div class="notice ${exec.executed ? "good" : "bad"}">${icon(exec.executed ? "circle-check" : "circle-alert", 16)}<span>${esc(exec.reason || "")}</span></div>` : "";
  const qs = (s.questions || []).length;
  const advice = s.launch && s.launch.advice && s.launch.advice.length;
  el.innerHTML = `<div class="verdict-top"><div class="v-word ${s.verdict}">${icon(VICON[s.verdict], 24)}${WORD[s.verdict]}</div><div class="v-sub num">${s.exact ? "exact answer" : `${s.critical_futures} of ${s.futures} futures`}<br>${s.seconds} s, ${s.ms_per_future} ms each</div></div>
    <div><span class="v-num num">${Math.round(s.p_crit * 100)}<small>%</small></span> <span class="muted">of futures break something critical</span></div>
    <p class="v-text">${esc(plainSentence(s))}</p>
    ${s.exact ? "" : chartSVG(pts, nMax)}
    <div class="v-chips">${s.exact ? '<span class="chip ok">exact: one future is the whole answer</span>' : `<span class="chip num">95% range ${pct(s.range[0])} to ${pct(s.range[1])}</span>`}
      <button class="chip" type="button" id="copy-seed" title="Same plan + same code = the same futures">${icon("dice-5", 13)}replay code ${esc(s.seed)}</button>
      ${s.fingerprint.unchanged ? `<button class="chip ok" type="button" data-tab="proof">${icon("fingerprint", 13)}real company untouched</button>` : ""}</div>
    ${s.exact ? "" : `<p class="tiny faint v-stop">${esc(s.stop_reason)}</p>`}
    ${execLine}
    <div class="v-actions">${s.verdict === "SAFE" && !(exec && exec.executed) && s.kind !== "check before acting" ? `<button class="btn danger" id="v-exec">${icon("shield-check", 15)}Execute for real</button>` : ""}
      ${qs ? `<button class="btn primary" id="v-inbox" title="Opens the inbox, where the team that owns each link answers">${icon("inbox", 15)}Answer ${qs === 1 ? "the question" : `${qs} questions`}</button>` : ""}
      ${advice ? `<button class="btn primary" id="v-advice" title="Adds the scale-up steps the graph suggests, then rehearses again">${icon("trending-up", 15)}Apply the scaling advice</button>` : ""}
      <button class="btn ghost" id="v-why">${icon("list-checks", 15)}Why?</button></div>`;
  el.classList.add("reveal");
  $("copy-seed").onclick = () => { $("seed").value = s.seed; toast(`Replay code ${s.seed} set`, "Press Rehearse with the same plan to get the identical futures."); };
  el.querySelector("[data-tab='proof']")?.addEventListener("click", () => openTab("proof"));
  $("v-exec") && ($("v-exec").onclick = () => executeForReal(s.plan));
  $("v-inbox") && ($("v-inbox").onclick = () => go("inbox"));
  $("v-advice") && ($("v-advice").onclick = () => applyAdvice(s));
  $("v-why").onclick = () => openTab(s.unverified.length ? "why" : "breaks");
}
function bigMark() {
  const copy = (dx, dy, stroke, op) => `<g transform="translate(${dx} ${dy})" stroke="${stroke}" opacity="${op}"><circle cx="18" cy="58" r="6"/><circle cx="46" cy="26" r="6"/><circle cx="74" cy="58" r="6"/><circle cx="46" cy="72" r="4"/><path d="M22 53 41 31M51 31l19 22M24 58h44M46 66v-2"/></g>`;
  return `<svg viewBox="0 0 96 96" aria-hidden="true" fill="none" stroke-width="2" stroke-linecap="round">${copy(14, -12, MVC.ink, .25)}${copy(7, -6, MVC.ink, .55)}${copy(0, 0, MVC.ink, 1)}</svg>`;
}
function applyAdvice(s) {
  const launchStep = s.plan.steps.find((x) => x.action === "launch");
  const scales = s.launch.advice.map((a) => ({ action: "scale", asset: a.asset, factor: a.factor }));
  const other = s.plan.steps.filter((x) => x.action !== "launch" && x.action !== "scale");
  S.plan = { title: `${planTitle({ title: "", steps: [launchStep] })} + scaling advice`, steps: [...other, ...scales, launchStep] };
  markCustom();
  S.planAgent = "growth-agent";
  $("plan-story").textContent = "The same launch, after scaling what the graph says breaks first.";
  renderPlan();
  startRehearsal();
}

/* ======================================================================= details under the stage */
let currentTab = "breaks";
function renderDetails(s) {
  $("details").hidden = false;
  const tabs = [["breaks", "What breaks", s.affected.length], ["why", "What decides it", (s.unverified || []).length + (s.uncertainty.timing || []).length + (s.learned || []).length]];
  if (s.launch) tabs.push(["launch", "Launch numbers", null]);
  tabs.push(["commands", "Commands", null], ["proof", "Proof", null]);
  $("detail-tabs").innerHTML = tabs.map(([id, label, n]) => `<button role="tab" type="button" data-tab="${id}" aria-selected="false">${esc(label)}${n != null ? `<span class="count">${n}</span>` : ""}</button>`).join("");
  $("detail-tabs").querySelectorAll("button").forEach((b) => (b.onclick = () => openTab(b.dataset.tab)));
  openTab(tabs.some((t) => t[0] === currentTab) ? currentTab : "breaks", false);
}
function openTab(id, scroll = true) {
  const s = S.summary;
  if (!s) return;
  currentTab = id;
  $("detail-tabs").querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === id)));
  const body = $("detail-body");
  if (id === "breaks") body.innerHTML = breaksHTML(s);
  if (id === "why") body.innerHTML = whyHTML(s);
  if (id === "launch") body.innerHTML = launchNumbersHTML(s);
  if (id === "proof") body.innerHTML = proofHTML(s);
  if (id === "commands") { body.innerHTML = '<p class="empty">Loading the commands future #1 ran…</p>'; loadTrace(s.rid, 1); }
  body.querySelectorAll("[data-asset]").forEach((b) => (b.onclick = () => go("company", `asset/${encodeURIComponent(b.dataset.asset)}`)));
  body.querySelectorAll("[data-link]").forEach((b) => (b.onclick = () => go("company", `link/${encodeURIComponent(b.dataset.link)}`)));
  body.querySelector("#d-inbox")?.addEventListener("click", () => go("inbox"));
  body.querySelector("#d-advice")?.addEventListener("click", () => applyAdvice(s));
  body.querySelector("#d-replay")?.addEventListener("click", () => { $("seed").value = s.seed; toast(`Replay code ${s.seed} set`, "Press Rehearse to play the identical futures again."); });
  if (scroll) $("details").scrollIntoView({ behavior: REDUCED.matches ? "auto" : "smooth", block: "start" });
}
function pathChips(why) {
  const parts = why.split(/ -([A-Z_]+)-> /);
  let html = `<button class="chip" type="button" data-asset="${esc(parts[0])}">${esc(parts[0])}</button>`;
  for (let i = 1; i < parts.length; i += 2) html += `<span class="rel">${esc(relWord(parts[i]))}</span><button class="chip" type="button" data-asset="${esc(parts[i + 1])}">${esc(parts[i + 1])}</button>`;
  return `<div class="path">${html}</div>`;
}
function breaksHTML(s) {
  if (!s.affected.length) return '<p class="empty">Nothing breaks in any future.</p>';
  return `<ul class="rows breaks">${s.affected.map((a) => `<li><div class="row-top"><span><b>${esc(a.name)}</b> <span class="chip ${a.critical ? "crit" : "minor"}">${a.critical ? "critical" : esc(STATUS_WORD[a.status] || a.status)}</span></span><span class="muted small num">${pct(a.probability)} of futures, owner ${esc(a.owner)}</span></div>
    <div class="meter"><i class="${a.critical ? "crit" : "minor"}" style="width:${(a.probability * 100).toFixed(1)}%"></i></div>${a.why.includes("->") ? pathChips(a.why) : ""}</li>`).join("")}</ul>`;
}
function whyHTML(s) {
  const out = [];
  if (!s.exact && s.stop_reason) out.push(`<div class="panel-body" style="padding-bottom:0"><p class="section-title">Why it stopped at ${esc(s.futures)} futures</p><p class="small muted">${esc(s.stop_reason)}</p></div>`);
  if ((s.unverified || []).length) {
    out.push(`<div class="panel-body" style="padding-bottom:0"><p class="section-title">Links nobody is sure about</p><p class="small muted">The verdict depends on these. The team that owns each one has been asked; until they answer, every future rolls dice for them using the evidence.</p></div>
      <ul class="rows">${s.unverified.map((u) => { const [a, r, b] = u.key.split("|"); return `<li><div class="row-top"><span>Does <b>${esc(a)}</b> still ${esc(relBase(r))} <b>${esc(b)}</b>?</span><span class="chip chance num">${pct(u.confidence)} sure</span></div>
        <ul class="evidence-list" style="margin-top:8px">${(u.evidence || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><button class="btn small" type="button" data-link="${esc(u.key)}">${icon("file-text", 14)}Open the evidence</button><button class="btn small" type="button" id="d-inbox">${icon("inbox", 14)}Answer as ${esc(u.ask)}</button></div></li>`; }).join("")}</ul>`);
  }
  if ((s.uncertainty.timing || []).length) {
    out.push(`<div class="panel-body" style="padding-bottom:0"><p class="section-title">Jobs people run by hand</p></div><ul class="rows">${s.uncertainty.timing.map((t) => { const [a, r, b] = t.key.split("|"); return `<li><div class="row-top"><span><b>${esc(a)}</b> ${esc(relWord(r))} ${esc(b)}</span><span class="chip num">${pct(t.chance_used)} chance it runs in the window</span></div><p class="small muted" style="margin-top:4px">Learned from how often it ran in the access log.</p></li>`; }).join("")}</ul>`);
  }
  if ((s.learned || []).length) {
    out.push(`<div class="panel-body" style="padding-bottom:0"><p class="section-title">Already answered by a team, used in every future</p></div><ul class="rows">${s.learned.map((f) => `<li><div class="row-top"><span>${esc(f.link.replace(/ -([A-Z_]+)-> /, (m, r) => ` ${relWord(r)} `))}</span><span class="chip ${f.exists ? "crit" : "ok"}">${f.exists ? "yes, it does" : "no, it doesn't"}</span></div><p class="small muted" style="margin-top:4px">Answered by ${esc(f.by)}</p></li>`).join("")}</ul>`);
  }
  if (s.uncertainty.surge) out.push(`<div class="panel-body"><p class="small muted">Each future also rolls the launch-day traffic: half the time it is above ${esc(s.launch.surge)}× normal, and 1 time in 10 above ${esc(s.launch.surge_p90)}×.</p></div>`);
  if (!out.length) out.push('<p class="empty">Nothing uncertain decides this plan: every link it can reach is certain, so one future is the exact answer.</p>');
  return out.join("");
}
function launchNumbersHTML(s) {
  const L = s.launch;
  const rows = L.breaking_points.slice(0, 12).map((p) => `<tr class="${p.critical && p.breaks_at <= L.ready_for ? "hot" : ""}"><td>${esc(p.asset)}</td><td class="num">${p.breaks_at}×</td><td class="num">${p.capacity}</td><td>${p.critical ? "yes" : "no"}</td><td>${esc(p.owner)}</td></tr>`).join("");
  const theory = L.theory_applies ? `<p class="small">Maths: <b>${pct(L.theory_p_crit, 1)}</b> of launches push traffic past ${L.first_critical_break}× (where the first critical service breaks). The futures: <b>${pct(L.simulated_p_crit, 1)}</b>.</p>` : "";
  const advice = L.advice.length ? `<p class="small" style="margin-top:8px">To survive the 1-in-100 surge (${L.ready_for}×): ${L.advice.map((a) => `<span class="chip">${esc(a.asset)} ×${a.factor}</span>`).join(" ")}</p><button class="btn small primary" type="button" id="d-advice" style="margin-top:10px">${icon("trending-up", 14)}Add this scaling and rehearse again</button>` : "";
  return `<div class="panel-body"><p class="small muted">Load on each service = ${L.base_rps} requests per second at ${esc(L.entry)} × the calls along every path to it (one graph query). Traffic seen in these futures: lowest ${L.surge_seen[0]}×, median ${L.surge_seen[1]}×, highest ${L.surge_seen[2]}×.</p></div>
    <table class="mini-table"><thead><tr><th>Service</th><th class="num">Breaks at</th><th class="num">Capacity (req/s)</th><th>Critical</th><th>Owner</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="panel-body">${theory}${advice}</div>`;
}
function proofHTML(s) {
  const fp = s.fingerprint;
  return `<dl class="proof">
    <dt>Fingerprint before</dt><dd><code>${esc(fp.before)}</code></dd>
    <dt>Fingerprint after</dt><dd><code>${esc(fp.after)}</code></dd>
    <dt>Unchanged</dt><dd>${fp.unchanged ? '<span class="chip ok">yes</span> every node, link and property of the real company hashes the same (SHA-256)' : '<span class="chip crit">no</span> the company changed while this rehearsal ran'}</dd>
    <dt>Copies made</dt><dd>${s.futures} future cop${s.futures === 1 ? "y" : "ies"} + 1 snapshot, ${s.forks_left.length} left behind</dd>
    <dt>Time</dt><dd>${s.seconds} s in total, ${s.ms_per_future} ms per future (most of it is GRAPH.COPY)</dd>
    <dt>Replay code</dt><dd>${esc(s.seed)} <button class="link-btn" type="button" id="d-replay">use it to replay these exact futures</button></dd>
    <dt>Rehearsal id</dt><dd><code>${esc(s.rid)}</code>, by ${esc(s.by)}${isExternal(s.client) ? ` via ${esc((CLIENTS[s.client] || [s.client])[0])}` : ""}</dd></dl>`;
}

/* ======================================================================= commands (trace) */
const STEP_TEXT = {
  snapshot: ["Snapshot the company", "One copy of the whole company graph, frozen for this rehearsal. The plan's changes are made in it."],
  changes: ["Apply the plan's changes to the snapshot", "Same Cypher as a real execution would run, but on the copy."],
  fork: ["Copy the snapshot for this future", "Every future gets its own full copy (GRAPH.COPY)."],
  dice: ["Remove the links that are not real in this future", "The dice decided these uncertain links do not exist here."],
  disrupt: ["Mark what the plan disrupts", ""],
  ripple: ["Ripple, one hop", "Who depends on the assets that just failed? Links not used in the window carry nothing."],
  mark: ["Write the statuses into the copy", ""],
  read: ["Read the result back out of the copy", ""],
  drop: ["Delete the copy", "The future is over; nothing of it remains in FalkorDB."],
};
function highlightCypher(q) {
  let h = esc(q);
  h = h.replace(/\b(MATCH|WHERE|RETURN|UNWIND|AS|SET|DELETE|CREATE|WITH|NOT|IN|AND|OR|ORDER BY|LIMIT|GRAPH\.COPY|GRAPH\.DELETE|CALL|YIELD|IS|NULL)\b/g, '<span class="kw">$1</span>');
  h = h.replace(/(\$[a-z_]+)/g, '<span class="par">$1</span>');
  return h;
}
function traceHTML(trace, title) {
  const rows = trace.map((t, i) => {
    const [what, why] = STEP_TEXT[t.step] || [t.step, ""];
    let extra = "";
    if (t.step === "dice" && t.params) extra = t.params.keys.length ? `<div class="found">${t.params.keys.map((k) => `<span class="chip chance k">${esc(k.replace(/\|/g, " "))}</span>`).join("")}</div>` : "";
    if (t.step === "disrupt") extra = `<div class="found">${Object.entries(t.origins || {}).map(([n, st]) => `<span class="chip crit">${esc(n)}: ${esc(st)}</span>`).join("")}${(t.inactive || []).length ? `<span class="chip">${t.inactive.length} link${t.inactive.length > 1 ? "s" : ""} idle in this window</span>` : ""}</div>`;
    if (t.step === "ripple") extra = `<div class="found">${t.found.length ? t.found.map(([x, st, y, rel]) => `<span class="chip ${st === "broken" && isCrit3(x) ? "crit" : "minor"}">${esc(x)} ${esc(STATUS_WORD[st] || st)} (${esc(relWord(rel))} ${esc(y)})</span>`).join("") : '<span class="chip">nothing new: the ripple stops here</span>'}</div>`;
    if (t.step === "changes") extra = `<div class="found">${(t.detail || []).map((d) => `<span class="chip k">${esc(String(d).replace(/\|/g, " "))}</span>`).join("")}</div>`;
    const label = t.step === "ripple" ? `${what} ${t.hop}` : what;
    const params = t.step === "ripple" ? `params: frontier = [${t.params.frontier.map((f) => `"${f}"`).join(", ")}], ${t.params.inactive} idle link key(s)` : "";
    return `<li data-step="${i}"><div><div class="what">${esc(label)}</div>${why ? `<div class="why">${esc(why)}</div>` : ""}</div><span class="ms">${t.ms != null ? `${t.ms} ms` : ""}${t.rows != null ? `, ${t.rows} row${t.rows === 1 ? "" : "s"}` : ""}</span>
      ${t.query ? `<pre class="code">${highlightCypher(t.query)}${params ? `\n<span class="faint">// ${esc(params)}</span>` : ""}</pre>` : ""}${extra}</li>`;
  }).join("");
  return `<div class="panel-body" style="padding-bottom:6px"><p class="small muted">${title}</p></div><ol class="trace" id="trace">${rows}</ol>`;
}
async function loadTrace(rid, i) {
  try {
    const f = await api(`/api/rehearsals/${rid}/futures/${i}`);
    const meta = S.run && S.run.meta;
    const prep = (meta && meta.prep_trace) || [];
    if (!f.trace) { $("detail-body").innerHTML = '<p class="empty">This rehearsal kept no command trace (it ran before tracing existed).</p>'; return; }
    $("detail-body").innerHTML = traceHTML([...prep, ...f.trace], `The exact FalkorDB commands rehearsal <code>${esc(rid)}</code> ran for future #${i}, in order, with their timings. Click any square and press <b>Replay</b> to watch another future run step by step.`);
  } catch (e) { $("detail-body").innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
}

/* ======================================================================= one future */
async function openFuture(i) {
  if (!S.run) return;
  document.querySelectorAll(".tile.sel").forEach((t) => t.classList.remove("sel"));
  const tile = document.querySelector(`.tile[data-i="${i}"]`);
  if (tile) tile.classList.add("sel");
  try {
    const f = await api(`/api/rehearsals/${S.run.rid}/futures/${i}`);
    S.viewing = f;
    f.affected.forEach((a) => { a.critical = isCrit3(a.name) && ["broken", "overloaded", "deleted"].includes(a.status); });
    drawFuture(f, true);
    futureBanner(f);
  } catch (e) { toast("Could not open that future", e.message, "bad"); }
}

function drawFuture(f, animate) {
  const g = S.graphs.rehearse;
  g.clear(); g.resetIcons();
  const lit = new Set(Object.keys(f.disrupted || {}));
  const keys = [];
  for (const [name, st] of Object.entries(f.disrupted || {})) {
    g.nodeClass(name, st === "deleted" ? "deleted" : st === "overloaded" ? "overloaded" : "origin");
    if (st === "deleted") g.markX(name);
    if (st === "overloaded") g.ring(name, MVC.signal, true);
  }
  for (const k of f.dropped || []) { g.edgeClassByKey(k, "missing"); keys.push(k); const [a, , b] = k.split("|"); lit.add(a); lit.add(b); }
  for (const k of f.idle || []) { g.edgeClassByKey(k, "idle"); keys.push(k); }
  for (const a of f.affected) { lit.add(a.name); (a.path || []).forEach((p) => lit.add(p)); keys.push(...(a.keys || [])); }
  g.dimExcept([...lit], keys);
  requestAnimationFrame(() => g.fitTo([...lit], 1.05, bannerSpace()));
  // by hop: hop 1 is next to what the plan disrupted
  const byHop = {};
  for (const a of f.affected) {
    if (a.status === "deleted" || a.status === "overloaded") continue;
    const hop = Math.max(1, (a.path || []).length - 1);
    (byHop[hop] ||= []).push(a);
  }
  const token = g.token();
  const paint = (a) => {
    g.nodeClass(a.name, a.status === "broken" ? (a.critical ? "broken" : "minor") : a.status);
    if (a.keys && a.keys[0]) { g.edgeClassByKey(a.keys[0], "path"); }
  };
  if (!animate || REDUCED.matches) { Object.values(byHop).flat().forEach(paint); return; }
  (async () => {
    for (const hop of Object.keys(byHop).map(Number).sort((x, y) => x - y)) {
      await sleep(380);
      if (token !== g.token()) return;
      for (const a of byHop[hop]) { if (a.keys && a.keys[0]) g.spark(a.keys[0], 420); }
      await sleep(400);
      if (token !== g.token()) return;
      byHop[hop].forEach(paint);
    }
  })();
}

function futureBanner(f) {
  const b = $("future-banner");
  const crit = f.affected.filter((a) => a.critical);
  const title = f.outcome === "critical" ? "something critical broke" : f.outcome === "minor" ? "only minor things broke" : "nothing broke";
  const origins = Object.entries(f.disrupted || {}).map(([n, st]) => `${n} ${STATUS_WORD[st] || st}`).join(", ");
  const lines = [];
  if (origins) lines.push(`The plan: ${esc(origins)}.`);
  for (const a of f.affected.filter((x) => x.path && x.path.length > 1).slice(0, 3)) {
    const via = a.path[1];
    lines.push(`<b>${esc(a.name)}</b> ${esc(STATUS_WORD[a.status] || a.status)} because it ${esc(relWord(a.rels[0]))} ${esc(via)}.`);
  }
  const said = (k) => { const e = S.world.edges.find((x) => x.key === k); return e && e.answered && !e.answered.exists ? e.answered.by : null; };
  const txt = (k) => { const [a, r, bb] = k.split("|"); return `${esc(a)} ${esc(relWord(r))} ${esc(bb)}`; };
  const byTeam = (f.dropped || []).filter(said), byDice = (f.dropped || []).filter((k) => !said(k));
  if (byDice.length) lines.push(`In this future the dice said ${byDice.length === 1 ? "this link is" : "these links are"} not real: ${byDice.map(txt).join("; ")}.`);
  if (byTeam.length) lines.push(`Not real because the owning team said so: ${byTeam.map((k) => `${txt(k)} (${esc(said(k))})`).join("; ")}.`);
  if ((f.idle || []).length) lines.push(`Not used during the window: ${f.idle.map((k) => esc(k.split("|")[0])).join(", ")} did not run.`);
  if (f.surge != null) lines.push(`Traffic in this future: <b>${f.surge}×</b> normal${f.overloaded.length ? `; over capacity: ${f.overloaded.map(esc).join(", ")}` : ""}.`);
  const old = $("live-step");
  if (old) old.remove();
  b.innerHTML = `<div class="row-top"><h3>Future ${f.i}: ${title}</h3><button class="btn small ghost icon-only" type="button" id="fb-close" aria-label="Back to all futures">${icon("x", 15)}</button></div>
    <p>${lines.join(" ")}</p>
    <p class="tiny faint">Played in its own copy <code>${esc(f.fork || "")}</code> in ${f.ms} ms, then the copy was deleted.</p>
    <div class="actions"><button class="btn small primary" type="button" id="fb-replay">${icon("play", 14)}Replay it in FalkorDB, step by step</button>${crit[0] ? `<button class="btn small" type="button" id="fb-asset">${icon("file-text", 14)}Why does ${esc(crit[0].name)} depend on it?</button>` : ""}</div>`;
  b.hidden = false;
  $("fb-close").onclick = closeFuture;
  $("fb-replay").onclick = () => replayFuture(f.i);
  $("fb-asset") && ($("fb-asset").onclick = () => go("company", `asset/${encodeURIComponent(crit[0].name)}`));
}
function bannerSpace() {
  const b = $("future-banner");
  return b.hidden ? 0 : b.getBoundingClientRect().height + 16;
}
function closeFuture() {
  S.viewing = null;
  $("future-banner").hidden = true;
  if (S.run && S.run.meta) S.graphs.rehearse.fitTo(blastRadius(S.run.meta.plan), 1.05);
  document.querySelectorAll(".tile.sel").forEach((t) => t.classList.remove("sel"));
  if (S.summary) showHeat(S.summary); else { S.graphs.rehearse.clear(); S.graphs.rehearse.resetIcons(); liveHeat(); }
}

async function replayFuture(i) {
  const btn = $("fb-replay");
  if (btn) { btn.disabled = true; btn.innerHTML = `${icon("orbit", 14)}Replaying in FalkorDB…`; }
  try {
    const r = await post(`/api/rehearsals/${S.run.rid}/futures/${i}/replay`);
    const note = `Future #${i}, played again just now in a fresh copy: same plan, same dice, same team answers. ${r.identical ? '<span class="chip ok">identical to the recording</span>' : `<span class="chip minor">differs from the recording${r.world_changed ? ": the company changed since" : ""}</span>`}`;
    if (S.summary) {
      $("details").hidden = false;
      currentTab = "commands";
      $("detail-tabs").querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === "commands")));
      $("detail-body").innerHTML = traceHTML(r.trace, note);
    }
    await animateTrace(r, note);
  } catch (e) { toast("Replay failed", e.message, "bad"); }
  if (btn) { btn.disabled = false; btn.innerHTML = `${icon("play", 14)}Replay it in FalkorDB, step by step`; }
}

async function animateTrace(r, note) {
  const g = S.graphs.rehearse;
  g.clear(); g.resetIcons();
  const token = g.token();
  const lit = new Set(Object.keys(r.disrupted || {}));
  for (const a of r.affected) { lit.add(a.name); (a.path || []).forEach((p) => lit.add(p)); }
  (r.dropped || []).forEach((k) => { const [a, , b] = k.split("|"); lit.add(a); lit.add(b); });
  g.dimExcept([...lit], [...r.affected.flatMap((a) => a.keys || []), ...(r.dropped || [])]);
  g.fitTo([...lit], 1.05, bannerSpace());
  let box = $("live-step");
  if (!box) {
    box = document.createElement("div");
    box.className = "live-step";
    box.id = "live-step";
    $("future-banner").appendChild(box);
  }
  const rows = [...document.querySelectorAll("#trace > li")];
  for (let k = 0; k < r.trace.length; k++) {
    if (token !== g.token()) return;
    const t = r.trace[k];
    const [what] = STEP_TEXT[t.step] || [t.step];
    box.innerHTML = `<b>Step ${k + 1} of ${r.trace.length}: ${esc(t.step === "ripple" ? `${what} ${t.hop}` : what)}${t.ms != null ? ` <span class="faint">${t.ms} ms</span>` : ""}</b>${t.query ? `<code>${esc(t.query.split("\n").slice(0, 3).join("\n"))}</code>` : ""}${t.step === "ripple" && t.found.length ? `<span class="tiny">found: ${t.found.map(([x, st]) => `${esc(x)} ${esc(STATUS_WORD[st] || st)}`).join(", ")}</span>` : ""}`;
    rows.forEach((li) => li.classList.toggle("live", li === rows[k]));
    if (t.step === "dice") (t.params.keys || []).forEach((key) => g.edgeClassByKey(key, "missing"));
    if (t.step === "disrupt") for (const [n, st] of Object.entries(t.origins || {})) { g.nodeClass(n, st === "deleted" ? "deleted" : st === "overloaded" ? "overloaded" : "origin"); if (st === "deleted") g.markX(n); if (st === "overloaded") g.ring(n, MVC.signal, true); }
    if (t.step === "ripple") {
      for (const [x, , y, rel] of t.found) g.spark(`${x}|${rel}|${y}`, 480);
      await wait(480);
      for (const [x, st, y, rel] of t.found) { g.nodeClass(x, st === "broken" ? (isCrit3(x) ? "broken" : "minor") : st); g.edgeClassByKey(`${x}|${rel}|${y}`, "path"); }
    }
    await wait(t.step === "ripple" ? 700 : 650);
  }
  rows.forEach((li) => li.classList.remove("live"));
  box.innerHTML = `<b>Done: ${r.outcome === "critical" ? "something critical broke" : r.outcome === "minor" ? "only minor things broke" : "nothing broke"}, in ${r.ms} ms.</b><span class="tiny">${note} The full list of commands is in the Commands tab below.</span>`;
}

/* ======================================================================= launch page */
async function loadLaunch() {
  if (!$("l-start").value) {
    const sale = S.scenarios.find((p) => p.id === "festival-sale");
    $("l-start").value = sale ? sale.plan.steps[0].start.slice(0, 16) : nextHour(24);
  }
  await fetchLaunch();
}
let launchTimer = null;
async function fetchLaunch() {
  const surge = Number($("l-surge").value), p90 = Math.max(Number($("l-p90").value), surge);
  try {
    S.launch = await api(`/api/launch-advice?surge=${surge}&p90=${p90}`);
    paintLaunch();
  } catch (e) { $("l-theory-why").textContent = e.message; }
}
function normCdf(z) {           // Abramowitz-Stegun approximation of the standard normal CDF
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
function paintLaunch() {
  const L = S.launch;
  if (!L || !S.world) return;
  const surge = Number($("l-surge").value);
  let p90 = Number($("l-p90").value);
  if (p90 < surge) { p90 = surge; $("l-p90").value = surge; }
  const sigma = p90 > surge ? Math.log(p90 / surge) / 1.2816 : 0;
  $("l-surge-v").textContent = `${surge.toFixed(1)}× normal`;
  $("l-p90-v").textContent = `${p90.toFixed(1)}×`;
  $("l-at").textContent = `${surge.toFixed(1)}×`;
  $("l-surge-rps").textContent = `${Math.round(L.base_rps * surge)} requests per second arriving at ${L.entry} (a normal evening peak is ${L.base_rps}).`;
  const fcb = L.first_critical_break;
  const first = L.breaking_points.find((p) => p.critical);
  const theory = fcb == null ? 0 : sigma > 0 ? 1 - normCdf((Math.log(fcb) - Math.log(surge)) / sigma) : (surge >= fcb ? 1 : 0);
  $("l-theory").textContent = pct(theory);
  $("l-theory-why").innerHTML = first ? `The first business-critical service to run out is <b>${esc(first.asset)}</b>, at <b>${first.breaks_at}×</b> normal traffic. With this forecast, traffic goes past that in ${pct(theory, 1)} of launches. Rehearse it to check the maths with 100 simulated futures.` : "No critical service runs out of capacity.";
  // surge distribution
  const svg = $("l-surge-chart");
  const W = Math.max(280, svg.clientWidth || 360), H = 120, pl = 8, pr = 8, pb = 18;
  const xMax = 16, x = (v) => pl + (W - pl - pr) * ((v - 1) / (xMax - 1));
  const pdf = (v) => sigma > 0 ? Math.exp(-((Math.log(v) - Math.log(surge)) ** 2) / (2 * sigma * sigma)) / (v * sigma * Math.sqrt(2 * Math.PI)) : 0;
  const xs = Array.from({ length: 160 }, (_, i) => 1 + (i / 159) * (xMax - 1));
  const peak = Math.max(...xs.map(pdf), 1e-6);
  const y = (d) => H - pb - (H - pb - 8) * (d / peak);
  const line = xs.map((v) => `${x(v).toFixed(1)},${y(pdf(v)).toFixed(1)}`).join(" ");
  const tail = fcb ? xs.filter((v) => v >= fcb) : [];
  const area = tail.length ? `${x(tail[0])},${H - pb} ${tail.map((v) => `${x(v).toFixed(1)},${y(pdf(v)).toFixed(1)}`).join(" ")} ${x(tail[tail.length - 1])},${H - pb}` : "";
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = `<line x1="${pl}" x2="${W - pr}" y1="${H - pb}" y2="${H - pb}" stroke="${MVC.line}"/>
    ${area ? `<polygon points="${area}" fill="${MVC.signal}" fill-opacity=".55"/>` : ""}
    ${sigma > 0 ? `<polyline points="${line}" fill="none" stroke="${MVC.ink}" stroke-width="2" vector-effect="non-scaling-stroke"/>` : `<line x1="${x(surge)}" x2="${x(surge)}" y1="8" y2="${H - pb}" stroke="${MVC.ink}" stroke-width="2"/>`}
    ${fcb ? `<line x1="${x(fcb)}" x2="${x(fcb)}" y1="6" y2="${H - pb}" stroke="${MVC.signal}" stroke-dasharray="3 3" stroke-width="1.5"/><text x="${x(fcb) + 4}" y="16" fill="${MVC.signalInk}">${esc(first ? first.asset : "")} breaks at ${fcb}×</text>` : ""}
    ${[1, 2, 4, 6, 8, 10, 12, 14, 16].map((v) => `<text x="${x(v)}" y="${H - 4}" text-anchor="middle">${v}×</text>`).join("")}`;
  // headroom bars
  const maxX = 12;
  $("headroom").innerHTML = L.breaking_points.map((p) => {
    const cls = p.breaks_at <= surge ? "over" : p.breaks_at <= surge * 1.25 ? "near" : "";
    return `<div class="hr-row"><span class="name" title="${esc(p.asset)}">${p.critical ? `<b>${esc(p.asset)}</b>` : esc(p.asset)}</span>
      <div class="hr-track"><i class="${cls}" style="width:${Math.min(100, (p.breaks_at / maxX) * 100).toFixed(1)}%"></i><span class="hr-mark" style="left:${Math.min(100, (surge / maxX) * 100).toFixed(1)}%"></span></div>
      <span class="at">${p.breaks_at}×</span></div>`;
  }).join("") + `<div class="hr-axis"><span></span><div>${[1, 2, 4, 6, 8, 10, 12].map((v) => `<span style="left:${(v / maxX) * 100}%">${v}×</span>`).join("")}</div><span></span></div>
    <p class="tiny faint" style="margin-top:8px">Bold = business-critical. Capacity = replicas × CPU limit from the real Kubernetes file × requests per CPU-second from the (synthetic) load test.</p>`;
  // graph colouring
  const g = S.graphs.launch;
  g.clear();
  const byName = Object.fromEntries(L.breaking_points.map((p) => [p.asset, p]));
  const lit = [];
  for (const n of S.world.nodes) {
    const p = byName[n.name];
    if (!p) continue;
    lit.push(n.name);
    const ratio = surge / p.breaks_at;
    g.nodeClass(n.name, ratio >= 1 ? "over" : ratio >= 0.8 ? "near" : "ok");
    g.badge(n.name, `${Math.round(ratio * 100)}%`, ratio >= 1 ? "crit" : ratio >= 0.8 ? "minor" : "clear");
  }
  lit.push(L.entry, "loadgenerator");
  const keys = S.world.edges.filter((e) => e.calls_per_request != null).map((e) => e.key);
  g.dimExcept(lit, keys);
  if (!g.focusNames) g.focus(lit, 1.0);
  // advice (debounced fetch keeps it in step with the sliders)
  const adv = L.surge === surge && Math.abs(L.surge_p90 - p90) < 1e-9 ? L : null;
  $("l-advice").innerHTML = adv ? (adv.advice.length ? `<p class="section-title">To survive the 1-in-100 surge (${adv.ready_for}×)</p><div class="advice-list">${adv.advice.map((a) => `<span class="chip">${esc(a.asset)} ×${a.factor}</span>`).join("")}</div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><button class="btn primary" id="l-run-scaled" type="button">${icon("trending-up", 15)}Rehearse with this scaling</button><button class="btn" id="l-run" type="button">${icon("play", 15)}Rehearse without</button></div>` :
    `<p class="small muted">Nothing critical needs scaling for the 1-in-100 surge.</p><button class="btn" id="l-run" type="button" style="margin-top:8px">${icon("play", 15)}Rehearse this launch</button>`) : '<p class="small faint">Working out the scaling advice…</p>';
  $("l-run") && ($("l-run").onclick = () => rehearseLaunch(false));
  $("l-run-scaled") && ($("l-run-scaled").onclick = () => rehearseLaunch(true));
  if (!adv) { clearTimeout(launchTimer); launchTimer = setTimeout(fetchLaunch, 250); }
}
function launchStep() {
  const surge = Number($("l-surge").value), p90 = Math.max(Number($("l-p90").value), surge);
  return { action: "launch", surge, surge_p90: p90, hours: Number($("l-hours").value) || 6, start: $("l-start").value || nextHour(24) };
}
function rehearseLaunch(scaled) {
  const step = launchStep();
  const scales = scaled && S.launch ? S.launch.advice.map((a) => ({ action: "scale", asset: a.asset, factor: a.factor })) : [];
  S.plan = { title: `Launch at ${step.surge}× traffic (1 in 10: over ${step.surge_p90}×)${scaled ? " + scaling advice" : ""}`, steps: [...scales, step] };
  S.scenarioId = null;
  S.planAgent = "growth-agent";
  $("plan-story").textContent = scaled ? "The launch from the Launch day page, with the scaling the graph recommends." : "The launch from the Launch day page.";
  renderPlan();
  go("rehearse");
  startRehearsal();
}

/* ======================================================================= agents page */
const PLAN_WORD = { approved: "Cleared", held: "Holding", blocked: "Blocked", executed: "Done", booked: "Booked", cancelled: "Cancelled", checking: "Checking" };
async function loadPlans() {
  S.plans = await api("/api/plans").catch(() => []);
  renderStrips();
  renderSchedule();
  renderHeat();
}
function windowText(p) {
  const ws = parse(p.window_start), we = parse(p.window_end);
  if (!ws || !we) return "";
  if (we - ws > 1000 * 86400 * 365) return `permanent change, from ${when(p.window_start)}`;
  return `${when(p.window_start)} to ${hm(p.window_end)}`;
}
function renderStrips() {
  const el = $("strips");
  if (!S.plans.length) { el.innerHTML = `<p class="empty">No plans yet. Press <b>Run the two-agent demo</b>, or connect Claude Desktop and ask it to change something.</p>`; return; }
  el.innerHTML = S.plans.map((p) => {
    const conflicts = (p.conflicts || []).slice(1).map((c) => `<p class="small">Together with <b>${esc(c.agent)}</b>'s plan “${esc(c.title)}”: ${pct(c.p_joint)} of futures break ${esc((c.breaks || []).join(", ") || "something critical")}.</p>`).join("");
    const sug = p.suggestion ? `<p class="small">Earliest safe slot: <b>${when(p.suggestion.best_start)}</b> to ${hm(p.suggestion.best_end)} <span class="faint">(${p.suggestion.candidates} start times checked with only ${p.suggestion.rehearsed} rehearsals)</span></p>` : "";
    const acts = [];
    if (p.status === "approved") acts.push(`<button class="btn small primary" type="button" data-exec="${esc(p.id)}" data-agent="${esc(p.agent)}">${icon("shield-check", 14)}Execute as ${esc(p.agent)}</button>`, `<button class="btn small ghost" type="button" data-cancel="${esc(p.id)}">Cancel</button>`);
    if (p.suggestion && p.status === "held") acts.push(`<button class="btn small primary" type="button" data-move="${esc(p.id)}">${icon("calendar-clock", 14)}Move to ${esc(when(p.suggestion.best_start))} and propose again</button>`);
    if (p.alone && p.alone.rid) acts.push(`<button class="btn small ghost" type="button" data-watch="${esc(p.alone.rid)}">${icon("eye", 14)}See its rehearsal</button>`);
    return `<div class="strip ${esc(p.status)}"><div class="strip-top"><span class="callsign">${icon("bot", 15)}${esc(p.agent)}</span>${clientBadge(p.client)}<span class="verdict-pill ${esc(p.status)}">${esc(PLAN_WORD[p.status] || p.status)}</span><span class="strip-meta">${clock(p.created)}</span></div>
      <div class="strip-title">${esc(p.title)}</div><div class="strip-meta">${esc(windowText(p))}${p.alone ? `. Alone: ${esc(p.alone.verdict)} ${pct(p.alone.p_crit)}` : ""}</div>
      <p class="small muted">${esc(p.reason || "")}</p>${conflicts}${sug}${acts.length ? `<div class="actions">${acts.join("")}</div>` : ""}</div>`;
  }).join("");
  el.querySelectorAll("[data-exec]").forEach((b) => (b.onclick = () => executePlan(b.dataset.exec, b.dataset.agent)));
  el.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = async () => { await post(`/api/plans/${b.dataset.cancel}/cancel`, { agent: "console" }).catch((e) => toast("Cancel failed", e.message, "bad")); loadPlans(); }));
  el.querySelectorAll("[data-watch]").forEach((b) => (b.onclick = () => go("rehearse", b.dataset.watch)));
  el.querySelectorAll("[data-move]").forEach((b) => (b.onclick = () => {
    const p = S.plans.find((x) => x.id === b.dataset.move);
    const plan = JSON.parse(JSON.stringify(p.plan));
    const step = plan.steps.find((s) => s.action === "offline" || s.action === "launch");
    step.start = p.suggestion.best_start;
    plan.title = `${plan.title.split(" (")[0].replace(/ \w{3} \d{2} \w{3} \d{2}:\d{2}-\d{2}:\d{2}$/, "")} (moved to ${when(step.start)})`;
    propose(plan, p.agent);
  }));
}
async function executePlan(pid, agent) {
  notice("coord-notice", `Executing as ${agent}: Multiverse re-checks for new clashes and runs a fresh rehearsal first…`);
  try {
    let out = await post(`/api/plans/${pid}/execute`, { agent });
    if (!out.executed && out.rehearsal && out.rehearsal.verdict === "REVIEW" && !(out.rehearsal.unverified || []).length
        && await confirmDialog({ title: "Only minor things may break", body: `${out.reason} Accept and execute?`, confirm: "Accept and execute", danger: true })) {
      out = await post(`/api/plans/${pid}/execute`, { agent, accept_minor: true });
    }
    if (out.executed) { S.selfChangedAt = Date.now(); await loadWorld(); }
    notice("coord-notice", out.reason || (out.executed ? "Done." : "Refused."), out.executed ? "good" : "bad");
  } catch (e) { notice("coord-notice", e.message, "bad"); }
  loadPlans();
}
async function propose(plan, agent) {
  notice("coord-notice", `${agent} proposes “${planTitle(plan)}”. Rehearsing it alone, then together with every plan that overlaps it…`);
  try {
    const r = await post("/api/plans/propose", { plan, agent });
    notice("coord-notice", `${agent}: ${PLAN_WORD[r.status] || r.status}. ${r.reason}`, r.status === "approved" ? "good" : "bad");
    await loadPlans();
    return r;
  } catch (e) { notice("coord-notice", e.message, "bad"); return null; }
}
async function twoAgentDemo() {
  const b = $("two-agents");
  b.disabled = true;
  for (const a of S.twoAgents) {
    const r = await propose(a.plan, a.agent);
    if (!r) break;
    await sleep(500);
  }
  b.disabled = false;
}
function renderSchedule() {
  const el = $("schedule");
  const plans = S.plans.filter((p) => p.status !== "cancelled" && p.window_start);
  const day0 = new Date(); day0.setHours(0, 0, 0, 0);
  const ends = plans.map((p) => parse(p.window_end).getTime()).filter((t) => t - Date.now() < 365 * 86400000);
  const lastEnd = ends.length ? Math.max(...ends) : 0;
  const days = Math.min(35, Math.max(7, Math.ceil((lastEnd - day0) / 86400000) + 1));
  const W = Math.max(560, el.clientWidth - 32 || 760), rowH = 34, top = 30, left = 130;
  const span = days * 86400000;
  const x = (t) => left + (W - left - 10) * Math.min(1, Math.max(0, (t - day0) / span));
  const rows = plans.slice(0, 9);
  const H = top + Math.max(rows.length, 1) * rowH + 16;
  const color = { approved: MVC.ink, booked: MVC.ink, executed: MVC.ink, held: MVC.gray, blocked: MVC.signal, checking: MVC.ink3 };
  const every = Math.max(1, Math.ceil(78 / ((W - left - 10) / days)));
  let svg = `<svg class="sched-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="When each plan needs the company">`;
  for (let d = 0; d <= days; d++) {
    const t = new Date(day0.getTime() + d * 86400000);
    svg += `<line x1="${x(t)}" x2="${x(t)}" y1="${top - 8}" y2="${H - 10}" stroke="${MVC.line}"/>`;
    if (d < days && d % every === 0) svg += `<text x="${x(t) + 4}" y="${top - 12}">${esc(DAY.format(t))}</text>`;
  }
  const now = Date.now();
  svg += `<line x1="${x(now)}" x2="${x(now)}" y1="${top - 8}" y2="${H - 10}" stroke="${MVC.signal}" stroke-width="1.5"/><text x="${x(now) + 3}" y="${H - 2}" fill="${MVC.signalInk}">now</text>`;
  rows.forEach((p, i) => {
    const y = top + i * rowH;
    const ws = parse(p.window_start).getTime(), we = parse(p.window_end).getTime();
    const perm = we - ws > 365 * 86400000;
    const x1 = x(ws), x2 = perm ? W - 10 : Math.max(x(we), x1 + 6);
    const label = perm ? `${PLAN_WORD[p.status]}: permanent change` : `${PLAN_WORD[p.status]}: ${dayOf(p.window_start)} ${hm(p.window_start)}–${hm(p.window_end)}`;
    const lx = perm ? x1 + 6 : Math.min(x2 + 6, W - 8 - textWidth(label, "600 11px Archivo, sans-serif"));
    svg += `<text x="8" y="${y + 18}" class="lbl">${esc(p.agent.length > 18 ? p.agent.slice(0, 17) + "…" : p.agent)}</text>`;
    svg += `<rect x="${x1}" y="${y + 6}" width="${Math.max(6, x2 - x1)}" height="18" rx="0" fill="${color[p.status] || MVC.ink3}" fill-opacity="${perm ? 0.14 : 1}" stroke="${color[p.status] || MVC.ink3}"/>`;
    svg += `<text x="${lx}" y="${y + 19}" class="bar-t" font-weight="600">${esc(label)}</text>`;
  });
  if (!rows.length) svg += `<text x="${left}" y="${top + 20}">No plans yet.</text>`;
  el.innerHTML = svg + "</svg>";
}
function renderHeat() {
  const p = S.plans.find((x) => x.suggestion && x.suggestion.groups);
  $("heat-panel").hidden = !p;
  if (!p) return;
  const sug = p.suggestion;
  const verdictOf = {};
  for (const g of sug.groups) for (const st of g.starts) verdictOf[st.slice(0, 13)] = g.verdict;
  const firstStart = parse(sug.groups.flatMap((g) => g.starts).sort()[0]);
  const day0 = new Date(firstStart); day0.setHours(0, 0, 0, 0);
  const req = sug.requested.slice(0, 13), best = sug.best_start.slice(0, 13);
  const pad = (n) => String(n).padStart(2, "0");
  let html = '<div class="heat"><span></span>' + Array.from({ length: 24 }, (_, h) => `<span class="hr">${h % 3 === 0 ? pad(h) : ""}</span>`).join("");
  for (let d = 0; d < 8; d++) {
    const day = new Date(day0.getTime() + d * 86400000);
    const cells = Array.from({ length: 24 }, (_, h) => {
      const k = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}T${pad(h)}`;
      const v = verdictOf[k];
      return `<span class="h ${v || ""} ${k === req ? "req" : ""} ${k === best ? "best" : ""}" title="${esc(DAY.format(day))} ${pad(h)}:00 ${v ? "→ " + v : "(not checked)"}"></span>`;
    }).join("");
    if (!cells.includes("SAFE") && !cells.includes("BLOCK") && !cells.includes("REVIEW")) continue;
    html += `<span class="day">${esc(DAY.format(day))}</span>${cells}`;
  }
  $("heat").innerHTML = html + `</div><p class="tiny faint" style="margin-top:10px">Each cell is a possible start time for ${esc(p.agent)}'s plan, coloured by its verdict together with every overlapping plan (white safe, grey review, orange blocked). Outlined: requested (dashed) and the earliest safe slot (black). Start times that see the same running jobs and the same overlapping plans have identical futures, so ${sug.candidates} start times needed only ${sug.rehearsed} rehearsals.</p>`;
  $("heat-title").textContent = `Safe start times for ${p.agent}`;
  $("heat-sub").textContent = `${p.title}`;
}
function feedItem(c) {
  if (c.type === "rehearsal") return `<li class="${c.fresh ? "fresh" : ""}"><time>${esc(clock(c.started))}</time><div class="who">${icon("orbit", 14)}<b>${esc(c.by)}</b>${clientBadge(c.client)}<span class="verdict-pill ${esc(c.status === "running" ? "running" : c.verdict || "")}">${esc(c.status === "running" ? "running" : c.verdict || c.status)}</span></div>
      <div class="what">rehearsal “${esc(c.title)}”${c.status !== "running" && c.p_crit != null ? `: ${pct(c.p_crit)} critical, ${c.exact ? "exact" : `${c.futures} futures`}` : ""} <button class="link-btn" type="button" data-watch="${esc(c.id)}">watch</button></div></li>`;
  const args = Object.entries(c.args || {}).filter(([k]) => k !== "agent").map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v).slice(0, 70) : v}`).join(", ");
  return `<li class="${c.fresh ? "fresh" : ""}"><time>${esc(clock(c.at))}</time><div class="who">${icon("bot", 14)}<b>${esc(c.agent)}</b>${clientBadge(c.client)}</div>
    <div class="what"><code>${esc(c.tool)}(${esc(args)})</code><br>${c.ok ? "" : '<b style="color:var(--signal-ink)">error: </b>'}${esc(c.summary)}</div></li>`;
}
function renderFeed() {
  const el = $("feed");
  el.innerHTML = S.feed.length ? S.feed.map(feedItem).join("") : '<li style="display:block"><p class="faint small">Waiting for agent calls. Connect Claude Desktop (right) and ask it to clean something up; every tool call appears here as it happens.</p></li>';
  el.querySelectorAll("[data-watch]").forEach((b) => (b.onclick = () => go("rehearse", b.dataset.watch)));
  S.feed.forEach((c) => (c.fresh = false));
}
function renderConnect() {
  const llm = S.status && S.status.llm;
  const cmd = (text) => `<div class="cmd"><span>${esc(text)}</span><button class="btn small ghost icon-only" type="button" data-copy="${esc(text)}" aria-label="Copy">${icon("copy", 14)}</button></div>`;
  $("connect").innerHTML = `<div><p class="section-title">Claude Desktop (recommended)</p><ol>
      <li>In PowerShell, in the multiverse folder: ${cmd("python connect_claude.py")}</li>
      <li>Quit Claude Desktop completely (system tray, then Quit) and open it again.</li>
      <li>Ask it: ${cmd("Use Multiverse to clean up Boutique Inc. Delete orders_archive, nobody uses it.")}</li></ol>
      <p class="tiny faint" style="margin-top:6px">Its tool calls show up on the left and its rehearsals play live on the Rehearse page.</p></div>
    <div><p class="section-title">An AI agent run from this console</p>${llm && llm.configured ? `<p class="small muted">Model: <code>${esc(llm.model)}</code>. It starts the MCP server like any agent.</p>
      <textarea id="task" name="task" rows="2" aria-label="Task for the AI agent" autocomplete="off" style="width:100%;margin-top:8px">Clean up: delete orders_archive, nobody seems to use it.</textarea>
      <div style="display:flex;gap:8px;margin-top:8px"><button class="btn primary" id="run-agent" type="button">${icon("bot", 15)}Run the agent</button></div><pre class="log" id="agent-log" hidden></pre>`
      : `<p class="small muted">Any OpenAI-compatible model with tool calling (OmniRoute, Gemini, …). Set these in PowerShell, then start the console from that same window:</p>
      ${cmd('$env:LLM_BASE_URL = "http://localhost:20128/v1"')}${cmd('$env:LLM_API_KEY = "your-key"')}${cmd('$env:LLM_MODEL = "provider/model-name"')}${cmd("python app.py")}`}</div>`;
  $("connect").querySelectorAll("[data-copy]").forEach((b) => (b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); toast("Copied", b.dataset.copy); } catch (_) { toast("Copy failed", "Select the text and copy it by hand.", "bad"); } }));
  $("run-agent") && ($("run-agent").onclick = async () => {
    const log = $("agent-log"); log.hidden = false; log.textContent = "";
    try {
      const { job } = await post("/api/agent/run", { task: $("task").value });
      const es = new EventSource(`/api/agent/${job}/stream`);
      es.addEventListener("line", (e) => { log.textContent += JSON.parse(e.data).text + "\n"; log.scrollTop = log.scrollHeight; });
      es.addEventListener("done", () => es.close());
    } catch (e) { log.textContent = e.message; }
  });
}

/* ======================================================================= live activity */
function startActivity() {
  const es = new EventSource("/api/activity/stream");
  const live = (cls, text) => { for (const d of ["live-dot", "live-dot2"]) if ($(d)) $(d).className = cls; $("live-line").textContent = text; };
  es.onopen = () => live("dot ok blink", "Live: streaming from FalkorDB");
  es.onerror = () => live("dot bad", "Reconnecting…");
  let backlog = true;
  setTimeout(() => (backlog = false), 1500);
  es.addEventListener("call", (e) => {
    const c = JSON.parse(e.data);
    c.fresh = !backlog;
    S.feed.unshift(c);
    S.feed.length = Math.min(S.feed.length, 120);
    if (S.page === "agents") renderFeed();
    if (!backlog && isExternal(c.client)) {
      toast(`${(CLIENTS[c.client] || [c.client])[0]}: ${c.agent} called ${c.tool}`, c.summary, c.ok ? "" : "bad", { label: "See", run: () => go("agents") });
      api("/api/status").then((st) => { S.status = st; renderAgentsLine(); }).catch(() => {});
    }
  });
  es.addEventListener("rehearsal", (e) => {
    const r = JSON.parse(e.data);
    const at = S.feed.findIndex((x) => x.type === "rehearsal" && x.id === r.id);
    if (at >= 0) S.feed.splice(at, 1);                     // one row per rehearsal, newest state on top
    S.feed.unshift({ ...r, type: "rehearsal", fresh: true });
    S.feed.length = Math.min(S.feed.length, 120);
    if (S.page === "agents") { renderFeed(); if (r.status !== "running") loadPlans(); }
    if (r.status !== "running") refreshInbox();
    const idle = !S.run || S.run.done;
    if (r.status === "running" && isExternal(r.client) && idle && S.page === "rehearse" && !S.tourOn) openStream(r.id);
    else if (r.status === "running" && isExternal(r.client)) toast(`${r.by} started a rehearsal`, r.title, "", { label: "Watch", run: () => go("rehearse", r.id) });
  });
  es.addEventListener("world", async () => {
    const mine = S.executing || Date.now() - S.selfChangedAt < 12000;
    await loadWorld();
    if (!mine) toast("The company changed", "An agent executed a plan. The graph has been reloaded.", "good");
  });
}

/* ======================================================================= company page */
const TEAM_COLORS = ["#141413", "#ff4a1c", "#2f55d4", "#1f8a5b", "#b8860b", "#8b5cf6"];
async function loadInsights() {
  try { S.insights = await api("/api/insights"); } catch (e) { S.insights = null; }
  renderCandidates(S.insights ? S.insights.candidates : []);
  renderFindings();
  paintOverlay();
  if (!S.selected) renderInspectorHome();
}
function paintOverlay() {
  const g = S.graphs.company;
  if (!g || !S.world) return;
  g.clear();
  const lg = $("overlay-legend");
  const ov = S.overlay;
  const ins = S.insights || {};
  lg.innerHTML = "";
  if (ov === "plain") {
    const unsure = S.world.edges.filter((e) => e.confidence < 1 && !e.answered);
    lg.innerHTML = `<span class="small muted">Click anything to see the file lines it came from.</span>${unsure.length ? `<span class="small muted">Not sure about:</span><div class="nbrs">${unsure.map((e) => `<button type="button" data-link="${esc(e.key)}">${esc(e.from)} → ${esc(e.to)} ${pct(e.confidence)}</button>`).join("")}</div>` : ""}`;
    lg.querySelectorAll("[data-link]").forEach((b) => (b.onclick = () => selectThing("link", b.dataset.link)));
  }
  if (ov === "source") {
    const real = S.world.nodes.filter((n) => n.source === "online-boutique");
    real.forEach((n) => g.badge(n.name, "real", "clear"));
    g.dimExcept(real.map((n) => n.name), S.world.edges.filter((e) => e.rule === "k8s").map((e) => e.key));
    lg.innerHTML = `<span class="small muted"><span class="chip clear">real</span> ${real.length} services and their links come from Google's Online Boutique Kubernetes file. The other ${S.world.nodes.length - real.length} assets are a synthetic back office, labelled as such.</span>`;
  }
  if (ov === "teams") {
    const teams = [...new Set(S.world.nodes.map((n) => n.owner))].sort();
    for (const n of S.world.nodes) { const c = TEAM_COLORS[teams.indexOf(n.owner) % TEAM_COLORS.length]; g.ring(n.name, c, false); }
    lg.innerHTML = teams.map((t, i) => `<span class="chip"><i style="width:10px;height:10px;border-radius:3px;background:${TEAM_COLORS[i % TEAM_COLORS.length]}"></i>${esc(t)} (${S.world.nodes.filter((n) => n.owner === t).length})</span>`).join("");
  }
  if (ov === "chokepoints") {
    const top = ins.chokepoints || [];
    top.forEach((c) => g.badge(c.name, `${c.score}`, "accent"));
    g.dimExcept(top.map((c) => c.name));
    lg.innerHTML = `<span class="small muted"><code>algo.betweenness</code>: how many dependency paths run through an asset. Touch the top ones and a lot is at risk.</span>`;
  }
  if (ov === "foundations") {
    const top = ins.foundations || [];
    top.forEach((c) => g.badge(c.name, c.score.toFixed(3), "accent"));
    g.dimExcept(top.map((c) => c.name));
    lg.innerHTML = `<span class="small muted"><code>algo.pageRank</code>: what everything ultimately leans on.</span>`;
  }
  if (ov === "islands") {
    const isl = (ins.islands || []).flat();
    isl.forEach((n) => g.nodeClass(n, "island"));
    g.dimExcept(isl);
    lg.innerHTML = `<span class="small muted"><code>algo.WCC</code>: groups connected to nothing else. ${isl.length ? `Islands now: ${isl.map(esc).join(", ")}.` : "Everything is connected right now."}</span>`;
  }
  if (S.selected) {
    g.select(S.selected.kind === "asset" ? S.selected.id : null);
    if (S.selected.kind === "link") { const [a, , b] = S.selected.id.split("|"); g.dimExcept([a, b], [S.selected.id]); }
  }
}
function renderInspectorHome() {
  $("inspector").hidden = true;
  paintOverlay();
}
function excerptHTML(x) {
  return `<div class="excerpt"><div class="excerpt-head"><span>${esc(x.label || x.file)}</span><span>${esc(x.file)}:${x.start}</span></div><ol>${x.lines.map((l, i) => `<li class="${(x.focus || []).includes(x.start + i) ? "focus" : ""}"><b>${x.start + i}</b>${esc(l)}</li>`).join("")}</ol></div>`;
}
async function selectThing(kind, id) {
  if (!S.world) return;
  S.selected = { kind, id };
  if (S.page !== "company") { go("company", `${kind}/${encodeURIComponent(id)}`); return; }
  const g = S.graphs.company;
  g.select(kind === "asset" ? id : null);
  if (kind === "asset") g.centerOn(id, innerWidth > 1180 ? 420 : 0);
  const box = $("inspector");
  box.hidden = false;
  box.innerHTML = '<div class="panel-body"><p class="faint">Loading…</p></div>';
  try {
    if (kind === "asset") await inspectAsset(id); else await inspectLink(id);
  } catch (e) { box.innerHTML = `<div class="panel-body"><p class="notice bad">${esc(e.message)}</p></div>`; }
}
async function inspectAsset(name) {
  const n = node(name);
  if (!n) throw new Error(`No asset called ${name}`);
  const g = S.graphs.company;
  paintOverlay();
  const near = new Set([name]), keys = [];
  for (const e of S.world.edges) if (e.from === name || e.to === name) { near.add(e.from); near.add(e.to); keys.push(e.key); }
  g.dimExcept([...near], keys);
  g.select(name);
  const [files, hist] = await Promise.all([api(`/api/sources/asset?name=${encodeURIComponent(name)}`), api(`/api/memory?name=${encodeURIComponent(name)}`).catch(() => [])]);
  const deps = S.world.edges.filter((e) => e.from === name), users = S.world.edges.filter((e) => e.to === name);
  const cap = n.capacity != null ? (n.replicas != null ? `${n.capacity} req/s (${n.replicas} replica${n.replicas > 1 ? "s" : ""} × ${n.cpu_m}m CPU × ${n.rps_per_core} per core)` : `${n.capacity} ops/s`) : null;
  const rows = [["Owner", n.owner], ["Criticality", `${n.criticality} of 3${n.criticality === 3 ? ", the business stops without it" : ""}`], n.schedule_text ? ["Runs", n.schedule_text] : null, cap ? ["Capacity", cap] : null, n.image ? ["Image", n.image] : null, n.engine ? ["Engine", n.engine] : null].filter(Boolean);
  $("inspector").innerHTML = `<div class="panel-head"><div class="insp-title"><h2>${esc(name)}</h2><div class="chips"><span class="chip">${esc(n.kind)}</span>${n.source === "online-boutique" ? '<span class="chip clear">real: Kubernetes file</span>' : '<span class="chip">synthetic</span>'}${n.criticality === 3 ? '<span class="chip crit">business-critical</span>' : ""}</div></div>
      <button class="btn small ghost icon-only" type="button" id="insp-close" aria-label="Close">${icon("x", 15)}</button></div>
    <div class="panel-body">${n.note ? `<p>${esc(n.note)}</p>` : ""}
      <dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
      <div><p class="section-title">Depends on</p><div class="nbrs">${deps.map((e) => `<button type="button" data-link="${esc(e.key)}">${esc(relWord(e.rel))} ${esc(e.to)}${e.confidence < 1 && !e.answered ? ` (${pct(e.confidence)})` : ""}</button>`).join("") || '<span class="faint small">nothing</span>'}</div></div>
      <div><p class="section-title">Used by</p><div class="nbrs">${users.map((e) => `<button type="button" data-link="${esc(e.key)}">${esc(e.from)} ${esc(relWord(e.rel))} it${e.confidence < 1 && !e.answered ? ` (${pct(e.confidence)})` : ""}</button>`).join("") || '<span class="faint small">nobody</span>'}</div></div>
      <div><p class="section-title">Rehearse a change to it</p><div class="nbrs"><button type="button" data-act="delete">Delete it</button><button type="button" data-act="offline">Take it offline 3 h</button>${n.capacity != null ? '<button type="button" data-act="scale">Scale ×2</button>' : ""}${n.kind === "Secret" ? '<button type="button" data-act="rotate">Rotate it</button>' : ""}</div></div>
      <div style="display:grid;gap:8px"><p class="section-title" style="margin:0">Where it came from</p>${files.map(excerptHTML).join("")}</div>
      <div><p class="section-title">In memory</p>${hist.length ? `<ul class="timeline" style="margin:0 -16px">${hist.slice(-6).reverse().map(historyItem).join("")}</ul>` : '<p class="faint small">Nothing yet. Every rehearsal, question and answer about it is kept here.</p>'}</div></div>`;
  wireInspector(name);
}
function wireInspector(name) {
  const box = $("inspector");
  $("insp-close").onclick = () => { S.selected = null; S.graphs.company.select(null); renderInspectorHome(); };
  box.querySelectorAll("[data-link]").forEach((b) => (b.onclick = () => selectThing("link", b.dataset.link)));
  box.querySelectorAll("[data-asset]").forEach((b) => (b.onclick = () => selectThing("asset", b.dataset.asset)));
  box.querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => {
    const step = { delete: { action: "delete", asset: name }, offline: { action: "offline", asset: name, start: nextHour(2), hours: 3 }, scale: { action: "scale", asset: name, factor: 2 }, rotate: { action: "rotate_secret", asset: name } }[b.dataset.act];
    S.plan = { title: "", steps: [step] };
    S.scenarioId = null; S.planAgent = "you";
    $("plan-story").textContent = "Your own plan, from the company graph.";
    renderPlan();
    go("rehearse");
    startRehearsal();
  }));
}
async function inspectLink(key) {
  const d = await api(`/api/sources/link?key=${encodeURIComponent(key)}`);
  const e = S.world.edges.find((x) => x.key === key) || {};
  S.graphs.company.dimExcept([d.from, d.to], [key]);
  const ruleText = { k8s: "A running Kubernetes deployment is configured with its address, so it is certain.", verified: "Declared in the catalog and signed off by the owning team, so it is certain.", logs: "Learned from the access log: the share of the job's runs that used it, recent runs counting more.", declared: "Declared in an old runbook, never verified, and the access log cannot see it: a coin flip.", plan: "Added by a plan." }[d.rule] || "";
  let runs = "";
  if (d.runs && d.runs.items.length) {
    const items = d.runs.items, wMax = Math.max(...items.map((r) => r.weight));
    const usedW = items.filter((r) => r.used).reduce((a, r) => a + r.weight, 0), allW = items.reduce((a, r) => a + r.weight, 0);
    const last3 = items.slice(-d.runs.certain_streak);
    const certain = items.length >= d.runs.certain_streak && last3.every((r) => r.used);
    runs = `<div><p class="section-title">Every run of ${esc(d.from)} in the access log</p><div class="runs">${items.map((r) => `<div class="run-row"><time>${esc(YMD.format(parse(r.at)))}</time><div class="bar"><i class="${r.used ? "used" : ""}" style="width:${(r.weight / wMax * 100).toFixed(1)}%"></i></div><span class="w">${r.used ? "used" : "not used"}</span></div>`).join("")}</div>
      <p class="tiny faint" style="margin-top:6px">Bar length = how much the run counts (it halves every ${d.runs.half_life_days} days). Black = it touched ${esc(d.to)}.</p>
      <p class="formula" style="margin-top:8px">${certain ? `Used in each of the last ${d.runs.certain_streak} runs, so <b>certain</b>.` : `${usedW.toFixed(2)} (runs that used it) ÷ ${allW.toFixed(2)} (all runs) = <b>${pct(usedW / allW)}</b>${Math.abs(usedW / allW - d.confidence) > 0.006 ? ` (kept between 5% and 95%: ${pct(d.confidence)})` : ""}`}</p></div>`;
  }
  $("inspector").innerHTML = `<div class="panel-head"><div class="insp-title"><h2>${esc(d.from)} ${esc(relWord(d.rel))} ${esc(d.to)}</h2><div class="chips"><span class="chip ${d.confidence < 1 && !e.answered ? "chance" : "ok"}">${e.answered ? (e.answered.exists ? "confirmed by " + esc(e.answered.by) : "denied by " + esc(e.answered.by)) : d.confidence < 1 ? `${pct(d.confidence)} sure` : "certain"}</span><span class="chip">${esc(d.rule)}</span>${e.soft ? '<span class="chip">soft: works without it</span>' : ""}</div></div>
      <button class="btn small ghost icon-only" type="button" id="insp-close" aria-label="Close">${icon("x", 15)}</button></div>
    <div class="panel-body"><p class="small muted">${esc(ruleText)}</p>${runs}
      <div style="display:grid;gap:8px"><p class="section-title" style="margin:0">Evidence</p><ul class="evidence-list">${d.evidence.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>${d.files.map(excerptHTML).join("")}</div>
      ${d.confidence < 1 && !e.answered ? `<div><p class="section-title">What if we were this sure?</p><div style="display:flex;gap:10px;align-items:center"><input type="range" id="whatif" min="0" max="100" value="${Math.round(d.confidence * 100)}" aria-label="Assumed confidence"><b id="whatif-v" class="num" style="width:44px">${pct(d.confidence)}</b></div>
        <button class="btn small" type="button" id="whatif-add" style="margin-top:8px">${icon("play", 14)}Rehearse deleting ${esc(d.to)} as if</button></div>` : ""}
      <div class="nbrs"><button type="button" data-asset="${esc(d.from)}">${esc(d.from)}</button><button type="button" data-asset="${esc(d.to)}">${esc(d.to)}</button></div></div>`;
  wireInspector(d.to);
  const r = $("whatif");
  if (r) {
    r.oninput = () => ($("whatif-v").textContent = `${r.value}%`);
    $("whatif-add").onclick = () => {
      S.plan = { title: "", steps: [{ action: "assume", link: key, confidence: Number(r.value) / 100 }, { action: "delete", asset: d.to }] };
      S.scenarioId = null; S.planAgent = "you";
      $("plan-story").textContent = `What if: ${d.from} ${relWord(d.rel)} ${d.to} at ${r.value}%.`;
      renderPlan(); go("rehearse"); startRehearsal();
    };
  }
}
function renderCandidates(items, checked = false) {
  const el = $("candidates");
  if (!items || !items.length) { el.innerHTML = '<li class="faint small">No cleanup candidates right now.</li>'; return; }
  el.innerHTML = items.map((c) => `<li><div class="row-top"><span><b>${esc(c.name)}</b> ${checked ? `<span class="verdict-pill ${esc(c.verdict)}">${esc(WORD[c.verdict] || c.verdict)}</span>` : ""}</span><span class="faint small">${esc(c.owner || "")}</span></div>
    <p class="small muted" style="margin-top:2px">${esc(c.why)}${checked ? `. Rehearsal: ${c.exact ? "exact" : c.futures + " futures"}, critical ${pct(c.p_crit)}${c.affected.length ? `, breaks ${c.affected.map(esc).join(", ")}` : ""}${c.waiting_for.length ? `. Waiting for ${c.waiting_for.map(esc).join(", ")}` : ""}.` : ""}</p>
    <div class="nbrs" style="margin-top:6px"><button type="button" data-asset="${esc(c.name)}">Inspect</button>${checked ? `<button type="button" data-watch="${esc(c.rid)}">Open its rehearsal</button>` : ""}</div></li>`).join("");
  el.querySelectorAll("[data-asset]").forEach((b) => (b.onclick = () => selectThing("asset", b.dataset.asset)));
  el.querySelectorAll("[data-watch]").forEach((b) => (b.onclick = () => go("rehearse", b.dataset.watch)));
}
async function renderFindings() {
  const el = $("findings");
  const fs = (S.insights && S.insights.findings) || (S.world && S.world.findings) || [];
  if (!fs.length) { el.innerHTML = '<p class="faint small">Nothing found.</p>'; return; }
  const parts = await Promise.all(fs.map(async (f) => {
    const m = /kubernetes-manifests\.yaml:(\d+)/.exec(f.detail);
    let ex = "";
    if (m) { try { ex = excerptHTML(await api(`/api/sources/line?file=kubernetes-manifests.yaml&line=${m[1]}`)); } catch (_) { /* fine */ } }
    return `<div style="display:grid;gap:8px"><p class="small"><span class="chip minor">${esc(f.kind)}</span> ${esc(f.detail)}</p>${ex}</div>`;
  }));
  el.innerHTML = parts.join("");
}
function renderCounts() {
  const w = S.world;
  if (!w) return;
  const kinds = {};
  w.nodes.forEach((n) => (kinds[n.kind] = (kinds[n.kind] || 0) + 1));
  const rules = {};
  w.edges.forEach((e) => (rules[e.rule] = (rules[e.rule] || 0) + 1));
  const unsure = w.edges.filter((e) => e.confidence < 1 && !e.answered).length;
  const teams = new Set(w.nodes.map((n) => n.owner)).size;
  const cell = (n, l) => `<div class="count-cell"><b class="num">${n}</b><span>${esc(l)}</span></div>`;
  $("counts").innerHTML = cell(w.nodes.length, `assets: ${Object.entries(kinds).map(([k, v]) => `${v} ${k.toLowerCase()}${v > 1 ? "s" : ""}`).join(", ")}`) +
    cell(w.edges.length, `links: ${Object.entries(rules).map(([k, v]) => `${v} ${k}`).join(", ")}`) + cell(unsure, "links nobody is sure about") + cell(teams, "teams own them");
  $("counts-sub").textContent = `Built ${when(w.meta.built_at)}`;
}
async function findPath() {
  const a = $("path-a").value, b = $("path-b").value;
  const g = S.graphs.company;
  try {
    const r = await api(`/api/path?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
    paintOverlay();
    if (!r.names.length) { $("path-out").textContent = `No dependency path between ${a} and ${b}, in either direction.`; return; }
    r.names.forEach((n) => g.nodeClass(n, "hl"));
    r.keys.forEach((k) => g.edgeClassByKey(k, "hl"));
    g.dimExcept(r.names, r.keys);
    $("path-out").innerHTML = `${esc(r.direction)}: ${r.names.map(esc).join(" → ")} <span class="faint">(Cypher <code>shortestPath</code>)</span>`;
  } catch (e) { $("path-out").textContent = e.message; }
}
async function askGraph(q) {
  const box = $("ask-result");
  box.hidden = false;
  box.innerHTML = `<p class="small muted">${icon("orbit", 14)} Writing a Cypher query for “${esc(q)}”…</p>`;
  try {
    const r = await post("/api/ask", { question: q });
    const rows = r.rows.slice(0, 8);
    box.innerHTML = `<div class="row-top"><p><b>${esc(r.answer)}</b></p><button class="btn small ghost icon-only" type="button" id="ask-close" aria-label="Close the answer">${icon("x", 15)}</button></div><pre class="code" style="max-height:120px">${highlightCypher(r.cypher)}</pre>
      ${rows.length ? `<table class="mini-table"><thead><tr>${r.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${(Array.isArray(row) ? row : [row]).map((v) => `<td>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</td>`).join("")}</tr>`).join("")}</tbody></table>` : ""}
      <p class="tiny faint">Run with GRAPH.RO_QUERY (read-only) in ${r.ms} ms. ${r.rows.length > rows.length ? `Showing ${rows.length} of ${r.rows.length} rows.` : ""}</p>`;
    $("ask-close").onclick = () => { box.hidden = true; paintOverlay(); };
    const g = S.graphs.company;
    paintOverlay();
    r.assets.forEach((n) => g.nodeClass(n, "hl"));
    if (r.assets.length) g.dimExcept(r.assets);
  } catch (e) {
    box.innerHTML = `<div class="notice bad">${icon("circle-alert", 16)}<span style="flex:1">${esc(e.message)}</span><button class="btn small ghost icon-only" type="button" id="ask-close" aria-label="Close">${icon("x", 15)}</button></div>`;
    $("ask-close").onclick = () => { box.hidden = true; };
  }
}

/* ======================================================================= inbox */
async function refreshInbox() {
  S.inbox = await api("/api/inbox").catch(() => []);
  const b = $("inbox-badge");
  if (b) { b.hidden = !S.inbox.length; b.textContent = S.inbox.length; }
  if ($("inbox-count")) $("inbox-count").textContent = S.inbox.length;
  if (S.page === "inbox") renderQuestions();
}
async function loadInbox() {
  await refreshInbox();
  renderQuestions();
  renderLearned();
  const rs = await api("/api/rehearsals").catch(() => []);
  $("recent").innerHTML = rs.length ? rs.map((r) => `<li class="clickable" data-rid="${esc(r.id)}" tabindex="0"><div class="row-top"><span><b>${esc(r.title)}</b></span><span class="verdict-pill ${esc(r.verdict || r.status)}">${esc(r.verdict ? WORD[r.verdict] : r.status)}</span></div>
      <p class="tiny faint" style="margin-top:2px">${esc(when(r.started))}, ${esc(r.by)}${isExternal(r.client) ? ` via ${esc((CLIENTS[r.client] || [r.client])[0])}` : ""}, ${esc(r.kind)}: ${r.exact ? "exact" : (r.futures || 0) + " futures"}${r.p_crit != null ? `, ${pct(r.p_crit)} critical` : ""}</p></li>`).join("") : '<li class="faint small">No rehearsals yet.</li>';
  $("recent").querySelectorAll("[data-rid]").forEach((li) => { li.onclick = () => go("rehearse", li.dataset.rid); li.onkeydown = (e) => { if (e.key === "Enter") go("rehearse", li.dataset.rid); }; });
  loadHistory();
}
function renderQuestions() {
  const el = $("questions");
  if (!S.inbox.length) { el.innerHTML = '<p class="empty">No open questions. When a rehearsal hinges on a link nobody is sure about, the owning team gets a question here.</p>'; return; }
  el.innerHTML = S.inbox.map((q, i) => {
    const e = S.world && S.world.edges.find((x) => x.key === `${q.source}|${q.rel}|${q.target}`);
    return `<div class="question"><div class="row-top"><span class="team-tag">${icon("user", 14)}${esc(q.team)}</span><span class="tiny faint">asked ${esc(when(q.at))}</span></div>
      <h3>Does <b>${esc(q.source)}</b> still ${esc(relBase(q.rel))} <b>${esc(q.target)}</b>?</h3>
      ${e ? `<p class="small muted">Multiverse is ${pct(e.confidence)} sure from the evidence: ${esc((e.evidence || []).find((x) => /used in|never|50%|declared/.test(x)) || (e.evidence || [])[0] || "")}</p>` : ""}
      <div class="actions"><input type="text" id="note-${i}" placeholder="Note for the record (optional)…" autocomplete="off" aria-label="Note"><button class="btn" type="button" data-i="${i}" data-yes="1">Yes, it still does</button><button class="btn primary" type="button" data-i="${i}" data-yes="0">No, not any more</button></div></div>`;
  }).join("");
  el.querySelectorAll("button[data-i]").forEach((b) => (b.onclick = () => answer(S.inbox[Number(b.dataset.i)], b.dataset.yes === "1", $(`note-${b.dataset.i}`).value)));
}
async function answer(q, exists, note = "") {
  try {
    await post("/api/answer", { link: q.link, team: q.team, exists, note });
    toast(`Saved: ${q.team} says ${exists ? "yes" : "no"}`, `${q.source} ${exists ? "still " + relWord(q.rel) : "no longer " + relWord(q.rel)} ${q.target}. Every later rehearsal uses this.`, "good", { label: "Rehearse again", run: () => { go("rehearse"); startRehearsal(); } });
    await loadWorld();
    await loadInbox();
  } catch (e) { toast("Not saved", e.message, "bad"); }
}
function renderLearned() {
  const facts = (S.world ? S.world.edges : []).filter((e) => e.answered);
  $("learned").innerHTML = facts.length ? facts.map((e) => `<li><span class="team-tag">${esc(e.answered.by)}</span><span>${esc(e.from)} ${e.answered.exists ? "" : "does <b>not</b> "}${esc(relWord(e.rel))} ${esc(e.to)}</span></li>`).join("") : '<li style="display:block"><p class="faint small">Nothing yet. Answer a question and it appears here.</p></li>';
}
function historyItem(e) {
  let t = "";
  if (e.kind === "Rehearsal") t = `<b>Rehearsal</b> ${esc(e.title)}: ${esc(e.verdict ? WORD[e.verdict] : e.state)}${e.p_crit != null ? ` ${pct(e.p_crit)}` : ""} <span class="faint">(${esc(e.by)}${isExternal(e.client) ? " via " + esc((CLIENTS[e.client] || [e.client])[0]) : ""})</span>`;
  else if (e.kind === "Question") t = `<b>Asked ${esc(e.team)}</b>: ${esc(e.link)} (${esc(e.status)})`;
  else if (e.kind === "Fact") t = `<b>${esc(e.by)} answered</b>: ${esc(e.link)} ${e.exists ? "exists" : "does not exist"}${e.note ? ` “${esc(e.note)}”` : ""}`;
  else t = `<b>${esc(e.kind)}</b> ${esc(e.title || "")} ${esc(e.status || "")}`;
  return `<li><time>${esc(dayOf(e.at))}<br>${esc(clock(e.at))}</time><span class="small">${t}</span></li>`;
}
async function loadHistory() {
  const name = $("mem-asset").value;
  if (!name) return;
  const evs = await api(`/api/memory?name=${encodeURIComponent(name)}`).catch(() => []);
  $("history").innerHTML = evs.length ? evs.slice().reverse().map(historyItem).join("") : `<li style="display:block"><p class="faint small">Nothing yet about ${esc(name)}.</p></li>`;
}

/* ======================================================================= how it works */
function renderHow() {
  if ($("how-steps").children.length) return;
  const steps = [
    ["database", "Build the company graph from evidence", "world.py reads Google's real Online Boutique Kubernetes file (who calls whom, replicas, CPU), plus a synthetic catalog, owners file and a 13-month access log. Every link gets a confidence computed from its evidence and stored on the link.", "UNWIND $rows AS r\nMATCH (a:Asset {name: r.a}), (b:Asset {name: r.b})\nCREATE (a)-[l:READS]->(b) SET l = r.props"],
    ["layers", "Snapshot the company, apply the plan to the copy", "A rehearsal starts by copying the whole graph. The plan's changes (repoint, scale, add a service…) are applied to that copy with the same Cypher a real execution would use.", "GRAPH.COPY boutique_main boutique_main__R-…__snapshot"],
    ["dice-5", "Roll the dice for every future", "Each future is one random draw: does each uncertain link really exist? Does a hand-run job run during the window? How big is the launch traffic? Each future then gets its own full copy of the snapshot.", "GRAPH.COPY …__snapshot …__f017\nMATCH ()-[r]->() WHERE r.key IN $keys DELETE r"],
    ["activity", "Let the failure ripple, one hop at a time", "Starting from what the plan deletes or overloads, Multiverse asks FalkorDB who depends on it, then who depends on those, against the arrows. Soft links only degrade; data feeds go stale.", "UNWIND $frontier AS f\nMATCH (x:Asset)-[r:CALLS|READS|WRITES|USES_SECRET|DEPENDS_ON|FED_BY]->(y:Asset {name: f})\nWHERE NOT r.key IN $inactive\nRETURN x.name, type(r), r.soft, r.key, y.name"],
    ["gauge", "Count, and stop when the answer is clear", "The share of futures where something business-critical breaks, with a 95% range (Wilson). Futures are added 25 at a time until the range is clearly above or below the 5% safety line. If nothing uncertain is involved, one future is the exact answer.", "BLOCK   if 5% or more of futures break something critical\nREVIEW  if only minor things break\nSAFE    otherwise"],
    ["inbox", "Ask the owners, remember, and only then act", "Uncertain links become questions for the team that owns them. Answers live in a second graph (memory) and replace the dice in every later rehearsal. Execution re-rehearses first and applies only a SAFE plan; a SHA-256 fingerprint proves the real graph was untouched until then.", "MATCH (q:Question {link: $l, status: 'open'}), (f:Fact {id: $id})\nSET q.status = 'answered'\nCREATE (f)-[:ANSWERS]->(q)"],
  ];
  $("how-steps").innerHTML = steps.map(([ic, t, p, code], i) => `<li class="panel how-step rv" style="--i:${i}"><div class="how-num"><span>${String(i + 1).padStart(2, "0")}</span>${icon(ic, 22)}</div><div><h3>${esc(t)}</h3><p>${esc(p)}</p></div><pre class="code">${highlightCypher(code)}</pre></li>`).join("");
  const feats = [
    ["GRAPH.COPY", "Every future is a full copy of the company graph; the real one is never written during a rehearsal."],
    ["OpenCypher, variable-length paths", "Blast radius, upstream search, load along every path (reduce over relationships)."],
    ["UNWIND batch writes", "Building the world graph and writing each future's statuses in one query."],
    ["Indexes + full-text index", "Fast lookups by name; the search box (Ctrl K) uses db.idx.fulltext.queryNodes."],
    ["shortestPath", "The path finder on the Company graph page."],
    ["algo.betweenness, algo.pageRank, algo.WCC", "Chokepoints, foundations and islands; islands feed the cleanup finder."],
    ["Two graphs", "boutique_main (the company) and boutique_memory (rehearsals, futures, questions, answers, agent calls, plans)."],
    ["GRAPH.RO_QUERY", "Ask the graph in plain English: an LLM writes Cypher, FalkorDB runs it read-only."],
    ["Live reads", "The console streams every future and every agent call by reading the memory graph (Server-Sent Events)."],
  ];
  $("features").innerHTML = feats.map(([k, v]) => `<li><code>${esc(k)}</code><span class="muted">${esc(v)}</span></li>`).join("");
  const real = [
    ["Real", "The 12 services, their links, replicas and CPU limits: Google's Online Boutique kubernetes-manifests.yaml (Apache-2.0), unmodified."],
    ["Real", "The config drift it finds (frontend points at a service that does not exist, line 542)."],
    ["Synthetic", "The back office (jobs, databases, secrets), the owners file, the access log and the load-test numbers. Invented for the demo and labelled."],
    ["Computed live", "Every percentage, verdict, breaking point and safe slot, from those files, each time you press a button."],
    ["Real AI", "Claude Desktop (or any OpenAI-compatible model through agent.py) calling the 13 MCP tools."],
  ];
  $("realness").innerHTML = real.map(([k, v]) => `<li><span class="chip ${k === "Real" ? "clear" : k === "Synthetic" ? "" : "ok"}">${esc(k)}</span><span class="muted">${esc(v)}</span></li>`).join("");
}

/* ======================================================================= command palette */
const Palette = {
  items: [], sel: 0, timer: null, remote: [],
  open() {
    const root = $("palette-root");
    root.hidden = false;
    root.innerHTML = `<div class="scrim" data-close><div class="palette" role="dialog" aria-modal="true" aria-label="Search or run a command">
      <div class="palette-input">${icon("search", 18)}<input id="pal-in" type="text" placeholder="Search assets, run a scenario, go to a page, or ask a question…" autocomplete="off" spellcheck="false" aria-label="Search" role="combobox" aria-expanded="true" aria-controls="pal-list"></div>
      <ul class="palette-list" id="pal-list" role="listbox"></ul>
      <div class="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> run</span><span><kbd>Esc</kbd> close</span><span style="margin-left:auto" id="pal-how"></span></div></div></div>`;
    const input = $("pal-in");
    input.oninput = () => this.update(input.value);
    input.onkeydown = (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); this.move(1); }
      if (e.key === "ArrowUp") { e.preventDefault(); this.move(-1); }
      if (e.key === "Enter") { e.preventDefault(); this.run(this.items[this.sel]); }
      if (e.key === "Escape") this.close();
    };
    root.querySelector(".scrim").onclick = (e) => { if (e.target.hasAttribute("data-close")) this.close(); };
    this.remote = [];
    this.update("");
    input.focus();
  },
  close() { $("palette-root").hidden = true; $("palette-root").innerHTML = ""; },
  isOpen() { return !$("palette-root").hidden; },
  base() {
    const pages = PAGES.map((p) => ({ group: "Go to", icon: p.icon, title: p.label, sub: "", run: () => go(p.id) }));
    const scen = S.scenarios.map((p) => ({ group: "Rehearse a scenario", icon: SCEN_ICON[p.id] || "play", title: shortTitle(p), sub: p.story, run: () => { go("rehearse"); pickScenario(p.id); startRehearsal(); } }));
    const acts = [
      { group: "Actions", icon: "play", title: "Rehearse the current plan", sub: planTitle(S.plan), run: () => { go("rehearse"); startRehearsal(); } },
      { group: "Actions", icon: "radar", title: "Run the two-agent demo", sub: "Two plans, safe alone, dangerous together", run: () => { go("agents"); twoAgentDemo(); } },
      { group: "Actions", icon: "scan-search", title: "Find cleanup candidates and rehearse each", sub: "Graph algorithms + one rehearsal each", run: () => { go("company"); setTimeout(runCleanup, 200); } },
      { group: "Actions", icon: "circle-help", title: "Take the tour", sub: "Two minutes, uses the real engine", run: () => Tour.start() },
      { group: "Actions", icon: "rotate-ccw", title: "Reset the demo", sub: "Rebuild the company from the evidence files, wipe memory", run: () => resetDemo() },
    ];
    return [...acts, ...scen, ...pages];
  },
  build(q) {
    const t = q.trim().toLowerCase();
    let items = this.base().filter((i) => !t || `${i.title} ${i.sub}`.toLowerCase().includes(t));
    if (t && S.world) {
      const local = S.world.nodes.filter((n) => n.name.toLowerCase().includes(t) || (n.note || "").toLowerCase().includes(t)).slice(0, 6);
      const names = new Set(local.map((n) => n.name));
      const remote = this.remote.filter((r) => !names.has(r.name));
      items = [...local.map((n) => ({ group: "Assets", icon: KIND_ICON[n.kind] || "box", title: n.name, sub: n.note || n.kind, run: () => selectThing("asset", n.name) })),
        ...remote.map((r) => ({ group: "Also found by FalkorDB full-text search", icon: KIND_ICON[r.kind] || "box", title: r.name, sub: r.note || r.kind, run: () => selectThing("asset", r.name) })), ...items];
      if (t.length > 6 && t.includes(" ")) items.push({ group: "Ask", icon: "message-square-text", title: `Ask the graph: “${q.trim()}”`, sub: "An LLM writes read-only Cypher; FalkorDB runs it", run: () => { go("company"); $("ask-input").value = q.trim(); setTimeout(() => askGraph(q.trim()), 150); } });
    }
    return items;
  },
  update(q) {
    this.remote = [];
    this.items = this.build(q);
    this.sel = 0;
    this.render(this.items);
    clearTimeout(this.timer);
    if (!q.trim()) { $("pal-how").textContent = ""; return; }
    this.timer = setTimeout(async () => {
      try {
        const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
        if (!this.isOpen() || $("pal-in").value !== q) return;
        this.remote = r.results;
        $("pal-how").textContent = r.how ? `searched with the ${r.how}` : "";
        this.items = this.build(q);
        this.sel = Math.min(this.sel, Math.max(0, this.items.length - 1));
        this.render(this.items);
      } catch (_) { /* search is optional */ }
    }, 140);
  },
  render(items) {
    const list = $("pal-list");
    if (!list) return;
    let last = "";
    list.innerHTML = items.length ? items.map((it, i) => {
      const head = it.group !== last ? `<li class="palette-group" role="presentation">${esc(it.group)}</li>` : "";
      last = it.group;
      return `${head}<li class="palette-item" role="option" id="pal-${i}" data-i="${i}" aria-selected="${i === this.sel}">${icon(it.icon, 16)}<div class="main"><b>${esc(it.title)}</b>${it.sub ? `<span>${esc(it.sub)}</span>` : ""}</div></li>`;
    }).join("") : '<li class="empty">Nothing matches.</li>';
    list.querySelectorAll(".palette-item").forEach((li) => {
      li.onclick = () => this.run(items[Number(li.dataset.i)]);
      li.onmousemove = () => { if (this.sel !== Number(li.dataset.i)) { this.sel = Number(li.dataset.i); this.mark(); } };
    });
  },
  mark() {
    document.querySelectorAll(".palette-item").forEach((li) => li.setAttribute("aria-selected", String(Number(li.dataset.i) === this.sel)));
    const cur = $(`pal-${this.sel}`);
    if (cur) { cur.scrollIntoView({ block: "nearest" }); $("pal-in").setAttribute("aria-activedescendant", cur.id); }
  },
  move(d) { if (!this.items.length) return; this.sel = (this.sel + d + this.items.length) % this.items.length; this.mark(); },
  run(it) { if (!it) return; this.close(); it.run(); },
};
/* ======================================================================= guided tour */
const Tour = {
  i: 0,
  steps: [
    { page: "rehearse", target: "#rehearse-graph-panel", title: "This is the company, as a graph", text: "Boutique Inc. lives in FalkorDB. The 12 services come from Google's real Kubernetes file; the back office is synthetic. Arrows point at what each asset depends on. Dashed links are ones nobody is sure about, and the % on them is computed from evidence." },
    { page: "rehearse", target: "#plan-bar", title: "An AI agent wants to change something", text: "A cleanup agent wants to delete orders_archive. Nothing declares that anyone still uses it, so it looks safe to delete.", enter: () => pickScenario("cleanup-archive") },
    { page: "rehearse", target: "#run", title: "Rehearse it in many futures", text: "Multiverse copies the company with GRAPH.COPY, rolls dice for every link it is unsure about, and plays the delete in every copy. Press Next to start it.", next: "Rehearse", act: () => rehearseAndWait() },
    { page: "rehearse", target: "#field-panel", title: "Every square is one copy of the company", text: "Orange squares are futures where something business-critical broke. The verdict is not a guess: it is counted, and it stopped as soon as the 95% range was clearly above the 5% line." },
    { page: "rehearse", target: "#rehearse-graph-panel", title: "Open one future", text: "Here the archive is deleted and tax_filing_job breaks, because it reads the archive. Press Replay in the card to watch every FalkorDB command of this future run again, step by step.", enter: async () => { const t = document.querySelector(".tile.critical"); if (t) await openFuture(Number(t.dataset.i)); } },
    { page: "rehearse", target: "#verdict", title: "Blocked, and the right teams were asked", text: "About half the futures break tax filing, far above the 5% safety line. It all hinges on links nobody is sure about, so Multiverse asked Finance and Data." },
    { page: "inbox", target: "#questions", title: "Answer as the teams", text: "Finance confirms tax filing stopped reading the archive in October, and Data confirms the revenue report doesn't need it. Press Next to give both answers.", next: "Answer both", act: async () => { for (const q of [...S.inbox]) await post("/api/answer", { link: q.link, team: q.team, exists: false, note: "Answered during the tour" }).catch(() => {}); await loadWorld(); await loadInbox(); } },
    { page: "rehearse", target: "#verdict", title: "Now it is exact, and safe", text: "With the answers in memory nothing is uncertain any more, so one future is the whole answer. The fingerprint shows the real company was not touched. Only now could Execute for real go through.", enter: async () => { pickScenario("cleanup-archive"); await rehearseAndWait(); } },
    { page: "launch", target: "#launch-controls", title: "Launch day", text: "Drag the traffic slider: services turn orange where the traffic passes their capacity, worked out along every path in the graph. Rehearse it to check the maths against 100 futures, then add the scaling advice." },
    { page: "agents", target: "#strips", title: "Two agents, one company", text: "Press Next: the finance agent and the platform agent each propose a plan that is safe alone. Together they break billing, so Multiverse holds the second one and finds the earliest safe slot.", next: "Run it", act: async () => { await twoAgentDemo(); } },
    { page: "agents", target: "#connect", title: "Plug in a real AI agent", text: "Run python connect_claude.py and Claude Desktop uses Multiverse through MCP. Its tool calls appear here live, and its rehearsals play on the Rehearse page." },
  ],
  async start() {
    if (!(await confirmDialog({ title: "Take the tour?", body: "About two minutes. It resets the demo first, then drives the real engine: every number you see is computed live.", confirm: "Start the tour" }))) return;
    await resetDemo(true);
    S.tourOn = true;
    this.i = 0;
    storage.set("mv-toured", "1");
    this.show();
  },
  stop() { S.tourOn = false; $("coach").hidden = true; $("spot").hidden = true; cancelAnimationFrame(this.raf); },
  async show() {
    const st = this.steps[this.i];
    if (S.page !== st.page) { go(st.page); await sleep(260); }
    if (st.enter) await st.enter();
    const c = $("coach");
    c.hidden = false;
    c.innerHTML = `<div class="step-n">Step ${this.i + 1} of ${this.steps.length}</div><h3>${esc(st.title)}</h3><p>${esc(st.text)}</p>
      <div class="actions"><div class="dots">${this.steps.map((_, k) => `<i class="${k <= this.i ? "on" : ""}"></i>`).join("")}</div>
      <div><button class="btn small ghost" type="button" id="tour-end">End</button>${this.i ? '<button class="btn small" type="button" id="tour-back">Back</button>' : ""}<button class="btn small primary" type="button" id="tour-next">${esc(st.next || (this.i === this.steps.length - 1 ? "Finish" : "Next"))}</button></div></div>`;
    $("tour-end").onclick = () => this.stop();
    $("tour-back") && ($("tour-back").onclick = () => { this.i--; this.show(); });
    $("tour-next").onclick = async () => {
      const b = $("tour-next");
      if (st.act) { b.disabled = true; b.textContent = "Working…"; try { await st.act(); } catch (e) { toast("Tour step failed", e.message, "bad"); } }
      if (this.i >= this.steps.length - 1) { this.stop(); toast("That's Multiverse", "Explore on your own: press Ctrl K to search or run anything.", "good"); return; }
      this.i++;
      this.show();
    };
    const el = document.querySelector(st.target);
    if (el) el.scrollIntoView({ behavior: REDUCED.matches ? "auto" : "smooth", block: "center" });
    this.follow(st.target);
  },
  follow(sel) {
    cancelAnimationFrame(this.raf);
    const spot = $("spot");
    const tick = () => {
      const el = document.querySelector(sel);
      if (!el || !S.tourOn) { spot.hidden = true; return; }
      const r = el.getBoundingClientRect();
      const coach = $("coach");
      const leftSide = innerWidth > 760 && r.left + r.width / 2 > innerWidth * 0.55;
      coach.style.left = leftSide ? "20px" : "";
      coach.style.right = leftSide ? "auto" : "";
      spot.hidden = false;
      spot.style.left = `${r.left - 6}px`; spot.style.top = `${r.top - 6}px`;
      spot.style.width = `${r.width + 12}px`; spot.style.height = `${r.height + 12}px`;
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  },
};

async function rehearseAndWait() {
  const done = new Promise((res) => (S.tourWaiter = res));
  const rid = await startRehearsal();
  if (!rid) { S.tourWaiter = null; return null; }
  return Promise.race([done, sleep(90000)]);
}

/* ======================================================================= reset + cleanup */
async function resetDemo(silent = false) {
  if (!silent && !(await confirmDialog({ title: "Reset the demo?", body: "Rebuilds the company from the evidence files and wipes the memory graph: every rehearsal, question, answer, plan and agent call.", confirm: "Reset", danger: true }))) return;
  try {
    if (S.es) S.es.close();
    await post("/api/reset");
    S.summary = null; S.run = null; S.viewing = null; S.feed = []; S.selected = null;
    $("future-banner").hidden = true; $("details").hidden = true;
    resetLanes(); pipeline("init"); renderVerdict("idle"); endRun();
    await Promise.all([loadWorld(), loadScenarios()]);
    pickScenario(S.scenarios[0].id);
    await Promise.all([loadPlans(), refreshInbox()]);
    if (S.page === "company") loadInsights();
    if (!silent) toast("Demo reset", "The company was rebuilt from the evidence files and memory was wiped.", "good");
  } catch (e) { toast("Reset failed", e.message, "bad"); }
}
async function runCleanup() {
  const b = $("cleanup");
  b.disabled = true;
  b.innerHTML = `${icon("orbit", 14)}Rehearsing each…`;
  try { renderCandidates(await post("/api/cleanup"), true); } catch (e) { toast("Cleanup check failed", e.message, "bad"); }
  b.disabled = false;
  b.innerHTML = `${icon("play", 14)}Check each one`;
}

/* ======================================================================= wiring + boot */
function wire() {
  hydrateIcons();
  $("open-palette").onclick = () => Palette.open();
  addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); Palette.isOpen() ? Palette.close() : Palette.open(); }
    if (e.key === "Escape" && S.viewing && !Palette.isOpen()) closeFuture();
  });
  $("run").onclick = () => startRehearsal();
  $("execute").onclick = () => executeForReal();
  $("stop").onclick = async () => { if (S.run) await post(`/api/rehearsals/${S.run.rid}/cancel`).catch(() => {}); };
  $("mode-seg").querySelectorAll("button").forEach((b) => (b.onclick = () => {
    S.mode = b.dataset.mode;
    $("mode-seg").querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
  }));
  $("add-step-toggle").onclick = () => {
    const open = $("add-step").hidden;
    $("add-step").hidden = !open;
    $("add-step-toggle").setAttribute("aria-expanded", String(open));
    if (open) renderStepFields();
  };
  $("add-step-btn").onclick = () => { const s = readStep(); if (s) addStep(s); };
  for (const id of ["l-surge", "l-p90"]) $(id).oninput = () => paintLaunch();
  $("launch-to-rehearse").onclick = () => rehearseLaunch(false);
  $("two-agents").onclick = () => twoAgentDemo();
  $("propose-current").onclick = () => {
    if (!S.plan.steps.length) return notice("coord-notice", "Build a plan on the Rehearse page first.", "bad");
    propose({ title: planTitle(S.plan), steps: S.plan.steps }, S.planAgent === "you" ? "my-agent" : S.planAgent);
  };
  $("overlay-seg").querySelectorAll("button").forEach((b) => (b.onclick = () => {
    S.overlay = b.dataset.ov;
    $("overlay-seg").querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    paintOverlay();
  }));
  $("path-go").onclick = findPath;
  $("ask-form").onsubmit = (e) => { e.preventDefault(); const q = $("ask-input").value.trim(); if (q) askGraph(q); };
  $("cleanup").onclick = runCleanup;
  $("mem-asset").onchange = loadHistory;
  $("reset").onclick = () => resetDemo();
  $("start-tour").onclick = () => Tour.start();
  $("how-tour").onclick = () => Tour.start();
  const graphTools = (id) => {
    const wrap = $(id).parentElement;
    const tools = document.createElement("div");
    tools.className = "graph-tools";
    tools.innerHTML = `<button class="btn small icon-only" type="button" data-z="in" aria-label="Zoom in">${icon("zoom-in", 15)}</button><button class="btn small icon-only" type="button" data-z="out" aria-label="Zoom out">${icon("zoom-out", 15)}</button><button class="btn small icon-only" type="button" data-z="fit" aria-label="Fit to view">${icon("maximize", 15)}</button>`;
    wrap.appendChild(tools);
    return tools;
  };
  const mk = (page, el, opts) => {
    const g = new MVGraph($(el), opts);
    S.graphs[page] = g;
    graphTools(el).querySelectorAll("[data-z]").forEach((b) => (b.onclick = () => (b.dataset.z === "fit" ? g.fit() : g.zoom(b.dataset.z === "in" ? 1.25 : 0.8))));
    return g;
  };
  mk("rehearse", "g-rehearse", { label: "Company graph for the rehearsal", onSelect: (kind, id) => { if (kind === "asset") selectThing("asset", id); else selectThing("link", id); }, nodeTip: (name) => { const h = S.run && S.run.hits[name]; return h && S.run.n ? `<br><span>Affected in ${pct(h.n / S.run.n)} of futures so far</span>` : ""; } });
  mk("launch", "g-launch", { label: "Company graph coloured by load", onSelect: (kind, id) => kind === "asset" && selectThing("asset", id), nodeTip: (name) => { const p = S.launch && S.launch.breaking_points.find((x) => x.asset === name); return p ? `<br><span>Capacity ${p.capacity} req/s, runs out at ${p.breaks_at}× normal traffic</span>` : ""; } });
  mk("company", "g-company", { label: "Company graph", onSelect: (kind, id) => selectThing(kind, id), onBackground: () => { if (S.selected) { S.selected = null; S.graphs.company.select(null); renderInspectorHome(); paintOverlay(); } } });
}

(async function boot() {
  renderNav();
  wire();
  pipeline("init");
  resetLanes();
  renderVerdict("idle");
  if (document.fonts && document.fonts.ready) await Promise.race([document.fonts.ready, sleep(1200)]);
  try {
    await loadStatus();
    await loadWorld();
    await loadScenarios();
    await refreshInbox();
    startActivity();
    if (!location.hash) location.replace("#/");
    route();
    if (!storage.get("mv-toured")) {
      toast("New here?", "Take the two-minute tour: it runs the real engine and explains every step.", "", { label: "Start the tour", run: () => Tour.start() }, 12000);
    }
  } catch (e) {
    $("db-dot").className = "dot bad";
    $("db-line").textContent = "FalkorDB not reachable";
    notice("plan-notice", `Could not load: ${e.message}. Is FalkorDB running in Docker on port 6380? Start it, then reload this page.`, "bad");
    route();
  }
})();
