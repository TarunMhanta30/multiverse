"use strict";
/* Multiverse console, build 5: motion and the home page.
   Menu overlay, page wipe, word-by-word headings, cells that rise in order, counters, magnetic circle
   buttons, the cursor circle on the scenario carousel, pointer parallax on the home page, and the
   scenario carousel itself (a 3D stack of company copies drawn with CSS 3D, from the real graph).
   Everything respects prefers-reduced-motion. Uses globals from app.js (S, PAGES, go, pickScenario...). */
(function () {
  const RM = matchMedia("(prefers-reduced-motion: reduce)");
  const el = (id) => document.getElementById(id);

  /* ---------------------------------------------------------------- headings: one span per word */
  function splitWords(root = document) {
    root.querySelectorAll(".split:not([data-split])").forEach((h) => {
      const words = h.textContent.trim().split(/\s+/);
      h.dataset.split = "1";
      h.setAttribute("aria-label", h.textContent.trim());
      h.innerHTML = words.map((w, i) => `<span class="w" aria-hidden="true"><span style="--wi:${i}">${escapeHtml(w)}</span></span>`).join(" ");
    });
  }
  function indexCells() {
    document.querySelectorAll(".page").forEach((p) => p.querySelectorAll(".rv").forEach((c, i) => c.style.setProperty("--i", i)));
  }

  /* ---------------------------------------------------------------- menu overlay */
  const menu = el("menu"), btn = el("menu-btn");
  function openMenu(open) {
    if (!menu || !btn) return;
    btn.setAttribute("aria-expanded", String(open));
    btn.querySelector(".menu-word").textContent = open ? "Close" : "Menu";
    if (open) {
      menu.hidden = false;
      menu.classList.remove("open"); void menu.offsetWidth; menu.classList.add("open");
      setTimeout(() => menu.querySelector("a")?.focus({ preventScroll: true }), 80);
    } else {
      menu.hidden = true;
      menu.classList.remove("open");
    }
  }
  btn && (btn.onclick = () => openMenu(btn.getAttribute("aria-expanded") !== "true"));
  menu && menu.addEventListener("click", (e) => { if (e.target.closest("a") || e.target.closest("button")) setTimeout(() => openMenu(false), 10); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && menu && !menu.hidden) openMenu(false); });

  /* ---------------------------------------------------------------- page changes */
  let firstPage = true;
  document.addEventListener("mv:page", (e) => {
    openMenu(false);
    const wipe = el("wipe");
    if (!firstPage && wipe && !RM.matches) {
      document.body.classList.add("wiping");
      wipe.classList.remove("go"); void wipe.offsetWidth; wipe.classList.add("go");
    }
    firstPage = false;
    requestAnimationFrame(() => { runCounters(); if (e.detail === "home") Carousel.start(); else Carousel.stop(); });
  });
  el("wipe")?.addEventListener("animationend", () => el("wipe").classList.remove("go"));

  /* ---------------------------------------------------------------- counters */
  function runCounters() {
    document.querySelectorAll(".page.active .h-num[data-count]").forEach((n) => {
      const to = Number(n.dataset.count);
      if (!isFinite(to)) return;
      if (RM.matches) { n.textContent = to; return; }
      const t0 = performance.now(), dur = 1100;
      const tick = (now) => {
        const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
        n.textContent = Math.round(to * e);
        if (k < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }
  document.addEventListener("mv:world", () => requestAnimationFrame(runCounters));

  /* ---------------------------------------------------------------- pointer: magnetic, hero, cursor */
  let px = -1, py = -1, raf = 0;
  addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    px = e.clientX; py = e.clientY;
    if (!raf) raf = requestAnimationFrame(onPointer);
  }, { passive: true });
  function onPointer() {
    raf = 0;
    if (RM.matches) return;
    document.querySelectorAll(".page.active .magnetic").forEach((m) => {
      const r = m.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2, dx = px - cx, dy = py - cy;
      const near = Math.hypot(dx, dy) < r.width * 0.95;
      m.style.transform = near ? `translate(${dx * 0.3}px, ${dy * 0.3}px)` : "";
    });
    const hero = el("hero");
    if (hero && document.body.dataset.page === "home") {
      const r = hero.getBoundingClientRect();
      const inside = px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;
      const cta = el("hero-cta"), giant = hero.querySelector(".h-giant");
      if (inside) {
        const nx = (px - r.left) / r.width - 0.5, ny = (py - r.top) / r.height - 0.5;
        giant && (giant.style.setProperty("--gx", `${-nx * 26}px`), giant.style.setProperty("--gy", `${-ny * 16}px`));
        if (cta) {
          const c = cta.getBoundingClientRect();
          const restX = c.left + c.width / 2 - (parseFloat(cta.style.getPropertyValue("--cx")) || 0);
          const restY = c.top + c.height / 2 - (parseFloat(cta.style.getPropertyValue("--cy")) || 0);
          const dx = Math.max(-220, Math.min(220, (px - restX) * 0.45)), dy = Math.max(-160, Math.min(160, (py - restY) * 0.45));
          cta.style.setProperty("--cx", `${dx}px`); cta.style.setProperty("--cy", `${dy}px`);
        }
      } else {
        giant && (giant.style.setProperty("--gx", "0px"), giant.style.setProperty("--gy", "0px"));
        cta && (cta.style.setProperty("--cx", "0px"), cta.style.setProperty("--cy", "0px"));
      }
    }
    const cur = el("cursor");
    if (cur) {
      const over = document.elementFromPoint(px, py)?.closest("[data-cursor]");
      cur.style.setProperty("--mx", `${px}px`); cur.style.setProperty("--my", `${py}px`);
      cur.classList.toggle("on", !!over);
      if (over) el("cursor-t").textContent = over.dataset.cursor;
    }
    const st = el("car-stage");
    if (st && document.body.dataset.page === "home") {
      const r = st.getBoundingClientRect();
      const inside = px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;
      const k = st.querySelector(".ca-stack");
      if (k) {
        k.style.setProperty("--tx", inside ? `${((px - r.left) / r.width - 0.5) * 16}deg` : "0deg");
        k.style.setProperty("--ty", inside ? `${((py - r.top) / r.height - 0.5) * -10}deg` : "0deg");
      }
    }
  }
  document.addEventListener("pointerleave", () => document.querySelectorAll(".magnetic").forEach((m) => (m.style.transform = "")));

  /* ---------------------------------------------------------------- the scenario carousel (home) */
  const Carousel = {
    i: 0, timer: null,
    list() { return (typeof S !== "undefined" && S.scenarios) || []; },
    start() { this.render(false); this.stop(); if (!RM.matches) this.timer = setInterval(() => { if (!this.hover) this.move(1); }, 5200); },
    stop() { clearInterval(this.timer); this.timer = null; },
    move(d) { const n = this.list().length; if (!n) return; this.i = (this.i + d + n) % n; this.render(true); },
    open() {
      const p = this.list()[this.i];
      if (!p) return;
      pickScenario(p.id);
      go("rehearse");
    },
    render(animate) {
      const L = this.list(), p = L[this.i], art = el("car-art");
      if (!p || !art) return;
      el("car-k").textContent = `Scenario ${this.i + 1} of ${L.length}`;
      el("car-title").textContent = typeof shortTitle === "function" ? shortTitle(p) : p.title;
      art.innerHTML = stackSVG(p.plan);
      if (animate && !RM.matches) { art.classList.remove("enter"); void art.offsetWidth; art.classList.add("enter"); }
    },
  };
  function stackSVG(plan) {
    if (typeof S === "undefined" || !S.world || typeof layoutWorld !== "function") return "";
    const Lw = layoutWorld(S.world), b = Lw.bbox;
    const W = 300, H = 210, pad = 16;
    const pos = {};
    for (const n of S.world.nodes) {
      const q = Lw.P[n.name];
      if (q) pos[n.name] = [pad + ((q.x + q.w / 2 - b.x) / b.w) * (W - 2 * pad), pad + ((q.y - b.y) / b.h) * (H - 2 * pad)];
    }
    const origins = new Set();
    for (const s of plan.steps || []) {
      if (s.asset) origins.add(s.asset);
      if (s.action === "launch" && S.world.meta) origins.add(S.world.meta.traffic_entry);
    }
    let reach = [];
    try { reach = typeof blastRadius === "function" ? blastRadius(plan) : []; } catch (_) { reach = []; }
    const hit = new Set(reach.filter((n) => !origins.has(n)));
    const crit = (n) => { const x = S.world.nodes.find((m) => m.name === n); return x && x.criticality === 3; };
    const edges = S.world.edges.filter((e) => pos[e.from] && pos[e.to]).map((e) => {
      const hot = (hit.has(e.from) || origins.has(e.from)) && (hit.has(e.to) || origins.has(e.to));
      const [x1, y1] = pos[e.from], [x2, y2] = pos[e.to];
      return `<line class="ca-e${hot ? " hot" : ""}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
    }).join("");
    const nodes = Object.entries(pos).map(([n, [x, y]]) => {
      const cls = origins.has(n) ? "o" : hit.has(n) ? (crit(n) ? "c" : "m") : "";
      const r = origins.has(n) || hit.has(n) ? 6.5 : crit(n) ? 4.6 : 3.6;
      return `<circle class="ca-n ${cls}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}"><title>${escapeHtml(n)}</title></circle>`;
    }).join("");
    const plate = (cls, inner) => `<svg class="ca-p ${cls}" viewBox="0 0 ${W} ${H}" aria-hidden="true"><rect class="ca-plate" x="1" y="1" width="${W - 2}" height="${H - 2}"/>${inner}</svg>`;
    const ghost = `${edges.replace(/ hot/g, "")}${Object.values(pos).map(([x, y]) => `<circle class="ca-n" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3"/>`).join("")}`;
    return `<div class="ca-stack">${plate("p4", ghost)}${plate("p3", ghost)}${plate("p2", ghost)}${plate("p1", edges + nodes)}</div>`;
  }
  el("car-prev") && (el("car-prev").onclick = () => Carousel.move(-1));
  el("car-next") && (el("car-next").onclick = () => Carousel.move(1));
  el("car-open") && (el("car-open").onclick = () => Carousel.open());
  const stage = el("car-stage");
  if (stage) {
    stage.dataset.cursor = "Open";
    stage.onclick = () => Carousel.open();
    stage.addEventListener("pointerenter", () => (Carousel.hover = true));
    stage.addEventListener("pointerleave", () => (Carousel.hover = false));
  }
  document.addEventListener("mv:world", () => { if (document.body.dataset.page === "home") Carousel.render(false); });
  el("home-tour") && (el("home-tour").onclick = () => Tour.start());

  /* no WebGL: the hero shows the same stack of copies, drawn with CSS 3D */
  function heroFallback() {
    const h = el("hero-3d");
    if (!h || !h.classList.contains("no-3d") || typeof S === "undefined" || !S.world || !S.scenarios.length) return false;
    h.innerHTML = `<div class="car-art hero-art">${stackSVG(S.scenarios[0].plan)}</div>`;
    const k = document.querySelector("#hero-tag .h-tag-k"), t = el("hero-tag-t");
    if (k) k.textContent = "25 copies";
    if (t) t.textContent = "each plate is one copy of the company";
    return true;
  }
  document.addEventListener("mv:no3d", () => { if (!heroFallback()) document.addEventListener("mv:world", heroFallback, { once: true }); });
  document.addEventListener("mv:world", heroFallback);

  /* ---------------------------------------------------------------- first-visit intro */
  function intro() {
    const box = el("intro");
    if (!box || box.hidden) return;                    // decided by the inline script in index.html
    try { sessionStorage.setItem("mv-intro", "1"); } catch (_) { /* private window */ }
    const t0 = performance.now(), dur = 1050, cnt = el("intro-count"), bar = el("intro-bar");
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 2.4);
      cnt.textContent = Math.round(e * 100);
      bar.style.transform = `scaleX(${e})`;
      if (k < 1) return requestAnimationFrame(tick);
      document.body.classList.remove("intro-on");
      box.classList.add("lift");
      setTimeout(() => { box.hidden = true; }, 950);
      setTimeout(() => document.body.classList.remove("intro-delay"), 4200);
    };
    requestAnimationFrame(tick);
  }

  /* ---------------------------------------------------------------- boot */
  intro();
  splitWords();
  indexCells();
  if (typeof hydrateIcons === "function") hydrateIcons();
  const waitScenarios = setInterval(() => {
    if (Carousel.list().length && typeof S !== "undefined" && S.world) {
      clearInterval(waitScenarios);
      if (document.body.dataset.page === "home") Carousel.start();
      heroFallback();
      runCounters();
    }
  }, 150);
  setTimeout(() => clearInterval(waitScenarios), 20000);
  window.MVMotion = { splitWords, Carousel };
})();
