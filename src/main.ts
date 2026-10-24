import * as THREE from "three";
import { BODIES, type BodyId, bodyById } from "./bodies";
import { SystemScene } from "./gl/SystemScene";
import { PlanetView } from "./gl/PlanetView";
import { SITES } from "./gl/base/BaseLayer";
import { setAnisotropy, setUploader } from "./gl/textures";
import { mountShell } from "./ui/shell";
import { mountCredits } from "./ui/credits";
import { Sound } from "./sound";
import { clamp, easeInOutCubic, reducedMotion, smoothstep } from "./motion";

const shell = mountShell();
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
      gl_FragColor = vec4(mix(a, b, m) + vec3(1.0, 0.97, 0.92) * edge * 0.18 * (1.0 - m), 1.0);
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
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", m === "planet" ? "#ffffff" : "#000000");
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

shell.home.addEventListener("click", () => exitPlanet());
shell.info.addEventListener("click", () => {
  const on = !("info" in document.body.dataset);
  document.body.toggleAttribute("data-info", on);
  shell.info.setAttribute("aria-expanded", String(on));
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
  if (SITES.some((x) => x.id === location.pathname.split("/")[2])) {
    void planet.show(startId, { instant: true }).then(() => setTimeout(() => planet.requestDescent(), 400));
  }
} else {
  system.setView(new THREE.Vector3(), 90, true);
  system.frame(null, 17);
  setUiMode("system");
  sound.playAmbient("sun", 0.22);
}
for (const b of BODIES) planet.preload(b.id);
renderer.compile(planet.scene, planet.camera);
renderer.compile(system.scene, system.camera);

if (import.meta.env.DEV) {
  (window as any).__telos = {
    planet, system, renderer,
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

  if (now - lastDate > 1) {
    lastDate = now;
    const d = new Date();
    system.setDate(d);
    shell.systemDate.textContent = `${fmt.format(d)} UTC`;
  }

  const pr = renderer.getPixelRatio();
  const diag = Math.hypot(innerWidth, innerHeight) * pr;

  if (mode === "system") {
    system.update(dt, t, true);
    renderer.setRenderTarget(null);
    renderer.render(system.scene, system.camera);
  } else if (mode === "planet") {
    planet.update(dt, t);
    planet.render();
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
    renderer.setRenderTarget(rtB);
    renderer.render(planet.scene, planet.camera);
    renderer.setRenderTarget(null);
    renderer.render(compScene, compCam);
    if (k >= 1) {
      if (mode === "toPlanet") { mode = "planet"; planet.enterT = 1; }
      else { mode = "system"; system.locked = false; system.focus = null; system.dimOthers(null, 0); }
      delete document.body.dataset.diving;
    }
  }
}
function frame() { tick(); requestAnimationFrame(frame); }
requestAnimationFrame(frame);
