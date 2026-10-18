/* Multiverse console, build 5: the 3D hero.
   A stack of copies of the company graph (one slab = one copy, the black slab at the bottom is the
   real company). Every few seconds one copy slides out of the stack and plays "Delete orders_archive"
   with the REAL link confidences from FalkorDB: the dice decide whether each uncertain link is real,
   the failure ripples to whatever depends on the archive, the copy reports what broke, then slides
   back (clean up). It is an illustration of the engine, driven by the same world data. */
import * as THREE from "three";
import { RoomEnvironment } from "./lib/RoomEnvironment.js";
import { RoundedBoxGeometry } from "./lib/RoundedBoxGeometry.js";

const host = document.getElementById("hero-3d");
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const COL = {
  signal: new THREE.Color("#ff4a1c"), ink: new THREE.Color("#141413"), gray: new THREE.Color("#77746d"),
  paper: new THREE.Color("#f3f1ec"), white: new THREE.Color("#fbfaf7"),
};
const DEP = new Set(["CALLS", "READS", "WRITES", "USES_SECRET", "DEPENDS_ON"]);
const W = 4.4, D = 2.9, T = 0.07, GAP = 0.38, N = 7;

if (host) {
  try { init(); } catch (e) {
    console.warn("3D hero is off (no WebGL):", e);
    host.classList.add("no-3d");
    window.MVHero = { isOn: false };
    document.dispatchEvent(new CustomEvent("mv:no3d"));
  }
}

function init() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(24, 1, 0.1, 200);
  const target = new THREE.Vector3(0.35, 1.25, 0);
  const dir = new THREE.Vector3(0, 0.58, 0.82).normalize();

  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(-5, 10, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 1, far: 30 });
  key.shadow.bias = -0.0006;
  key.shadow.radius = 5;
  scene.add(key, new THREE.HemisphereLight(0xffffff, 0xb9b5ad, 0.55));
  const rim = new THREE.DirectionalLight(0xffffff, 0.8);
  rim.position.set(6, 3, -6);
  scene.add(rim);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.17 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const rig = new THREE.Group();
  const stack = new THREE.Group();
  stack.rotation.y = -0.62;
  rig.add(stack);
  scene.add(rig);

  const slabGeo = new RoundedBoxGeometry(W, T, D, 4, 0.035);
  const copyMat = new THREE.MeshPhysicalMaterial({ color: COL.paper, roughness: 0.46, clearcoat: 0.6, clearcoatRoughness: 0.4 });
  const realMat = new THREE.MeshPhysicalMaterial({ color: "#161615", roughness: 0.32, metalness: 0.25, clearcoat: 1, clearcoatRoughness: 0.2 });
  const puckGeo = new THREE.CylinderGeometry(0.072, 0.072, 0.05, 24);
  const puckMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0.08 });
  const ringGeo = new THREE.RingGeometry(0.09, 0.115, 40);
  const hotMat = new THREE.LineBasicMaterial({ color: COL.signal, transparent: true, opacity: 0 });
  const hot2Mat = hotMat.clone();

  let graph = null;          // { names, pos: Map name->[x,z], crit: Set, edges: [{from,to,conf,answered}] }
  const slabs = [];          // { group, mesh, nodes: InstancedMesh, lines, real }
  const hot = [new THREE.LineSegments(new THREE.BufferGeometry(), hotMat), new THREE.LineSegments(new THREE.BufferGeometry(), hot2Mat)];
  const goneRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: COL.ink, side: THREE.DoubleSide, transparent: true, opacity: 0 }));
  goneRing.rotation.x = -Math.PI / 2;
  const pulse = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.13, 48), new THREE.MeshBasicMaterial({ color: COL.signal, side: THREE.DoubleSide, transparent: true, opacity: 0 }));
  pulse.rotation.x = -Math.PI / 2;

  function graphFrom(world) {
    if (!world || !world.nodes || typeof layoutWorld !== "function") return fallbackGraph();
    const L = layoutWorld(world);
    const b = L.bbox;
    const pos = new Map();
    for (const n of world.nodes) {
      const p = L.P[n.name];
      if (!p) continue;
      const u = (p.x + p.w / 2 - b.x) / b.w, v = (p.y - b.y) / b.h;
      pos.set(n.name, [(u - 0.5) * (W - 0.55), (v - 0.5) * (D - 0.5)]);
    }
    return {
      names: [...pos.keys()], pos,
      crit: new Set(world.nodes.filter((n) => n.criticality === 3).map((n) => n.name)),
      edges: world.edges.filter((e) => pos.has(e.from) && pos.has(e.to)).map((e) => ({ from: e.from, to: e.to, rel: e.rel, conf: e.confidence, answered: e.answered })),
    };
  }
  function fallbackGraph() {
    const names = Array.from({ length: 18 }, (_, i) => `n${i}`);
    const pos = new Map(names.map((n, i) => [n, [((i % 6) / 5 - 0.5) * (W - 0.8), (Math.floor(i / 6) / 2 - 0.5) * (D - 0.8)]]));
    const edges = names.slice(1).map((n, i) => ({ from: n, to: names[Math.floor(i / 2)], rel: "READS", conf: 0.5 }));
    return { names, pos, crit: new Set(["n3", "n7"]), edges };
  }

  function build() {
    for (const s of slabs) { stack.remove(s.group); s.nodes.dispose(); s.lines.geometry.dispose(); }
    slabs.length = 0;
    const lineVerts = [];
    for (const e of graph.edges) {
      if (!DEP.has(e.rel) && e.rel !== "FED_BY") continue;
      const a = graph.pos.get(e.from), c = graph.pos.get(e.to);
      lineVerts.push(a[0], 0, a[1], c[0], 0, c[1]);
    }
    for (let i = 0; i < N; i++) {
      const real = i === 0;
      const group = new THREE.Group();
      group.position.y = 0.2 + i * GAP;
      const mesh = new THREE.Mesh(slabGeo, real ? realMat : copyMat);
      mesh.castShadow = true; mesh.receiveShadow = true;
      group.add(mesh);
      const nodes = new THREE.InstancedMesh(puckGeo, puckMat, graph.names.length);
      nodes.castShadow = true;
      const m = new THREE.Matrix4();
      graph.names.forEach((n, k) => {
        const [x, z] = graph.pos.get(n);
        const s = graph.crit.has(n) ? 1.25 : 1;
        m.compose(new THREE.Vector3(x, T / 2 + 0.025, z), new THREE.Quaternion(), new THREE.Vector3(s, 1, s));
        nodes.setMatrixAt(k, m);
        nodes.setColorAt(k, real ? COL.white : COL.ink);
      });
      nodes.instanceColor.needsUpdate = true;
      group.add(nodes);
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(lineVerts, 3));
      const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: real ? COL.white : COL.ink, transparent: true, opacity: real ? 0.5 : 0.38 }));
      lines.position.y = T / 2 + 0.004;
      group.add(lines);
      stack.add(group);
      slabs.push({ group, mesh, nodes, lines, real, baseY: group.position.y });
    }
    stack.position.y = 0;
  }

  /* ------------------------------------------------------------------ one future, played in one copy */
  const origin = () => (graph.pos.has("orders_archive") ? "orders_archive" : graph.names[0]);
  const isReal = (e) => (e.answered ? !!e.answered.exists : Math.random() < (e.conf ?? 1));
  let fut = null, futN = 0, critN = 0, copyIdx = 0;
  function newFuture() {
    copyIdx = copyIdx % (N - 1) + 1;
    futN++;
    const o = origin();
    const broken = new Map([[o, 0]]);
    const hops = [[], []];
    let frontier = [o];
    for (let hop = 0; hop < 2 && frontier.length; hop++) {
      const next = [];
      for (const e of graph.edges) {
        if (!DEP.has(e.rel) || !frontier.includes(e.to) || broken.has(e.from)) continue;
        if (!isReal(e)) continue;
        broken.set(e.from, hop + 1);
        hops[hop].push(e);
        next.push(e.from);
      }
      frontier = next;
    }
    const brokeNames = [...broken.keys()].filter((n) => n !== o);
    const crit = brokeNames.filter((n) => graph.crit.has(n));
    if (crit.length) critN++;
    const text = crit.length ? `${crit[0]} broke` : brokeNames.length ? `only ${brokeNames[0]} broke` : "nothing broke";
    fut = { t0: performance.now() / 1000, slab: slabs[copyIdx], o, broken, hops, crit, text, phase: 0 };
    for (let h = 0; h < 2; h++) {
      const v = [];
      for (const e of hops[h]) { const a = graph.pos.get(e.from), c = graph.pos.get(e.to); v.push(a[0], 0, a[1], c[0], 0, c[1]); }
      hot[h].geometry.dispose();
      hot[h].geometry = new THREE.BufferGeometry();
      hot[h].geometry.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
      hot[h].position.y = T / 2 + 0.006;
      hot[h].material.opacity = 0;
      fut.slab.group.add(hot[h]);
    }
    const [ox, oz] = graph.pos.get(o);
    goneRing.position.set(ox, T / 2 + 0.003, oz); goneRing.material.opacity = 0;
    pulse.position.set(ox, T / 2 + 0.004, oz); pulse.material.opacity = 0;
    fut.slab.group.add(goneRing, pulse);
    tag(`Copy ${copyIdx}`, "forked with GRAPH.COPY…");
  }
  function paintNodes(slab, fn) {
    graph.names.forEach((n, k) => slab.nodes.setColorAt(k, fn(n) || COL.ink));
    slab.nodes.instanceColor.needsUpdate = true;
  }
  function scaleNode(slab, name, s) {
    const k = graph.names.indexOf(name);
    if (k < 0) return;
    const [x, z] = graph.pos.get(name);
    const base = graph.crit.has(name) ? 1.25 : 1;
    slab.nodes.setMatrixAt(k, new THREE.Matrix4().compose(new THREE.Vector3(x, T / 2 + 0.025, z), new THREE.Quaternion(), new THREE.Vector3(base * s, Math.max(s, 0.001), base * s)));
    slab.nodes.instanceMatrix.needsUpdate = true;
  }
  const ease = (x) => 1 - Math.pow(1 - Math.min(Math.max(x, 0), 1), 3);
  function stepFuture(now) {
    if (!fut) { newFuture(); return; }
    const t = now - fut.t0, s = fut.slab;
    const out = t < 3.2 ? ease(t / 0.6) : 1 - ease((t - 3.2) / 0.55);
    s.group.position.x = out * 1.35;
    s.group.position.y = s.baseY + out * 0.06;
    if (t > 0.7 && fut.phase < 1) { fut.phase = 1; scaleNode(s, fut.o, 0.001); tag(`Copy ${copyIdx}`, "deleting orders_archive…"); }
    if (t > 0.7) {
      const pt = Math.min((t - 0.7) / 0.9, 1);
      pulse.scale.setScalar(1 + pt * 7); pulse.material.opacity = (1 - pt) * 0.9;
      goneRing.material.opacity = Math.min((t - 0.7) / 0.2, 1) * (t < 3.2 ? 1 : 1 - ease((t - 3.2) / 0.4));
    }
    if (t > 1.15 && fut.phase < 2) {
      fut.phase = 2;
      paintNodes(s, (n) => (fut.broken.get(n) === 1 ? (fut.crit.includes(n) ? COL.signal : COL.gray) : null));
      tag(`Copy ${copyIdx}`, fut.hops[0].length ? "the failure ripples…" : "nothing depends on it here…");
    }
    if (t > 1.7 && fut.phase < 3) {
      fut.phase = 3;
      paintNodes(s, (n) => (fut.broken.has(n) && n !== fut.o ? (fut.crit.includes(n) ? COL.signal : COL.gray) : null));
      tag(`Copy ${copyIdx} · future ${futN}`, `${fut.text} · ${critN} of ${futN} critical so far`, fut.crit.length > 0);
    }
    hot[0].material.opacity = t > 1.1 && t < 3.3 ? Math.min((t - 1.1) / 0.25, 1) : Math.max(0, hot[0].material.opacity - 0.08);
    hot[1].material.opacity = t > 1.65 && t < 3.3 ? Math.min((t - 1.65) / 0.25, 1) : Math.max(0, hot[1].material.opacity - 0.08);
    if (t > 3.75) {
      paintNodes(s, () => null);
      scaleNode(s, fut.o, 1);
      s.group.position.x = 0; s.group.position.y = s.baseY;
      fut = null;
    }
  }
  const tagK = document.querySelector("#hero-tag .h-tag-k"), tagT = document.getElementById("hero-tag-t"), tagEl = document.getElementById("hero-tag");
  function tag(k, t, bad = false) {
    if (tagK) tagK.textContent = k;
    if (tagT) tagT.textContent = t;
    if (tagEl) tagEl.classList.toggle("bad", bad);
  }

  /* ------------------------------------------------------------------ intro, pointer, size, loop */
  let intro0 = null;
  function intro(now) {
    if (document.body.classList.contains("intro-on")) {           // wait for the page intro to lift
      slabs.forEach((s) => (s.group.position.y = s.baseY + 3.2));
      return false;
    }
    if (intro0 == null) intro0 = now + 0.25;
    let done = true;
    slabs.forEach((s, i) => {
      const t = (now - intro0 - i * 0.09) / 0.9;
      if (t < 1) done = false;
      const k = t <= 0 ? 0 : t >= 1 ? 1 : 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);   // ease-out-back
      s.group.position.y = s.baseY + (1 - k) * 3.2;
      s.mesh.material.opacity = 1;
    });
    return done;
  }
  const pointer = { x: 0, y: 0 };
  const cell = document.getElementById("hero") || host;
  cell.addEventListener("pointermove", (e) => {
    const r = cell.getBoundingClientRect();
    pointer.x = (e.clientX - r.left) / r.width - 0.5;
    pointer.y = (e.clientY - r.top) / r.height - 0.5;
  });
  cell.addEventListener("pointerleave", () => { pointer.x = 0; pointer.y = 0; });

  function resize() {
    const r = host.getBoundingClientRect();
    if (!r.width || !r.height) return;
    renderer.setSize(r.width, r.height, false);
    camera.aspect = r.width / r.height;
    const d = Math.max(19, 23 / camera.aspect);
    camera.position.copy(target).addScaledVector(dir, d);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(host);

  let active = document.body.dataset.page === "home" || !document.body.dataset.page;
  document.addEventListener("mv:page", (e) => { active = e.detail === "home"; if (active) { resize(); loop(); } });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && active) loop(); });

  let running = false, introDone = false;
  function frame(nowMs) {
    const now = nowMs / 1000;
    if (!introDone) introDone = intro(now);
    else if (!REDUCED) stepFuture(now);
    rig.rotation.y += ((pointer.x * 0.42) - rig.rotation.y) * 0.05;
    rig.rotation.x += ((pointer.y * 0.12) - rig.rotation.x) * 0.05;
    rig.position.y = REDUCED ? 0 : Math.sin(now * 0.8) * 0.05;
    renderer.render(scene, camera);
  }
  function loop() {
    if (running) return;
    running = true;
    const tick = (ms) => {
      if (!active || document.hidden) { running = false; return; }
      frame(ms);
      if (REDUCED && introDone) { running = false; return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function setWorld(world) {
    graph = graphFrom(world);
    fut = null;
    build();
    resize();
    intro0 = null; introDone = REDUCED;
    if (REDUCED) { newFuture(); fut.t0 -= 2.2; stepFuture(performance.now() / 1000); }
    loop();
  }
  window.MVHero = { setWorld, isOn: true };
  document.addEventListener("mv:world", (e) => setWorld(e.detail));
  setWorld(window.mvWorld || null);
}
