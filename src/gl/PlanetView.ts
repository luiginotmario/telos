import * as THREE from "three";
import { BODIES, type BodyId, bodyIndex } from "../bodies";
import { type BodyData, type Era, type HumansData, type Site, TODAY_YEAR, formatShortAgo, loadBody, loadHumans } from "../data";
import { type Stop, buildStops, eraAt, visualAt } from "../timeline";
import { Globe, latLonToDir } from "./Globe";
import { BaseLayer, SITES } from "./base/BaseLayer";
import { OrbitLayer } from "./orbits/OrbitLayer";
import { StationView, type StationScene } from "./orbits/StationView";
import { Specimen } from "../ui/Specimen";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import type { N8AOPass } from "n8ao";
import type { BokehPass } from "three/examples/jsm/postprocessing/BokehPass.js";
import { LINEAR_OUT } from "./planetMaterial";
import { Sky } from "./Sky";
import { Ruler } from "../ui/Ruler";
import { esc, swapContent } from "../ui/swap";
import type { Shell } from "../ui/shell";
import type { Sound } from "../sound";
import { Spring, SPRING_FOLLOW, clamp, expoOut, follow, reducedMotion } from "../motion";

const FOV = 30;
const SPECIMENS_ENABLED = true;
// the Sun from the left and slightly behind: a lit crescent-to-gibbous face with a visible terminator
const LIGHT = new THREE.Vector3(-0.72, 0.24, 0.65).normalize();

interface Loaded { data: BodyData | null; humans: HumansData | null; stops: Stop[] }
interface PinEl { el: HTMLElement; site: Site; year: number; dir: THREE.Vector3 }

/** A circular orbit's position in the globe frame (Earth radii): for planned stations. */
function circular(ms: number, altKm: number, incDeg: number, phase: number, gmst: number) {
  const a = 1 + altKm / 6371;
  const n = Math.sqrt(398600.4418 / (a * 6371) ** 3);          // rad/s
  const u = phase + n * (ms / 1000);
  const i = THREE.MathUtils.degToRad(incDeg), raan = phase * 2.3;
  const x = a * (Math.cos(raan) * Math.cos(u) - Math.sin(raan) * Math.sin(u) * Math.cos(i));
  const y = a * (Math.sin(raan) * Math.cos(u) + Math.cos(raan) * Math.sin(u) * Math.cos(i));
  const z = a * Math.sin(u) * Math.sin(i);
  const cg = Math.cos(gmst), sg = Math.sin(gmst);
  const ex = cg * x + sg * y, ey = -sg * x + cg * y;
  return new THREE.Vector3(ex, z, -ey);
}

export class PlanetView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
  private globes = new Map<BodyId, Globe>();
  private loaded = new Map<BodyId, Promise<Loaded>>();
  current: BodyId = "earth";
  private cur?: Loaded;
  private ruler: Ruler;
  private pins: PinEl[] = [];
  private stopIdx = -1;

  // layout
  private cx = 0; private cy = 0; private rPx = 160;
  private camDist = 10;
  private zoom = new Spring(1, SPRING_FOLLOW);
  private zoomGoal = 1;

  // globe rotation (yaw spins about the axis, pitch tips toward the viewer)
  private yaw = new Spring(0, { stiffness: 60, damping: 16 });
  private yawVel = 0.11;         // idle drift, rad/s
  private pitch = new Spring(0.12, { stiffness: 120, damping: 22 });
  private drag: { id: number; x: number; y: number; t: number; vx: number } | null = null;
  private scrubSpin = 0;

  // worlds sit on one track; a single spring moves along it (interruptible, no fades)
  private track = new Spring(bodyIndex("earth"), { stiffness: 150, damping: 25, mass: 1 });
  private spacing = 4;
  onNavigate: (id: BodyId) => void = () => {};
  enterT = 1;          // 0..1 entrance (driven by main during the dive)

  // studio light for the miniature base (the globes light themselves in their shader)
  private sun = new THREE.DirectionalLight(0xfff4ea, 2.6);
  private sky = new Sky(LINEAR_OUT);
  private bases = new Map<BodyId, BaseLayer>();
  /** Earth's satellites, stations and debris (only Earth has one) */
  orbits: OrbitLayer | null = null;
  /** the ISS close up, entered from its label or from station moments on the timeline */
  readonly station = new StationView();
  private stationCam = new THREE.PerspectiveCamera(FOV, 1, 1e-6, 10);
  private stationNear = false;
  private autoStation: string | null = null;
  private orbLabels = new Map<string, HTMLElement>();
  private get base() { return this.bases.get(this.current) ?? null; }
  private focusAim = false;
  private autoSurface = false;     // the timeline put us over the surface
  private userZoomed = false;
  private noteFor = "";
  private focusPt = new THREE.Vector3();
  private focusGoal = new THREE.Vector3();      // the user took the zoom over; stop auto-framing
  private orbitAz = 0;
  private tiltAdj = 0;
  private builtTo2031 = false;

  private composer: EffectComposer | null = null;
  private ao: N8AOPass | null = null;
  private bokeh: BokehPass | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private camTarget = new THREE.Vector3();
  // butterscotch dust haze (sRGB #d8b796); globes take it in display space, materials in linear
  private hazeColor = new THREE.Color().setStyle("#d8b796");
  private hazeSRGB = new THREE.Color(0xd8b796 >> 16 & 255, 0xd8b796 >> 8 & 255, 0xd8b796 & 255).multiplyScalar(1 / 255);

  constructor(private shell: Shell, private sound: Sound, renderer?: THREE.WebGLRenderer) {
    this.renderer = renderer ?? null;
    try { if (localStorage.getItem("telos:hinted")) document.body.setAttribute("data-hinted", ""); } catch { /* ignore */ }
    this.scene.background = new THREE.Color(0, 0, 0);
    this.scene.fog = this.fog;
    this.station.onExit = () => this.leaveStation();
    addEventListener("keydown", (e) => { if (e.key === "Escape" && this.station.active) this.leaveStation(); });
    this.scene.add(this.sky.group);
    this.sun.position.copy(LIGHT).multiplyScalar(5);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.00015;
    this.sun.shadow.normalBias = 0.0004;
    this.sun.shadow.radius = 4;
    this.scene.add(this.sun, this.sun.target, new THREE.HemisphereLight(0xe9eef8, 0x6a5444, 0.9));
    if (renderer) {
      const pm = new THREE.PMREMGenerator(renderer);
      this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
      this.scene.environmentIntensity = 0.4;
      pm.dispose();
    }
    this.ruler = new Ruler(shell.ruler, sound);
    this.ruler.onChange = (p) => this.applyTime(p);
    this.ruler.onSettle = () => {};
    this.buildNav();
    this.bindGlobeInput();
  }

  private buildNav() {
    const nav = this.shell.worlds;
    nav.innerHTML = BODIES.map((b) => `<button data-id="${b.id}">${b.name}</button>`).join("");
    nav.addEventListener("click", (e) => {
      const id = (e.target as HTMLElement).closest("button")?.dataset.id as BodyId | undefined;
      if (id && id !== this.current) { void this.show(id); this.onNavigate(id); }
    });
  }

  globe(id: BodyId) {
    let g = this.globes.get(id);
    if (!g) {
      g = new Globe(BODIES[bodyIndex(id)], { dark: true, segments: 160 });
      g.u.uLightDir.value.copy(LIGHT);
      g.u.uGain.value = 1.22;
      // always blended, so fading never flips material state (no program re-acquire mid-motion)
      (g.mesh.material as THREE.ShaderMaterial).transparent = true;
      this.scene.add(g.root);
      this.globes.set(id, g);
      void g.load("2k");
      const site = SITES.find((x) => x.body === id);
      if (site) this.bases.set(id, new BaseLayer(g, site, this.sound));
      if (id === "earth") this.orbits = new OrbitLayer(g);
    }
    return g;
  }

  private load(id: BodyId) {
    let p = this.loaded.get(id);
    if (!p) {
      p = (async () => {
        const [data, humans] = await Promise.all([loadBody(id), id === "earth" ? loadHumans() : Promise.resolve(null)]);
        const stops = data ? buildStops(data, humans) : [];
        return { data, humans, stops };
      })();
      this.loaded.set(id, p);
    }
    return p;
  }

  preload(id: BodyId) { this.globe(id); void this.load(id); }

  /** Switch to a world. Without `from`, it's the first entrance (no slide). */
  async show(id: BodyId, opts: { instant?: boolean } = {}) {
    const prev = this.current;
    const first = !this.cur;
    this.current = id;
    for (const b of this.shell.worlds.querySelectorAll("button")) {
      const on = b.dataset.id === id;
      b.setAttribute("aria-current", String(on));
      if (on && this.shell.worlds.scrollWidth > this.shell.worlds.clientWidth) b.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
    }
    const g = this.globe(id);
    this.sound.playAmbient(id);
    const to = bodyIndex(id);
    if (first || opts.instant || reducedMotion()) this.track.snap(to);
    else if (prev !== id) {
      const dir = to > bodyIndex(prev) ? 1 : -1;
      this.track.target = to;
      this.sound.whoosh(dir as 1 | -1, 0.7);
    }
    this.zoomGoal = 1;
    this.focusAim = false;
    this.autoSurface = false;
    if (id !== "earth") this.specimen.close();
    const L = await this.load(id);
    if (this.current !== id) return;
    // fetch the close-up maps while you look, so zooming in never waits on them (desktop only)
    if (!matchMedia("(pointer: coarse)").matches) setTimeout(() => { if (this.current === id) void g.load("4k"); }, 1200);
    // compile the city and the surface post-processing ahead of the first dive
    if (this.bases.has(id)) setTimeout(() => { if (this.current === id) void this.warmSurface(id); }, 1600);
    // and the ISS, ahead of the first fly-in
    if (id === "earth" && this.renderer) setTimeout(() => { if (this.current === id) void this.station.warm(this.renderer!); }, 2400);
    this.cur = L;
    this.stopIdx = -1;
    const stops = L.stops;
    let at = stops.findIndex((s) => Math.abs(s.year - TODAY_YEAR) < 1);
    if (at < 0) at = stops.reduce((bi, s, i) => (Math.abs(s.year - TODAY_YEAR) < Math.abs(stops[bi].year - TODAY_YEAR) ? i : bi), 0);
    const first0 = stops[0], last = stops[stops.length - 1];
    this.ruler.setStops(stops, [first0 ? formatShortAgo(first0.year) : "", last ? (last.year > TODAY_YEAR + 0.5 ? formatShortAgo(last.year) : "Today") : ""], Math.max(0, at), `${g.def.name} timeline`, !first && !opts.instant);
    this.buildPins(L);
    this.setPeople(null);
    this.applyTime(Math.max(0, at));
    this.updateAudioCredit(id);
  }

  private buildPins(L: Loaded) {
    for (const p of this.pins) p.el.remove();
    this.pins = [];
    if (!L.data) return;
    const seen = new Set<string>();
    for (const ev of L.data.events) for (const s of ev.sites ?? []) {
      const key = `${s.name}@${s.lat.toFixed(2)},${s.lon.toFixed(2)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const el = document.createElement("div");
      el.className = "pin";
      el.dataset.status = s.status;
      el.tabIndex = -1;
      el.innerHTML = `<i></i><span>${esc(s.name)}</span>`;
      const dive = this.diveTargets.find((d) => Math.abs(d.lat - s.lat) < 0.05 && Math.abs(d.lon - s.lon) < 0.05);
      if (dive) {
        el.dataset.dive = "";
        el.addEventListener("click", () => this.requestDescent(dive));
      }
      this.shell.labels.appendChild(el);
      this.pins.push({ el, site: s, year: ev.year, dir: latLonToDir(s.lat, s.lon) });
    }
  }

  private applyTime(p: number) {
    const L = this.cur;
    if (!L || !L.stops.length) return;
    const stops = L.stops;
    const g = this.globe(this.current);
    g.setVisual(visualAt(stops, p));
    // continuous year (log-time) for paleogeography and pins
    const i = Math.floor(clamp(p, 0, stops.length - 1)), j = Math.min(stops.length - 1, i + 1);
    const yr = interpYear(stops[i].year, stops[j].year, p - i);
    g.setYear(yr);
    this.year = yr;
    this.updateGlows(yr);
    const idx = Math.round(clamp(p, 0, stops.length - 1));
    if (idx !== this.stopIdx) {
      const dir = idx > this.stopIdx ? 1 : -1;
      this.stopIdx = idx;
      this.renderStop(idx);
      if (!this.moving) this.scrubSpin += 0.12 * dir;
    }
  }

  private updateGlows(year: number) {
    const g = this.globe(this.current);
    const list: (Site & { glow: number })[] = [];
    for (const p of this.pins) {
      const age = year - p.year;
      const on = age >= 0;
      p.el.toggleAttribute("data-off", !on);
      (p as any).on = on;
      if (!on) continue;
      const k = p.site.kind;
      const base = k === "city" ? 1 : k === "base" ? 0.45 : 0;
      if (base > 0) list.push({ ...p.site, glow: base * clamp(age / Math.max(1, Math.abs(year) * 0.002), 0.25, 1) });
    }
    g.setGlows(list);
  }

  private renderStop(idx: number) {
    const L = this.cur!;
    const s = L.stops[idx];
    const ev = s.event;
    const name = this.globe(this.current).def.name;
    const sub = ev
      ? `<b>${esc(s.title)}</b>${esc(s.line)}${ev.kind === "projected" ? `<span class="proj">Projected</span>` : ""}`
      : `<b>${esc(s.title)}</b>${esc(s.line)}`;
    const headline = Math.abs(s.year - TODAY_YEAR) < 1 && ev ? "Today" : s.headline;
    const line2 = Math.abs(s.year - TODAY_YEAR) < 1 && ev ? `<b>${esc(name)}</b>${esc(L.data?.tagline ?? ev.line)}` : sub;
    swapContent(this.shell.caption, "cap", `<h1>${esc(headline)}</h1><p>${line2}</p>`, `${this.current}:${idx}`);

    // story (left)
    const evNear = ev ?? nearestEvent(L.stops, idx);
    if (evNear) {
      const conf = evNear.confidence === "debated" ? " · Debated" : evNear.confidence === "projection" ? " · Projection" : "";
      const by = evNear.projected_by ? `<p class="by">Projected by ${esc(evNear.projected_by)}</p>` : "";
      const src = (evNear.sources ?? []).slice(0, 4).map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(shortTitle(x.title))}</a>`).join("");
      swapContent(this.shell.story, "blk", `<p class="eyebrow">${esc(name)}${conf}</p><p>${esc(evNear.detail)}</p>${by}<div class="src">${src}</div>`, `${this.current}:${evNear.id}`);
    } else {
      this.shell.story.replaceChildren();
    }

    // who lived on Earth: labels placed on the globe where each people lived
    this.setPeople(eraAt(L.stops, L.humans, idx));
  }

  private people: { el: HTMLElement; dir: THREE.Vector3; x: number; y: number; on: boolean }[] = [];
  private specimen = new Specimen();
  private peopleKey = "";
  private setPeople(era: Era | null) {
    const key = era ? String(era.year) : "";
    if (key === this.peopleKey) return;
    this.peopleKey = key;
    for (const p of this.people) { const el = p.el; el.dataset.state = "leave"; setTimeout(() => el.remove(), 260); }
    this.people = [];
    if (!era) return;
    // early-human labels open the reconstruction beside a modern human
    if (SPECIMENS_ENABLED) void this.specimen.load().then(() => {
      if (this.peopleKey !== key) return;
      for (const p of this.people) {
        const k = this.specimen.keyFor(p.el.dataset.name ?? "", era.year);
        if (k) { p.el.dataset.key = k; p.el.setAttribute("role", "button"); p.el.tabIndex = 0; }
      }
    });
    era.peoples.slice(0, 8).forEach((pp, i) => {
      const el = document.createElement("div");
      el.className = "people";
      el.dataset.state = "enter";
      el.dataset.name = pp.name;
      el.style.transitionDelay = `${60 + i * 45}ms`;
      el.innerHTML = `<i></i><span>${esc(pp.name)}</span>`;
      const open = () => { const k = el.dataset.key; if (k) void this.specimen.open(k, era.label); };
      el.addEventListener("click", open);
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
      this.shell.labels.appendChild(el);
      void el.offsetWidth;
      delete el.dataset.state;
      this.people.push({ el, dir: latLonToDir(pp.lat, pp.lon), x: 0, y: 0, on: false });
    });
  }

  private updateAudioCredit(id: BodyId) {
    void fetch("/audio/credits.json").then((r) => (r.ok ? r.json() : null)).then((c) => {
      const line = c?.[id];
      this.shell.audioCredit.textContent = line ? `Listening to ${line}` : "";
    }).catch(() => {});
  }

  // ── input on the globe ────────────────────────────────────────

  private bindGlobeInput() {
    const c = this.shell.canvas;
    c.addEventListener("pointerdown", (e) => {
      if (document.body.dataset.mode !== "planet" || document.body.dataset.view || this.drag) return;
      if (this.station.active) {
        if ((e.target as HTMLElement).closest?.(".ruler, button")) return;
        this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), vx: 0 };
        c.setPointerCapture(e.pointerId);
        c.style.cursor = "grabbing";
        return;
      }
      if (this.focusK < 0.3 && !this.hitGlobe(e.clientX, e.clientY)) return;
      if ((e.target as HTMLElement).closest?.(".ruler, button")) return;
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), vx: 0 };
      c.setPointerCapture(e.pointerId);
      c.style.cursor = "grabbing";
    });
    c.addEventListener("pointermove", (e) => {
      if (document.body.dataset.mode !== "planet" || document.body.dataset.view) return;
      if (!this.drag) { c.style.cursor = this.hitGlobe(e.clientX, e.clientY) ? "grab" : ""; return; }
      if (e.pointerId !== this.drag.id) return;
      const now = performance.now();
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      if (this.station.active) {
        const st = this.station;
        st.yaw.target += dx * 0.006; st.yaw.x += dx * 0.006;
        st.pitch.target = clamp(st.pitch.target + dy * 0.005, -1.35, 1.35); st.pitch.x = st.pitch.target;
        this.drag.x = e.clientX; this.drag.y = e.clientY; this.drag.t = now;
        return;
      }
      const k = 1 / (this.rPx * this.zoom.x);
      if (this.focusK > 0.3) {
        this.orbitAz -= dx * 0.006;
        this.tiltAdj = clamp(this.tiltAdj - dy * 0.004, -0.6, 0.35);
        this.drag.x = e.clientX; this.drag.y = e.clientY; this.drag.t = now;
        return;
      }
      this.yaw.target += dx * k; this.yaw.x += dx * k;
      this.pitch.target = clamp(this.pitch.target + dy * k, -1.2, 1.2);
      const dtm = Math.max(1, now - this.drag.t);
      this.drag.vx = this.drag.vx * 0.6 + (dx * k / (dtm / 1000)) * 0.4;
      this.drag.x = e.clientX; this.drag.y = e.clientY; this.drag.t = now;
    });
    const end = (e: PointerEvent) => {
      if (!this.drag || e.pointerId !== this.drag.id) return;
      // hand the flick velocity to the drift; it decays back to idle speed
      if (this.focusK <= 0.3) this.yawVel = clamp(this.drag.vx, -6, 6);
      this.drag = null;
      c.style.cursor = "";
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    // pinch to zoom (touch)
    let pd0 = 0, pz0 = 1;
    c.addEventListener("touchmove", (e) => {
      if (document.body.dataset.mode !== "planet" || e.touches.length !== 2) return;
      const dd = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      if (!pd0) { pd0 = dd; pz0 = this.zoomGoal; this.drag = null; }
      const next = clamp(pz0 * dd / pd0, 1, this.maxZoom);
      if (this.base && next > 1.8 && !this.focusAim) this.aimAt(this.base.lat, this.base.lon);
      if (next < 1.6 && this.focusAim) this.focusAim = false;
      this.userZoomed = true;
      this.zoomGoal = next;
    }, { passive: true });
    c.addEventListener("touchend", () => { pd0 = 0; });
    // Scroll is the timeline: up moves forward (right), down moves back. Pinch / ctrl-scroll
    // zooms, a horizontal swipe changes world. Works anywhere on the page, not just the globe.
    addEventListener("wheel", (e) => {
      if (document.body.dataset.mode !== "planet" || document.querySelector("dialog[open]")) return;
      e.preventDefault();
      if (e.ctrlKey && this.station.active) {
        // pinch in the close-up: closer to the station; far enough out returns to the globe
        const st = this.station;
        st.dist.target = clamp(st.dist.target * Math.exp(e.deltaY * 0.01), 22, 1200);
        if (st.dist.target >= 1200) this.leaveStation();
        return;
      }
      if (e.ctrlKey) {
        const next = clamp(this.zoomGoal * Math.exp(-e.deltaY * 0.01), 1, this.maxZoom);
        if (this.base && next > 1.8 && !this.focusAim && e.deltaY < 0) this.aimAt(this.base.lat, this.base.lon);
        if (next < 1.6 && this.focusAim) this.focusAim = false;
        this.userZoomed = true;
        this.zoomGoal = next;
        if (this.zoomGoal > 1.4) void this.globe(this.current).load("4k");
        return;
      }
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.5 && Math.abs(e.deltaX) > 4) {
        this.swipeAcc += e.deltaX;
        if (Math.abs(this.swipeAcc) > 90 && performance.now() - this.lastSwipe > 700) {
          this.step(this.swipeAcc > 0 ? 1 : -1);
          this.swipeAcc = 0; this.lastSwipe = performance.now();
        }
        return;
      }
      // line/page deltas (mouse wheels on some systems) → pixels
      const dy = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      // a physical wheel reports whole notches (line mode, or ±120 legacy units); trackpads don't
      const wd = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY ?? 0;
      const notch = e.deltaMode === 1 || (wd !== 0 && wd % 120 === 0 && e.deltaX === 0);
      this.ruler.wheel(-dy, notch);
      if (!document.body.hasAttribute("data-hinted")) {
        document.body.setAttribute("data-hinted", "");
        try { localStorage.setItem("telos:hinted", "1"); } catch { /* ignore */ }
      }
    }, { passive: false });
  }
  private moving = false;
  /** Continuous year under the ruler (log-time interpolated between stops). */
  year = TODAY_YEAR;

  /** Glide the ruler to the first stop at or after `y` (no-op if already later). */
  scrubToYear(y: number) {
    const stops = this.cur?.stops;
    if (!stops || this.year >= y) return;
    const i = stops.findIndex((s) => s.year >= y);
    if (i >= 0) this.ruler.goTo(i);
  }
  /** Surface points you can zoom into (pins pulse). */
  diveTargets: { lat: number; lon: number }[] = SITES.map((x) => ({ lat: x.lat, lon: x.lon }));
  private get maxZoom() { return this.base ? 48 : 2.6; }

  /** Turn the globe so the base faces the camera (spin ψ, then pitch θ). */
  private aimAt(lat: number, lon: number) {
    const g = this.globe(this.current);
    const d = latLonToDir(lat, lon);
    const tiltQ = g.tilt.quaternion;
    let best = 0, bestZ = -2;
    const v = new THREE.Vector3();
    for (let i = 0; i < 720; i++) {
      const psi = (i / 720) * Math.PI * 2;
      v.copy(d).applyAxisAngle(new THREE.Vector3(0, 1, 0), psi).applyQuaternion(tiltQ);
      const score = v.z - Math.abs(v.x) * 4;
      if (score > bestZ) { bestZ = score; best = psi; }
    }
    v.copy(d).applyAxisAngle(new THREE.Vector3(0, 1, 0), best).applyQuaternion(tiltQ);
    const k = Math.round((this.yaw.x - best) / (Math.PI * 2));
    this.yaw.target = best + k * Math.PI * 2;
    this.yawVel = 0;
    this.pitch.target = Math.atan2(v.y, v.z);
    this.focusAim = true;
  }

  /** Fly to the base (pin click). */
  requestDescent(explicit?: { lat: number; lon: number }) {
    if (this.moving || !this.cur || !this.base) return;
    const s2 = explicit ?? { lat: this.base.lat, lon: this.base.lon };
    this.aimAt(s2.lat, s2.lon);
    this.zoomGoal = this.framingZoom();
    void this.globe(this.current).load("4k");
  }

  /** Screen-space globe centre and radius (px), for handing off to the descent. */
  get globeScreen() { return { x: this.cx, y: this.cy, r: this.rPx * this.zoom.x }; }
  resetZoom() { this.zoomGoal = 1; this.zoom.snap(1); this.yawVel = 0.11; this.focusAim = false; }
  private get focusK() { return this.base ? THREE.MathUtils.smoothstep(this.zoom.x, 2.0, 4.0) : 0; }

  /** Zoom that frames the built-up area at the current year. */
  private framingZoom() {
    const b = this.base!;
    const extWorld = b.extentAt(this.year) * 2.2;
    // FOV is vertical; on a portrait phone the width is what crops the city
    const fit = Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * Math.min(1, this.camera.aspect * 1.25);
    const d = clamp((extWorld * 1.5) / fit, 0.45, 4);
    const approach = this.camDist / d;
    return clamp(2.2 * Math.pow(approach, 1 / 1.6), 5, 13);
  }
  private swipeAcc = 0;
  private lastSwipe = 0;

  step(dir: 1 | -1) {
    const i = bodyIndex(this.current) + dir;
    if (i < 0 || i >= BODIES.length) {
      // resistance at the ends of the track
      this.track.v += dir * 1.2;
      return;
    }
    void this.show(BODIES[i].id);
    this.onNavigate(BODIES[i].id);
  }

  private hitGlobe(x: number, y: number) {
    return Math.hypot(x - this.cx, y - this.cy) < this.rPx * this.zoom.x * 1.05;
  }

  // ── layout & frame ────────────────────────────────────────────

  /** Post-processing for the aerial view: ambient occlusion grounds every object; a gentle
   *  depth of field (sharp at the target, soft fore and aft) gives the miniature read. */
  private composerLoading = false;
  private ensureComposer() {
    if (this.composer || this.composerLoading || !this.renderer) return;
    this.composerLoading = true;
    // loaded on first use: keeps the landing bundle small
    void Promise.all([
      import("three/examples/jsm/postprocessing/EffectComposer.js"),
      import("n8ao"),
      import("three/examples/jsm/postprocessing/BokehPass.js"),
      import("three/examples/jsm/postprocessing/OutputPass.js"),
    ]).then(([{ EffectComposer }, { N8AOPass }, { BokehPass }, { OutputPass }]) => this.buildComposer(EffectComposer, N8AOPass, BokehPass, OutputPass));
  }
  private buildComposer(
    EffectComposerC: typeof EffectComposer, N8AOPassC: typeof N8AOPass,
    BokehPassC: typeof BokehPass, OutputPassC: typeof import("three/examples/jsm/postprocessing/OutputPass.js").OutputPass,
  ) {
    const r = this.renderer!;
    const c = new EffectComposerC(r, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
    // N8AO renders the scene and its occlusion in one pass; radius in screen pixels suits a
    // miniature whose world units are tiny fractions of a globe
    const ao = new N8AOPassC(this.scene, this.camera, innerWidth, innerHeight);
    const lowPower = matchMedia("(pointer: coarse)").matches || innerWidth < 760;
    Object.assign(ao.configuration, { aoRadius: 26, distanceFalloff: 0.6, intensity: 2.6, screenSpaceRadius: true, halfRes: lowPower, gammaCorrection: false, aoSamples: 16, denoiseSamples: 8, denoiseRadius: 10, color: new THREE.Color(0.18, 0.1, 0.06) });
    c.addPass(ao);
    // depth of field costs a full extra scene render: desktop only
    const b = new BokehPassC(this.scene, this.camera, { focus: 1, aperture: 0.0025, maxblur: 0.006 });
    b.enabled = !lowPower;
    c.addPass(b);
    c.addPass(new OutputPassC());
    c.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    c.setSize(innerWidth, innerHeight);
    this.composer = c; this.ao = ao; this.bokeh = b;
    this.composerReady?.();
  }

  /**
   * The fog stays in the scene for good and is pushed out of range when unwanted: adding or
   * removing scene.fog changes every lit material's program, which recompiled the whole city.
   */
  private fog = new THREE.Fog(0x000000, 1e6, 1e6 + 1);
  private clearFog() {
    if (this.fog.near > 1e5) return;
    this.fog.near = 1e6; this.fog.far = 1e6 + 1;
    for (const [, gl] of this.globes) gl.u.uFogDensity.value = 0;
  }

  private composerReady: (() => void) | null = null;
  private warmed = new Set<BodyId>();
  /**
   * First sight of a city used to compile ~50 shader programs mid-dive (a 150 ms hitch).
   * Compile them while the globe idles instead: the city's materials via the parallel-compile
   * path, then one off-screen pass of the surface composer for its AO/DOF programs.
   */
  private async warmSurface(id: BodyId) {
    const b = this.bases.get(id), r = this.renderer;
    if (!b || !r || this.warmed.has(id)) return;
    this.warmed.add(id);
    if (!this.composer) {
      await new Promise<void>((res) => { this.composerReady = res; this.ensureComposer(); });
      this.composerReady = null;
    }
    const c = this.composer;
    if (!c || this.current !== id || this.focusK > 0.3) { this.warmed.delete(id); return; }
    // show every part of the plan (hidden pieces and empty instance pools draw nothing,
    // so they'd otherwise compile mid-dive), then restore exactly what was there
    const reveal = () => {
      const saved: [THREE.Object3D, boolean, number][] = [];
      b.group.traverse((o) => {
        const im = o as THREE.InstancedMesh;
        saved.push([o, o.visible, im.isInstancedMesh ? im.count : -1]);
        o.visible = true;
        if (im.isInstancedMesh && im.count === 0) im.count = 1;
      });
      return () => { for (const [o, v, n] of saved) { o.visible = v; if (n >= 0) (o as THREE.InstancedMesh).count = n; } };
    };
    let restore = reveal();
    // surface materials are drawn into the composer's linear target: compile that variant,
    // in parallel where the driver allows it
    // (and the screen variant too: the first frames of a dive draw the city before the composer engages)
    const prev = r.getRenderTarget();
    r.setRenderTarget(c.readBuffer);
    const linear = r.compileAsync(this.scene, this.camera).catch(() => {});
    r.setRenderTarget(null);
    const screen = r.compileAsync(this.scene, this.camera).catch(() => {});
    r.setRenderTarget(prev);
    const compiling = Promise.all([linear, screen]);
    restore();
    await compiling;
    if (this.current !== id || this.focusK > 0.3) return;
    // one off-screen composer pass picks up what compile() can't: AO depth/normal and shadow programs
    restore = reveal();
    LINEAR_OUT.value = 1;
    c.renderToScreen = false;
    c.render();
    c.renderToScreen = true;
    LINEAR_OUT.value = 0;
    restore();
  }


  // ── the ISS close up ──────────────────────────────────────────

  /** Open the station view (from its label, or a station moment on the timeline). */
  enterStation(scene?: StationScene) {
    const y = this.year;
    const name = scene ?? (y < 2017 ? "2011" : y < 2021 ? "demo2" : y < 2028 ? "today" : y < 2029.4 ? "lowering" : "usdv");
    // the ISS spends ~35 of every 93 minutes in Earth's shadow: if it's in the dark now,
    // skip ahead (as the fly-in hides) to its next pass over the sunlit side
    const O = this.orbits, idx = O?.index("ISS") ?? -1;
    if (O && idx >= 0 && name !== "reentry") {
      const g = this.globe("earth");
      const sunLocal = LIGHT.clone().applyQuaternion(g.spin.getWorldQuaternion(new THREE.Quaternion()).invert());
      const p = new THREE.Vector3();
      for (let k = 0; k < 190; k++) {
        const ms = O.simMs + k * 30000;
        // simulated time runs on while the globe spins; GMST is folded into positionOf
        if (O.positionOf(idx, p, ms).normalize().dot(sunLocal) > 0.72) { O.simMs = ms; break; }
      }
    }
    this.station.enter(name);
    this.stationStop = Math.round(this.ruler.pos);
    document.body.setAttribute("data-station", "");
  }
  private stationStop = -1;

  leaveStation() {
    this.station.exit();
    document.body.removeAttribute("data-station");
  }

  private stationBasis = new THREE.Matrix4();
  private stationW = new THREE.Vector3();
  private m2w = 1;

  /** Station moments on the timeline open the close-up once the ruler rests; leaving them closes it. */
  private updateStation(dt: number) {
    const st = this.station, O = this.orbits!;
    const ev = this.cur?.stops[Math.round(this.ruler.pos)]?.event;
    const scene = this.current === "earth" && ev?.orbit?.view === "station" ? (ev.orbit.scene as StationScene) : null;
    if (scene && ev && this.ruler.settled && this.autoStation !== ev.id && this.enterT > 0.95 && !this.moving) {
      this.autoStation = ev.id;
      this.enterStation(scene);
    } else if (!scene && this.autoStation) {
      this.autoStation = null;
      if (st.active) this.leaveStation();
    } else if (!scene && st.active && Math.round(this.ruler.pos) !== this.stationStop) {
      // opened from the ISS label: moving the timeline elsewhere hands back to the globe
      this.leaveStation();
    }
    if (st.active && (this.current !== "earth" || document.body.dataset.mode !== "planet")) this.leaveStation();
    st.stepK(dt);
    if (!st.visible) { this.stationNear = false; return; }

    // where the station is, and its orbital frame (x forward, y zenith)
    const g = this.globe("earth");
    const idx = O.index("ISS");
    const p = new THREE.Vector3(), p2 = new THREE.Vector3();
    let altKm = 418;
    if (st.sceneName === "reentry") {
      // the planned impact zone: the South Pacific near Point Nemo (48.9° S, 123.4° W)
      altKm = 100;
      latLonToDir(-48.88, -123.39, p).multiplyScalar(1 + altKm / 6371);
      const east = new THREE.Vector3(0, 1, 0).cross(p).normalize();
      p2.copy(p).addScaledVector(east, 0.001);
    } else if (idx >= 0) {
      O.positionOf(idx, p);
      O.positionOf(idx, p2, O.simMs + 1000);
      altKm = (p.length() - 1) * 6371;
    }
    const speed = Math.sqrt(398600.4418 / (6371 + altKm));     // circular orbital speed, km/s
    const centre = g.spin.getWorldPosition(new THREE.Vector3());
    const W = g.spin.localToWorld(p.clone());
    const W2 = g.spin.localToWorld(p2.clone());
    const up = W.clone().sub(centre).normalize();
    const fwd = W2.clone().sub(W);
    fwd.addScaledVector(up, -fwd.dot(up)).normalize();
    const side = new THREE.Vector3().crossVectors(fwd, up);
    this.stationBasis.makeBasis(fwd, up, side);
    this.stationW.copy(W);
    this.m2w = W.distanceTo(centre) / (p.length() * 6371000);
    const q = new THREE.Quaternion().setFromRotationMatrix(this.stationBasis);
    const qi = q.clone().invert();

    // sun in the station frame (for its lighting), dimmed inside Earth's shadow, and the readout
    const sw = LIGHT.clone();
    const rr = W.clone().sub(centre).divideScalar(g.root.scale.x);
    const along = rr.dot(sw), perp = rr.clone().addScaledVector(sw, -along).length();
    const sunlit = along > 0 ? 1 : THREE.MathUtils.smoothstep(perp, 0.995, 1.01);
    st.update(dt, sw.applyQuaternion(qi), { alt: altKm, speed }, sunlit);

    // camera: from the globe view into the station's frame, log-interpolating the distance
    const e = THREE.MathUtils.smootherstep(st.k.x, 0, 1);
    const camS = st.pose().applyQuaternion(q).multiplyScalar(this.m2w).add(W);
    const lookS = st.look.clone().applyQuaternion(q).multiplyScalar(this.m2w).add(W);
    const camN = this.camera.position.clone(), lookN = this.camTarget.clone();
    const dN = camN.distanceTo(W), dS = camS.distanceTo(W);
    const d = Math.exp(Math.log(dN) + (Math.log(dS) - Math.log(dN)) * e);
    const dir = camN.clone().sub(W).normalize().lerp(camS.clone().sub(W).normalize(), e).normalize();
    const cam = this.stationCam;
    cam.position.copy(W).addScaledVector(dir, d);
    cam.up.set(0, 1, 0).lerp(up, e).normalize();
    cam.lookAt(lookN.lerp(lookS, THREE.MathUtils.smoothstep(e, 0, 0.6)));
    cam.fov = FOV + (st.cam.fov - FOV) * e;
    cam.aspect = this.camera.aspect;
    cam.near = Math.max(d * 0.08, 1e-7);
    cam.far = Math.max(8 * g.root.scale.x, d * 4);
    cam.updateProjectionMatrix();
    // the same view in metres, for the station scene
    const dm = d / this.m2w;
    this.stationNear = dm < 8000;
    const sc = st.cam;
    sc.position.copy(cam.position).sub(W).divideScalar(this.m2w).applyQuaternion(qi);
    sc.quaternion.copy(qi).multiply(cam.quaternion);
    sc.fov = cam.fov; sc.aspect = cam.aspect;
    sc.near = Math.max(0.3, dm * 0.01); sc.far = dm * 6 + 800;
    sc.updateProjectionMatrix();
    sc.updateMatrixWorld();
  }

  private orbitNote: HTMLElement | null = null;
  /** Labels for the crewed stations (and planned ones), clickable to fly to the ISS. */
  private updateOrbitLabels() {
    const O = this.orbits!;
    // the swarm, accounted for: what it is, where it comes from, and that orbits run fast here
    if (!this.orbitNote && O.meta) {
      const c = O.meta.counts, fmt = (n = 0) => n.toLocaleString("en-US");
      const other = (c.leo ?? 0) + (c.oneweb ?? 0) + (c.meo ?? 0) + (c.geo ?? 0) + (c.heo ?? 0);
      this.orbitNote = document.createElement("p");
      this.orbitNote.className = "orbit-note";
      this.orbitNote.innerHTML = `<b>${fmt(c.starlink)}</b> Starlink · <b>${fmt(other)}</b> other satellites · <b>${fmt(c.debris)}</b> debris from four break-ups · CelesTrak, ${new Date(O.meta.epoch).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} · orbits ×${O.warp}`;
      document.body.appendChild(this.orbitNote);
    }
    this.orbitNote?.toggleAttribute("data-on", this.current === "earth" && document.body.dataset.mode === "planet" && this.enterT > 0.95
      && this.year > 2025.5 && this.year < 2027 && this.station.k.x < 0.05);
    const show = this.current === "earth" && document.body.dataset.mode === "planet" && this.enterT > 0.95 && !this.moving && this.station.k.x < 0.05 && this.focusK < 0.25;
    const ev = this.cur?.stops[Math.round(this.ruler.pos)]?.event;
    const y = this.year;
    const want: { id: string; name: string; at: () => THREE.Vector3 | null; on: boolean; projected?: boolean; click?: () => void }[] = [
      { id: "ISS", name: "ISS", on: y >= 1998.9 && y < 2030.95, at: () => O.index("ISS") >= 0 ? O.positionOf(O.index("ISS")) : null, click: () => this.enterStation() },
      { id: "Tiangong", name: "Tiangong", on: y >= 2021.33, at: () => O.index("Tiangong") >= 0 ? O.positionOf(O.index("Tiangong")) : null },
      // Haven-1: Vast's published orbit (425 km, 51.6°); its position along it is illustrative
      { id: "Haven-1", name: "Haven-1", projected: true, on: y >= 2027.4 && (ev?.orbit?.focus === "Haven-1" || ev?.orbit?.focus === "successors"), at: () => circular(O.simMs, 425, 51.6, 1.2, O.gmst()) },
    ];
    for (const w of want) {
      let el = this.orbLabels.get(w.id);
      if (!el) {
        el = document.createElement(w.click ? "button" : "div");
        el.className = "orb" + (w.projected ? " projected" : "");
        el.innerHTML = `<i></i><span>${esc(w.name)}</span>`;
        if (w.click) { el.setAttribute("aria-label", `Fly to the ${w.name}`); el.addEventListener("click", w.click); }
        this.shell.labels.appendChild(el);
        this.orbLabels.set(w.id, el);
      }
      const p = show && w.on ? w.at() : null;
      let vis = false;
      if (p) {
        const g = this.globe("earth");
        const wp = g.spin.localToWorld(p.clone());
        const centre = g.spin.getWorldPosition(new THREE.Vector3());
        const toCam = this.camera.position.clone().sub(wp).normalize();
        const out = wp.clone().sub(centre).normalize();
        // hidden behind Earth's limb
        const r = wp.distanceTo(centre), R = g.root.scale.x;
        const behind = out.dot(toCam) < -Math.sqrt(Math.max(0, 1 - (R / r) ** 2)) + 0.02;
        if (!behind) {
          const s = wp.project(this.camera);
          el.style.transform = `translate(${((s.x * 0.5 + 0.5) * innerWidth).toFixed(1)}px, ${((-s.y * 0.5 + 0.5) * innerHeight).toFixed(1)}px)`;
          vis = true;
        }
      }
      el.toggleAttribute("data-on", vis);
    }
  }

  /** Draw the planet view: post-processed over a surface, direct otherwise. */
  render() {
    const r = this.renderer!;
    if (this.station.visible && this.current === "earth") {
      // Earth and the swarm from the station's viewpoint, then the station itself in metres
      this.sky.update(this.stationCam, this.enterT * 0.6);
      r.setRenderTarget(null);
      r.render(this.scene, this.stationCam);
      if (this.stationNear) this.station.render(r);
      return;
    }
    if (this.focusK > 0.3) this.ensureComposer();
    if (this.focusK > 0.3 && this.composer) {
      const d = this.camera.position.distanceTo(this.camTarget);
      // AO reach grows a little as you come in, so close-ups get deeper contact shading
      this.ao!.configuration.aoRadius = clamp(38 - d * 30, 18, 40);
      const u = (this.bokeh as unknown as { uniforms: Record<string, THREE.IUniform> }).uniforms;
      u.focus.value = d; u.aperture.value = 0.0012 / Math.max(d, 0.05); u.maxblur.value = 0.0045;
      LINEAR_OUT.value = 1;
      this.composer!.render();
      LINEAR_OUT.value = 0;
    } else {
      r.setRenderTarget(null);
      r.render(this.scene, this.camera);
    }
  }

  resize(w: number, h: number) {
    this.composer?.setSize(w, h);
    const mobile = w < 640;
    this.rPx = Math.round(clamp(Math.min(w * (mobile ? 0.36 : 0.2), h * 0.2), 96, 220));
    this.cx = w / 2;
    this.cy = Math.round(h * (mobile ? 0.4 : 0.41));
    this.camera.aspect = w / h;
    // distance so a unit sphere spans rPx
    const f = h / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    this.camDist = Math.sqrt(1 + (f / this.rPx) ** 2);
    // shift the projection so the globe sits at (cx, cy)
    this.camera.setViewOffset(w, h, 0, h / 2 - this.cy, w, h);
    this.camera.updateProjectionMatrix();
    const s = this.shell.planetUi.style;
    s.setProperty("--shadow-y", `${this.cy + this.rPx * 1.2}px`);
    s.setProperty("--shadow-w", `${this.rPx * 1.5}px`);
    s.setProperty("--caption-y", `${this.cy + this.rPx * 1.42}px`);
    s.setProperty("--ruler-y", `${this.cy + this.rPx * 1.42 + 66}px`);
  }

  update(dt: number, t: number) {
    const now = performance.now() / 1000;
    this.ruler.update(dt, now);

    // zoom
    this.zoom.target = this.zoomGoal;
    this.zoom.step(dt);
    const z = this.zoom.x;
    const fk = this.focusK;

    // rotation: idle drift + flick inertia + scrub spin (held still while aimed at the base)
    if (this.focusAim) {
      this.yaw.step(dt);
    } else if (this.station.active || this.station.visible) {
      // in the close-up only real (orbital) time moves the Earth: no decorative drift
      this.yawVel = 0;
    } else if (!this.drag) {
      this.yawVel = follow(this.yawVel, 0.11, dt, 1.4);
      this.yaw.target += (this.yawVel + this.scrubSpin * 2.2) * dt;
      this.yaw.x = this.yaw.target;
    }
    this.scrubSpin = follow(this.scrubSpin, 0, dt, 0.35);
    this.pitch.step(dt);
    if (!this.drag && !this.focusAim) this.pitch.target = follow(this.pitch.target, 0.12, dt, 3);
    if (!this.focusAim) { this.orbitAz = follow(this.orbitAz, 0, dt, 0.6); this.tiltAdj = follow(this.tiltAdj, 0, dt, 0.6); }

    // the track
    this.track.step(dt);
    const tp = this.track.x;
    const tv = this.track.v;
    const half = Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * this.camera.aspect * this.camDist;
    this.spacing = Math.max(2.8, half + 1.4);
    const e = this.enterT;
    for (const [id, g] of this.globes) {
      const off = bodyIndex(id) - tp;
      const vis = Math.abs(off) < 1.25;
      g.root.visible = vis;
      if (!vis) continue;
      const a = Math.min(1, Math.abs(off));
      g.setOpacity(clamp(e * 1.4, 0, 1));
      g.root.position.set(off * this.spacing, 0, -a * 0.6);
      g.root.scale.setScalar(Math.min(z, 2.2) * (1 - 0.1 * a) * (0.9 + 0.1 * expoOut(e)));
      g.spin.rotation.y = this.yaw.x + off * 1.2;
      g.root.rotation.x = this.pitch.x;
      g.u.uBlur.value = clamp(Math.abs(tv) * 0.006 + (Math.abs(this.yawVel + this.scrubSpin * 2.2) - 0.3) * 0.012, 0, 0.05);
      g.update(t, this.camera);
    }
    this.moving = Math.abs(tp - bodyIndex(this.current)) > 0.04;

    // camera: beyond the globe's own zoom, fly toward the base and tilt to an aerial view
    const approach = Math.pow(z / Math.min(z, 2.2), 1.6);
    const d = this.camDist / approach;
    const T = new THREE.Vector3(), B = new THREE.Vector3(0, 0, 1);
    if (fk > 0 && this.base) {
      // frame the event on the ruler if it has a place on the surface, else the whole base
      const evId = this.cur?.stops[this.ruler.stop]?.event?.id ?? "";
      const fp = this.base.site.focus[evId];
      this.focusGoal.set(fp ? fp.x : 0, 0, fp ? fp.z : 0);
      this.focusPt.x = follow(this.focusPt.x, this.focusGoal.x, dt, 0.7);
      this.focusPt.z = follow(this.focusPt.z, this.focusGoal.z, dt, 0.7);
      const site = this.base.pointWorld(this.focusPt.x, this.focusPt.z);
      const n = site.clone().normalize();
      const down = new THREE.Vector3(0, -1, 0).addScaledVector(n, n.y).normalize().applyAxisAngle(n, this.orbitAz);
      const tau = (0.92 + this.tiltAdj) * THREE.MathUtils.smoothstep(z, 2.2, 5);
      const bf = n.clone().multiplyScalar(Math.cos(tau)).addScaledVector(down, Math.sin(tau)).normalize();
      B.lerp(bf, fk).normalize();
      T.copy(site).multiplyScalar(fk);
      // the sun's shadow box follows the base
      // a low afternoon sun from the north-west, so shadows stretch toward the viewer
      const north = new THREE.Vector3(0, 1, 0).addScaledVector(n, -n.y).normalize();
      const east = new THREE.Vector3().crossVectors(north, n).normalize();
      const el = this.base.site.sunElev;
      const sunDir = n.clone().multiplyScalar(Math.sin(el)).addScaledVector(north.multiplyScalar(0.72).addScaledVector(east, -0.69), Math.cos(el)).normalize();
      this.sun.target.position.copy(site);
      this.sun.position.copy(site).addScaledVector(sunDir, 1.5);
      const sc = this.sun.shadow.camera;
      const span = clamp(d * 0.45, 0.012, 0.4);
      sc.left = -span; sc.right = span; sc.top = span; sc.bottom = -span; sc.near = 0.05; sc.far = 4;
      sc.updateProjectionMatrix();
      // zooming in by hand before anything is built: take the timeline to the first landing
      // aerial perspective: Mars' dusty air hazes the distance; the airless Moon stays crisp
      if (!this.base.site.lunar) {
        const haze = this.hazeColor;
        const fg = this.fog;
        fg.color.copy(haze);
        fg.near = d * 1.4; fg.far = d * 7.5;
        for (const [, gl] of this.globes) { gl.u.uFogDensity.value = fk * 0.9 / Math.max(d * 6, 0.01); gl.u.uFogColor.value.copy(this.hazeSRGB); }
      } else { this.clearFog(); }
      if (fk > 0.5 && !this.builtTo2031 && this.userZoomed && !this.autoSurface && !this.base.hasActivity && this.zoomGoal > 2) { this.builtTo2031 = true; this.scrubToYear(this.base.site.firstYear); }
    } else {
      this.builtTo2031 = false;
      this.clearFog();
    }
    this.camera.position.copy(T).addScaledVector(B, d);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(T);
    this.camTarget.copy(T);
    this.camera.near = Math.max(0.0004, d * 0.02);
    // over the surface keep depth tight (AO and DOF need precision); the horizon is ~√(2Rd) away
    this.camera.far = fk > 0.3 ? Math.max(6, d * 30) : 200;
    this.camera.updateProjectionMatrix();
    this.sky.update(this.camera, this.enterT * 0.6);   // quieter sky behind a planet than in the overview
    for (const [id, b] of this.bases) {
      if (id === this.current) b.setYear(this.year);
      b.update(dt, t, this.camera, id === this.current && !this.moving && this.enterT > 0.5);
    }
    if (this.orbits) {
      // the space age only: fades in from Sputnik, out when you leave Earth
      const onEarth = this.current === "earth" && document.body.dataset.mode === "planet" ? this.enterT : 0;
      const sk = this.station.k.x;
      this.orbits.warp = 30 + (1 - 30) * Math.min(1, sk * 1.2);     // the close-up runs in real time
      this.orbits.u.uHide.value = sk > 0.02 ? this.orbits.index("ISS") : -1;
      this.orbits.update(dt, this.year, onEarth * THREE.MathUtils.smoothstep(this.year, 1956.5, 1958), sk, LIGHT, this.zoom.x);
      this.updateStation(dt);
      this.updateOrbitLabels();
    }
    // the city is heard only from over it, and louder as more of it stands
    const hb = this.base;
    this.sound.setSettlement(hb && document.body.dataset.mode === "planet" ? hb.built * this.focusK : 0, !!hb?.site.lunar, dt);
    // when the timeline reaches events on the surface, fly there; leave when it goes back
    const cb = this.base;
    // only once the timeline comes to rest: never yank the camera down mid-scroll
    const wantSurface = !!cb && cb.hasActivity && !this.moving && this.enterT > 0.95 && document.body.dataset.mode === "planet"
      && (this.autoSurface || this.ruler.settled);
    if (wantSurface && !this.autoSurface) { this.autoSurface = true; this.builtTo2031 = true; this.userZoomed = false; this.requestDescent(); }
    else if (!wantSurface && this.autoSurface) {
      this.autoSurface = false;
      if (cb && !cb.hasActivity) { this.zoomGoal = 1; this.focusAim = false; this.userZoomed = false; }
    }
    if (this.autoSurface && this.focusAim && !this.userZoomed) {
      const evId = this.cur?.stops[this.ruler.stop]?.event?.id ?? "";
      const fz = cb?.site.focus[evId]?.zoom;
      this.zoomGoal = follow(this.zoomGoal, fz ?? this.framingZoom(), dt, 0.8);
    }
    document.body.toggleAttribute("data-aerial", fk > 0.25);
    if (cb && this.noteFor !== cb.site.id) {
      this.noteFor = cb.site.id;
      const el = document.querySelector(".aerial-note");
      if (el) el.textContent = `${cb.site.name}, ${cb.site.note} · real location, illustrative layout and scale`;
    }

    const sh = this.shell.shadow.style;
    sh.opacity = String(this.enterT);
    sh.transform = `scale(${z.toFixed(3)})`;
    this.updatePins(z);
  }

  private updatePins(z: number) {
    const g = this.globes.get(this.current);
    if (!g) return;
    const v = new THREE.Vector3();
    const m = g.mesh.matrixWorld;
    const camDir = new THREE.Vector3();
    const w = innerWidth, h = innerHeight;
    for (const p of this.pins) {
      v.copy(p.dir).applyMatrix4(m);
      camDir.copy(this.camera.position).sub(v).normalize();
      const n = v.clone().sub(g.root.position).normalize();
      const facing = n.dot(camDir);
      v.project(this.camera);
      const x = (v.x * 0.5 + 0.5) * w, y = (-v.y * 0.5 + 0.5) * h;
      p.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      const visible = (p as any).on && facing > 0.15 && document.body.dataset.mode === "planet" && !this.moving && this.enterT > 0.95 && this.focusK < 0.25;
      p.el.toggleAttribute("data-hidden", !visible);
      p.el.toggleAttribute("data-show", visible && z > 1.6);
    }
    // people labels: project, then push apart so names never sit on top of each other
    const placed: { x: number; y: number; w: number }[] = [];
    const vis = this.enterT > 0.95 && !this.moving && this.focusK < 0.25 ? 1 : 0;
    const order = this.people.map((p) => {
      v.copy(p.dir).applyMatrix4(m);
      const n = v.clone().sub(g.root.position).normalize();
      camDir.copy(this.camera.position).sub(v).normalize();
      const facing = n.dot(camDir);
      v.project(this.camera);
      p.x = (v.x * 0.5 + 0.5) * w; p.y = (-v.y * 0.5 + 0.5) * h;
      return { p, facing };
    }).sort((a, b) => a.p.y - b.p.y);
    for (const { p, facing } of order) {
      const lw = (p.el.textContent?.length ?? 8) * 6.2 + 14;
      let y = p.y;
      for (let tries = 0; tries < 6; tries++) {
        const hit = placed.find((q) => Math.abs(q.y - y) < 15 && p.x < q.x + q.w && p.x + lw > q.x);
        if (!hit) break;
        y = hit.y + 15;
      }
      placed.push({ x: p.x, y, w: lw });
      const dy = y - p.y;
      p.el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
      p.el.style.setProperty("--dy", `${dy.toFixed(1)}px`);
      p.el.style.opacity = String(clamp((facing - 0.1) / 0.25, 0, 1) * vis);
      p.el.style.pointerEvents = facing > 0.2 && vis ? "" : "none";
    }
  }

  setActive(on: boolean) {
    this.shell.planetUi.toggleAttribute("inert", !on);
    for (const p of this.pins) p.el.style.display = on ? "" : "none";
  }

  /** Dev: settle every animation and jump to a stop, for deterministic screenshots. */
  debugJump(i: number) {
    this.track.snap(bodyIndex(this.current)); this.scrubSpin = 0; this.yawVel = 0.11;
    this.enterT = 1;
    this.ruler.jump(i < 0 ? this.ruler.count + i : i);
  }
  get stops() { return this.cur?.stops ?? []; }

  focusRuler() { this.shell.ruler.focus({ preventScroll: true }); }
  scrub(dir: 1 | -1) { this.ruler.goTo(this.ruler.stop + dir, true); }
}

function interpYear(a: number, b: number, t: number) {
  // interpolate in "years ago" log space so deep time doesn't rush past history
  const A = Math.log10(1 + Math.max(0, TODAY_YEAR - a)), B = Math.log10(1 + Math.max(0, TODAY_YEAR - b));
  if (a > TODAY_YEAR || b > TODAY_YEAR) return a + (b - a) * t;
  return TODAY_YEAR - (Math.pow(10, A + (B - A) * t) - 1);
}

function nearestEvent(stops: Stop[], idx: number) {
  for (let d = 0; d < stops.length; d++) {
    if (stops[idx - d]?.event) return stops[idx - d].event!;
  }
  return null;
}

const shortTitle = (t: string) => (t.length > 38 ? t.slice(0, 36).trimEnd() + "…" : t);
