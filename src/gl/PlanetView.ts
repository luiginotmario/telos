import * as THREE from "three";
import { BODIES, type BodyId, bodyIndex } from "../bodies";
import { type BodyData, type Era, type HumansData, type Site, TODAY_YEAR, formatShortAgo, loadBody, loadHumans } from "../data";
import { type Stop, buildStops, eraAt, visualAt } from "../timeline";
import { Globe, latLonToDir } from "./Globe";
import { BaseLayer, SITES } from "./base/BaseLayer";
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
const SPECIMENS_ENABLED = false;
// the Sun from the left and slightly behind: a lit crescent-to-gibbous face with a visible terminator
const LIGHT = new THREE.Vector3(-0.72, 0.24, 0.65).normalize();

interface Loaded { data: BodyData | null; humans: HumansData | null; stops: Stop[] }
interface PinEl { el: HTMLElement; site: Site; year: number; dir: THREE.Vector3 }

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
    // early-human figures: off until the realistic models ship (the panel works; the bodies don't yet)
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
      // reversing direction starts fresh, so the first notch the other way always counts
      if (Math.sign(-dy) !== Math.sign(this.wheelAcc)) this.wheelAcc = 0;
      this.wheelAcc += -dy;
      const now = performance.now();
      const STEP = 70;
      if (Math.abs(this.wheelAcc) >= STEP && now - this.lastWheelStep > 60) {
        const dir = this.wheelAcc > 0 ? 1 : -1;
        this.wheelAcc -= dir * STEP;
        this.wheelAcc = clamp(this.wheelAcc, -STEP, STEP);   // don't bank a backlog from flicks
        this.lastWheelStep = now;
        this.ruler.goTo(this.ruler.stop + dir, true);
        if (!document.body.hasAttribute("data-hinted")) {
          document.body.setAttribute("data-hinted", "");
          try { localStorage.setItem("telos:hinted", "1"); } catch { /* ignore */ }
        }
      }
    }, { passive: false });
  }
  private wheelAcc = 0;
  private lastWheelStep = 0;
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
  }

  /** Draw the planet view: post-processed over a surface, direct otherwise. */
  render() {
    const r = this.renderer!;
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
        if (!this.scene.fog) this.scene.fog = new THREE.Fog(haze, 1, 10);
        const fg = this.scene.fog as THREE.Fog;
        fg.near = d * 1.4; fg.far = d * 7.5;
        for (const [, gl] of this.globes) { gl.u.uFogDensity.value = fk * 0.9 / Math.max(d * 6, 0.01); gl.u.uFogColor.value.copy(this.hazeSRGB); }
      } else { this.scene.fog = null; for (const [, gl] of this.globes) gl.u.uFogDensity.value = 0; }
      if (fk > 0.5 && !this.builtTo2031 && this.userZoomed && !this.autoSurface && !this.base.hasActivity && this.zoomGoal > 2) { this.builtTo2031 = true; this.scrubToYear(this.base.site.firstYear); }
    } else {
      this.builtTo2031 = false;
      if (this.scene.fog) { this.scene.fog = null; for (const [, gl] of this.globes) gl.u.uFogDensity.value = 0; }
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
    // the city is heard only from over it, and louder as more of it stands
    const hb = this.base;
    this.sound.setSettlement(hb && document.body.dataset.mode === "planet" ? hb.built * this.focusK : 0, !!hb?.site.lunar, dt);
    // when the timeline reaches events on the surface, fly there; leave when it goes back
    const cb = this.base;
    const wantSurface = !!cb && cb.hasActivity && !this.moving && this.enterT > 0.95 && document.body.dataset.mode === "planet";
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
