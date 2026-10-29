import * as THREE from "three";
import { BODIES, type BodyId, bodyById } from "./bodies";
import { SystemScene } from "./gl/SystemScene";
import { PlanetView } from "./gl/PlanetView";
import { SITES } from "./gl/base/BaseLayer";
import { setAnisotropy, setUploader } from "./gl/textures";
import { PostFX } from "./gl/PostFX";
import { LINEAR_OUT } from "./gl/planetMaterial";
import { mountShell } from "./ui/shell";
import { Ruler } from "./ui/Ruler";
import { swapContent, esc } from "./ui/swap";
import { mountCredits } from "./ui/credits";
import { mountVeil } from "./ui/veil";
import { shareMoment } from "./ui/share";
import { Sound } from "./sound";
import { clamp, easeInOutCubic, reducedMotion, smoothstep } from "./motion";

const shell = mountShell();
const veil = mountVeil();
mountCredits();
const sound = new Sound();
const renderer = new THREE.WebGLRenderer({ canvas: shell.canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
setAnisotropy(Math.min(8, renderer.capabilities.getMaxAnisotropy()));
setUploader((t) => renderer.initTexture(t));

const system = new SystemScene(shell.canvas, shell.labels);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const planet = new PlanetView(shell, sound, renderer);
// every view renders linear light into one HDR buffer; PostFX blooms and tone-maps it
const post = new PostFX(renderer);
LINEAR_OUT.value = 1;



// ── composite (radial reveal between the black system and the white studio) ──
const rtOpts = { samples: 4, type: THREE.HalfFloatType } as const;
const rtA = new THREE.WebGLRenderTarget(1, 1, rtOpts);
const rtB = new THREE.WebGLRenderTarget(1, 1, rtOpts);
const compU = {
  tA: { value: rtA.texture }, tB: { value: rtB.texture },
  uCenter: { value: new THREE.Vector2() }, uRadius: { value: 0 }, uFeather: { value: 80 },
  uRes: { value: new THREE.Vector2(1, 1) },
};
const comp = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms: compU, depthTest: false, depthWrite: false,
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */ `
    varying vec2 vUv; uniform sampler2D tA; uniform sampler2D tB;
    uniform vec2 uCenter; uniform float uRadius; uniform float uFeather; uniform vec2 uRes;
    void main(){
      vec2 px = vUv * uRes;
      float d = distance(px, uCenter);
      float m = 1.0 - smoothstep(uRadius - uFeather, uRadius, d);
      vec3 a = texture2D(tA, vUv).rgb, b = texture2D(tB, vUv).rgb;
      // a thin luminous edge where the studio light meets space
      float edge = exp(-pow((d - uRadius + uFeather * 0.5) / (uFeather * 0.35), 2.0)) * step(0.001, uRadius);
      gl_FragColor = vec4(mix(a, b, m) + vec3(1.0, 0.97, 0.92) * edge * 0.04 * (1.0 - m), 1.0);
    }`,
}));
const compScene = new THREE.Scene();
compScene.add(comp);
const compCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

// ── state ───────────────────────────────────────────────────────
type Mode = "system" | "toPlanet" | "planet" | "toSystem";
let mode: Mode = "system";
let tStart = 0;
let target: BodyId = "earth";
const DIVE = 1.7, RISE = 1.4;

function setUiMode(m: "system" | "planet") {
  document.body.dataset.mode = m;
  planet.setActive(m === "planet");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", "#000000");
}

function enterPlanet(id: BodyId) {
  if (mode !== "system") return;
  target = id;
  mode = "toPlanet";
  tStart = performance.now() / 1000;
  system.locked = true;
  system.frame(id, system.radiusOf(id) * 6);
  planet.enterT = 0;
  document.body.dataset.diving = "";
  void planet.show(id, { instant: true });
  sound.whoosh(1, 1.2);
  route(`/${id}`);
}

function exitPlanet() {
  if (mode !== "planet") return;
  target = planet.current;
  mode = "toSystem";
  tStart = performance.now() / 1000;
  // start framed on the world we were looking at, then pull back
  system.setView(system.positionOf(target), system.radiusOf(target) * 6, true);
  system.frame(null, 16);
  setUiMode("system");
  document.body.dataset.diving = "";
  sound.whoosh(-1, 1.0);
  sound.playAmbient("sun", 0.22);
  route("/");
}

system.onSelect = enterPlanet;

// ── overview timeline: today, then each Earth → Mars launch window ────────────
// Stops sit mid-transfer, so landing on one shows its fleet in flight between the planets.
const windows = system.fleet.windows;
const sysStops: { date: Date; label: string; title: string; line: string; future: boolean }[] = [
  { date: new Date(), label: "Today", title: "The solar system", line: "Positions true for this moment", future: false },
  ...windows.map((w) => {
    const mid = new Date(w.launch.getTime() + 0.62 * (w.arrive.getTime() - w.launch.getTime()));
    const when = w.launch.toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
    return {
      date: mid, label: `${when} window`, future: true,
      title: w.ships ? `${w.ships.toLocaleString("en-US")} Starship${w.ships > 1 ? "s" : ""} to Mars` : "No Starships",
      line: w.note,
    };
  }),
];
const sysRuler = new Ruler(shell.sysRuler, sound);
let sysStop = -1;
function sysDateAt(p: number) {
  const i = Math.max(0, Math.min(sysStops.length - 1, Math.floor(p))), j = Math.min(sysStops.length - 1, i + 1);
  const t = p - i;
  return new Date(sysStops[i].date.getTime() + (sysStops[j].date.getTime() - sysStops[i].date.getTime()) * t);
}
let sysDate: Date | null = null;   // null = live "now"
sysRuler.onChange = (p) => {
  sysDate = p < 0.01 ? null : sysDateAt(p);
  system.setDate(sysDate ?? new Date());
  const idx = Math.round(p);
  if (idx !== sysStop) {
    sysStop = idx;
    const s = sysStops[idx];
    swapContent(shell.sysCaption, "cap", `<h1>${esc(s.label)}</h1><p><b>${esc(s.title)}</b>${esc(s.line)}${s.future ? `<span class="proj">Projected</span>` : ""}</p>`, `sys:${idx}`);
    // frame the inner system while fleets fly, the whole system at "today"
    if (!system.locked) {
      if (idx === 0) system.frame(null, 17);
      else system.setView(system.fleet.centre(idx - 1), 2.7);
    }
  }
};
sysRuler.setStops(sysStops, ["Today", String(windows[windows.length - 1].launch.getUTCFullYear())], 0, "Earth to Mars launch windows");
sysRuler.onChange(0);
{
  addEventListener("wheel", (e) => {
    if (document.body.dataset.mode !== "system" || e.ctrlKey || system.locked) return;
    const dy = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const wd = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY ?? 0;
    sysRuler.wheel(-dy, e.deltaMode === 1 || (wd !== 0 && wd % 120 === 0 && e.deltaX === 0));
  }, { passive: false });
}

shell.home.addEventListener("click", () => exitPlanet());
shell.info.addEventListener("click", () => {
  const on = !("info" in document.body.dataset);
  document.body.toggleAttribute("data-info", on);
  shell.info.setAttribute("aria-expanded", String(on));
});
shell.share.addEventListener("click", async () => {
  if (mode !== "planet" || shell.share.hasAttribute("data-busy")) return;
  shell.share.setAttribute("data-busy", "");
  sound.tick(0.7);
  tick();                         // draw a fresh frame, then read it before it's presented
  try { await shareMoment(shell.canvas, planet.moment()); } finally { shell.share.removeAttribute("data-busy"); }
});
shell.sound.addEventListener("click", () => {
  sound.setEnabled(!sound.enabled);
  shell.sound.setAttribute("aria-pressed", String(sound.enabled));
});
shell.sound.setAttribute("aria-pressed", String(sound.enabled));

addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector("dialog[open]")) return;
  if (mode === "planet") {
    if (e.key === "Escape") { exitPlanet(); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); planet.step(1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); planet.step(-1); }
    else if (e.key === "ArrowUp" || e.key === "." ) { e.preventDefault(); planet.scrub(1); }
    else if (e.key === "ArrowDown" || e.key === ",") { e.preventDefault(); planet.scrub(-1); }
  } else if (mode === "system") {
    const i = Number(e.key);
    if (i >= 1 && i <= BODIES.length) enterPlanet(BODIES[i - 1].id);
  }
});

// touch swipe between worlds (outside the ruler and the globe)
{
  let sx = 0, sy = 0, st = 0, on = false;
  shell.planetUi.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch" || (e.target as HTMLElement).closest(".ruler")) return;
    on = true; sx = e.clientX; sy = e.clientY; st = performance.now();
  });
  shell.planetUi.addEventListener("pointerup", (e) => {
    if (!on) return; on = false;
    const dx = e.clientX - sx, dy = e.clientY - sy, dt = performance.now() - st;
    if (Math.abs(dx) > Math.abs(dy) * 1.4 && (Math.abs(dx) > 60 || Math.abs(dx) / dt > 0.5)) planet.step(dx < 0 ? 1 : -1);
  });
}

// ── sizing ──────────────────────────────────────────────────────
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  const pr = renderer.getPixelRatio();
  rtA.setSize(w * pr, h * pr);
  rtB.setSize(w * pr, h * pr);
  compU.uRes.value.set(w * pr, h * pr);
  compU.uFeather.value = 90 * pr;
  system.resize(w, h);
  planet.resize(w, h);
  post.setSize(w, h, pr);
}
addEventListener("resize", resize);
resize();

// ── boot: deep link or the system overview ──────────────────────
function route(path: string) {
  if (location.pathname !== path) history.pushState(null, "", path);
  const [b, site] = path.slice(1).split("/");
  const siteName = site ? SITES.find((x) => x.id === site)?.name : null;
  document.title = path === "/" ? "Telos — the solar system, past to future" : `${siteName ? `${siteName}, ` : ""}${bodyById(b)?.name ?? ""} · Telos`;
}
planet.onNavigate = (id) => route(`/${id}`);
// moments update the address quietly (no history entry per scroll), so any view can be shared
planet.onMoment = (path, title) => {
  if (mode !== "planet") return;
  if (location.pathname !== path) history.replaceState(null, "", path);
  document.title = title;
};

function idFromLocation(): BodyId | null {
  const legacy = location.hash.replace(/^#\/?/, "");
  const id = (legacy || location.pathname.replace(/^\/+|\/+$/g, "")).split("/")[0] as BodyId;
  return bodyById(id) ? id : null;
}

// back / forward
addEventListener("popstate", () => {
  const id = idFromLocation();
  if (id) {
    if (mode === "planet") void planet.show(id);
    else if (mode === "system") enterPlanet(id);
  } else if (mode === "planet") exitPlanet();
});

const startId = idFromLocation();
if (startId) {
  if (location.hash) history.replaceState(null, "", `/${startId}`);
  target = startId;
  system.setView(new THREE.Vector3(), 16, true);
  planet.enterT = 1;
  void planet.show(startId, { instant: true });
  mode = "planet";
  setUiMode("planet");
  document.title = `${bodyById(startId)!.name} · Telos`;
  const seg = location.pathname.split("/")[2];
  if (seg && SITES.some((x) => x.id === seg)) {
    void planet.show(startId, { instant: true }).then(() => setTimeout(() => planet.requestDescent(), 400));
  } else if (seg) {
    // /earth/iss, /earth/demo-2, /moon/change-6 …: land on that moment (it opens its own view)
    void planet.show(startId, { instant: true }).then(() => {
      if (seg === "iss") setTimeout(() => planet.enterStation(), 600);
      else planet.jumpToEvent(seg);
    });
  }
} else {
  system.setView(new THREE.Vector3(), 90, true);
  setUiMode("system");
  // the fly-in starts as the veil lifts, so the first thing seen moving is the system arriving
  void veil.done.then(() => { if (mode === "system" && !system.locked) system.frame(null, 17); });
  sound.playAmbient("sun", 0.22);
}
// close-up worlds stream in after the overview is up, so they don't hold the first frame
if (startId) for (const b of BODIES) planet.preload(b.id);
else void veil.done.then(() => { for (const b of BODIES) planet.preload(b.id); });
renderer.compile(planet.scene, planet.camera);
renderer.compile(system.scene, system.camera);

if (import.meta.env.DEV) {
  (window as any).__telos = {
    planet, system, renderer, sysRuler,
    stops: () => planet.stops.map((s, i) => `${i}: ${s.headline} · ${s.title}`),
    render: (n = 3) => { for (let i = 0; i < n; i++) tick(); },
    go: async (id: BodyId, i = -1) => { if (planet.current !== id) await planet.show(id, { instant: true }); planet.debugJump(i); },
  };
}

// ── loop ────────────────────────────────────────────────────────
const fmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
let last = performance.now() / 1000;
let lastDate = 0;

function screenOf(v: THREE.Vector3, cam: THREE.Camera) {
  const p = v.clone().project(cam);
  const pr = renderer.getPixelRatio();
  return new THREE.Vector2((p.x * 0.5 + 0.5) * innerWidth * pr, (p.y * 0.5 + 0.5) * innerHeight * pr);
}

function tick() {
  const now = performance.now() / 1000;
  const dt = Math.min(0.05, now - last);
  last = now;
  const t = now;

  if (now - lastDate > 1 || sysDate) {
    lastDate = now;
    const d = sysDate ?? new Date();
    if (!sysDate) system.setDate(d);
    shell.systemDate.textContent = sysDate ? d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : `${fmt.format(d)} UTC`;
  }
  if (mode === "system") sysRuler.update(dt, now);

  const pr = renderer.getPixelRatio();
  const diag = Math.hypot(innerWidth, innerHeight) * pr;

  if (mode === "system") {
    sound.setSettlement(0, false, dt);
    system.update(dt, t, true);
    post.begin();
    renderer.render(system.scene, system.camera);
    post.present();
  } else if (mode === "planet") {
    planet.update(dt, t);
    post.present(planet.render(post.hdr));
  } else {
    const dur = mode === "toPlanet" ? DIVE : RISE;
    const k = reducedMotion() ? 1 : clamp((now - tStart) / dur, 0, 1);
    system.update(dt, t, false);
    planet.update(dt, t);
    const pos = system.positionOf(target);
    const c = screenOf(pos, system.camera);
    const camD = system.camera.position.distanceTo(pos);
    const rPlanetPx = (system.radiusOf(target) / camD) * (innerHeight * pr / 2) / Math.tan(THREE.MathUtils.degToRad(system.camera.fov / 2));
    let reveal: number;
    if (mode === "toPlanet") {
      const r = easeInOutCubic(smoothstep(0.32, 1, k));
      reveal = rPlanetPx + (diag + compU.uFeather.value - rPlanetPx) * r;
      planet.enterT = smoothstep(0.55, 1, k);
      system.dimOthers(target, smoothstep(0, 0.4, k));
      if (k > 0.8 && document.body.dataset.mode !== "planet") setUiMode("planet");
    } else {
      const r = easeInOutCubic(1 - smoothstep(0, 0.7, k));
      reveal = rPlanetPx * 0.6 + (diag + compU.uFeather.value - rPlanetPx * 0.6) * r;
      planet.enterT = 1 - smoothstep(0, 0.4, k);
      system.dimOthers(target, 1 - smoothstep(0.3, 1, k));
    }
    compU.uCenter.value.copy(c);
    compU.uRadius.value = reveal;
    renderer.setRenderTarget(rtA);
    renderer.render(system.scene, system.camera);
    compU.tB.value = planet.render(rtB);
    post.begin();
    renderer.render(compScene, compCam);
    post.present();
    if (k >= 1) {
      if (mode === "toPlanet") { mode = "planet"; planet.enterT = 1; }
      else { mode = "system"; system.locked = false; system.focus = null; system.dimOthers(null, 0); }
      delete document.body.dataset.diving;
    }
  }
}
function frame() { tick(); requestAnimationFrame(frame); }
requestAnimationFrame(frame);
