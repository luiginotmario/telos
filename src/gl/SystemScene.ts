import * as THREE from "three";
import * as Astro from "astronomy-engine";
import { BODIES, type BodyDef, type BodyId } from "../bodies";
import { Globe } from "./Globe";
import { NOISE } from "./noise.glsl";
import { loadMap } from "./textures";
import { clamp, follow } from "../motion";

const EQJ_ECL = Astro.Rotation_EQJ_ECL();
const R_EARTH = 6371;

/** EQJ (J2000 equator) vector → three.js world: ecliptic plane = XZ, ecliptic north = +Y. */
function eqjToWorld(x: number, y: number, z: number, out = new THREE.Vector3()) {
  const v = Astro.RotateVector(EQJ_ECL, new Astro.Vector(x, y, z, new Astro.AstroTime(0)));
  return out.set(v.x, v.z, -v.y);
}

/** Display radius in AU. Sizes are enlarged (sqrt-compressed) so every world is visible. */
export function displayRadius(def: BodyDef) {
  return 0.05 * Math.sqrt(def.radiusKm / R_EARTH);
}
const SUN_R = 0.2;

const starVert = /* glsl */ `
attribute float aMag; attribute float aCi;
uniform float uScale; uniform float uFade;
varying vec3 vCol; varying float vA;
vec3 bvToRgb(float bv){
  // Ballesteros (2012) B–V → temperature, then a Planckian-locus fit
  float t = 4600.0 * (1.0/(0.92*bv + 1.7) + 1.0/(0.92*bv + 0.62));
  t = clamp(t, 1500.0, 40000.0) / 100.0;
  float r = t <= 66.0 ? 1.0 : clamp(1.292936 * pow(t - 60.0, -0.1332047), 0.0, 1.0);
  float g = t <= 66.0 ? clamp(0.3900816 * log(t) - 0.6318414, 0.0, 1.0) : clamp(1.1298909 * pow(t - 60.0, -0.0755148), 0.0, 1.0);
  float b = t >= 66.0 ? 1.0 : (t <= 19.0 ? 0.0 : clamp(0.5432068 * log(t - 10.0) - 1.1962541, 0.0, 1.0));
  return vec3(r, g, b);
}
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float flux = pow(10.0, -0.4 * (aMag - 1.0));
  gl_PointSize = clamp(uScale * (1.6 + 2.6 * sqrt(flux)), 1.5, 11.0);
  vA = clamp(0.32 + 1.1 * sqrt(flux), 0.0, 1.0) * uFade;
  vCol = mix(vec3(1.0), bvToRgb(aCi), 0.55);
}`;
const starFrag = /* glsl */ `
varying vec3 vCol; varying float vA;
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0; float d = dot(p, p);
  float a = exp(-d * 4.0) * vA;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vCol * a, a);
}`;

const sunFrag = /* glsl */ `
varying vec3 vN; varying vec3 vP; uniform vec3 uCamPos; uniform float uTime;
${NOISE}
void main(){
  vec3 V = normalize(uCamPos - vP); float mu = max(dot(normalize(vN), V), 0.0);
  // limb darkening (Neckel & Labs style, u≈0.6) + granulation
  float limb = 1.0 - 0.6 * (1.0 - mu) - 0.2 * (1.0 - mu) * (1.0 - mu);
  float g = fbm(normalize(vN) * 18.0 + vec3(0.0, uTime * 0.05, 0.0)) * 0.5 + 0.5;
  vec3 c = mix(vec3(1.0, 0.62, 0.22), vec3(1.0, 0.93, 0.78), limb) * (0.9 + 0.14 * g);
  gl_FragColor = vec4(c * (0.55 + 0.6 * limb), 1.0);
}`;
const sunVert = /* glsl */ `varying vec3 vN; varying vec3 vP; void main(){ vN = normalize(mat3(modelMatrix)*normal); vec4 w = modelMatrix*vec4(position,1.0); vP = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`;

const glowFrag = /* glsl */ `
varying vec2 vUv; uniform float uI;
void main(){ vec2 p = vUv * 2.0 - 1.0; float d = length(p);
  float a = (0.5 * exp(-d * 7.0) + 0.22 * exp(-d * 2.6) + 0.06 * exp(-d * 1.1)) * uI;
  a *= smoothstep(1.0, 0.7, d);
  gl_FragColor = vec4(vec3(1.0, 0.82, 0.6) * a, a); }`;
const glowVert = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

interface Planet { def: BodyDef; globe: Globe; orbit?: THREE.Line; label: HTMLButtonElement; r: number }

export class SystemScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private planets: Planet[] = [];
  private sun: THREE.Mesh;
  private sunU: Record<string, THREE.IUniform>;
  private glow: THREE.Mesh;
  private starsU = { uScale: { value: 1 }, uFade: { value: 1 } };
  private sky = new THREE.Group();
  date = new Date();

  // orbit camera
  target = new THREE.Vector3();
  private targetGoal = new THREE.Vector3();
  dist = 70; private distGoal = 70;
  az = -0.6; private azGoal = -0.6;
  el = 0.42; private elGoal = 0.42;
  private dragging: { x: number; y: number; id: number } | null = null;
  private hovered: BodyId | null = null;
  focus: BodyId | null = null;
  locked = false;

  onSelect: (id: BodyId) => void = () => {};

  constructor(private canvas: HTMLCanvasElement, labelLayer: HTMLElement) {
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.001, 5000);
    this.scene.background = new THREE.Color(0, 0, 0);

    // Sun
    this.sunU = { uCamPos: { value: new THREE.Vector3() }, uTime: { value: 0 } };
    this.sun = new THREE.Mesh(new THREE.SphereGeometry(SUN_R, 96, 48), new THREE.ShaderMaterial({ uniforms: this.sunU, vertexShader: sunVert, fragmentShader: sunFrag }));
    this.scene.add(this.sun);
    this.glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
      uniforms: { uI: { value: 1 } }, vertexShader: glowVert, fragmentShader: glowFrag,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.glow.scale.setScalar(SUN_R * 14);
    this.scene.add(this.glow);

    this.scene.add(this.sky);

    for (const def of BODIES) {
      const globe = new Globe(def, { dark: true, segments: 64 });
      const r = displayRadius(def);
      globe.root.scale.setScalar(r);
      globe.setVisual({ ...globe.visual, atmosphere: atmosphereToday(def.id), clouds: def.id === "earth" ? 0.7 : 0, lights: def.id === "earth" ? 1 : 0, haze: def.id === "venus" ? 1 : 0, atm: atmTint(def.id), rings: def.id === "saturn" ? 1 : 0 });
      this.scene.add(globe.root);
      void globe.load("2k");
      const label = document.createElement("button");
      label.className = "plabel";
      label.textContent = def.name;
      label.addEventListener("click", () => { if (!this.locked) this.onSelect(def.id); });
      label.addEventListener("pointerenter", () => { this.hovered = def.id; });
      label.addEventListener("pointerleave", () => { if (this.hovered === def.id) this.hovered = null; });
      labelLayer.appendChild(label);
      const p: Planet = { def, globe, label, r };
      if (def.id !== "moon") p.orbit = this.makeOrbit(def);
      this.planets.push(p);
    }
    void this.loadSky();
    this.setDate(new Date());
    this.bindInput();
  }

  private makeOrbit(def: BodyDef) {
    const periodDays: Record<string, number> = { mercury: 87.969, venus: 224.701, earth: 365.256, mars: 686.98, jupiter: 4332.59, saturn: 10759.22, uranus: 30685.4, neptune: 60189 };
    const P = periodDays[def.id];
    const N = 512;
    const pts: THREE.Vector3[] = [];
    const t0 = Astro.MakeTime(this.date);
    for (let i = 0; i <= N; i++) {
      const v = Astro.HelioVector(def.astro, t0.AddDays((i / N) * P));
      pts.push(eqjToWorld(v.x, v.y, v.z));
    }
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    // fade the trail behind the planet
    const a = new Float32Array(N + 1);
    for (let i = 0; i <= N; i++) a[i] = i / N;
    g.setAttribute("aT", new THREE.BufferAttribute(a, 1));
    const line = new THREE.Line(g, new THREE.ShaderMaterial({
      uniforms: { uO: { value: 1 } },
      vertexShader: `attribute float aT; varying float vT; void main(){ vT = aT; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      // brightest just behind the planet (vT → 1), fading back along its path
      fragmentShader: `varying float vT; uniform float uO; void main(){ float a = 0.05 + 0.25 * pow(vT, 3.0); gl_FragColor = vec4(vec3(1.0), a * uO); }`,
      transparent: true, depthWrite: false,
    }));
    this.scene.add(line);
    return line;
  }

  private async loadSky() {
    // Real stars: HYG v4 (CC BY-SA 4.0), mag ≤ 7, J2000 unit vectors.
    try {
      const [meta, buf] = await Promise.all([
        fetch("/stars-meta.json").then((r) => r.json()),
        fetch("/stars.bin").then((r) => r.arrayBuffer()),
      ]);
      const f = new Float32Array(buf);
      const stride: number = meta.stride ?? meta.floats_per_star ?? 5;
      const count = Math.floor(f.length / stride);
      const pos = new Float32Array(count * 3), mag = new Float32Array(count), ci = new Float32Array(count);
      const v = new THREE.Vector3();
      for (let i = 0; i < count; i++) {
        const o = i * stride;
        eqjToWorld(f[o], f[o + 1], f[o + 2], v).multiplyScalar(2000);
        pos.set([v.x, v.y, v.z], i * 3);
        mag[i] = f[o + 3]; ci[i] = f[o + 4];
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("aMag", new THREE.BufferAttribute(mag, 1));
      g.setAttribute("aCi", new THREE.BufferAttribute(ci, 1));
      const pts = new THREE.Points(g, new THREE.ShaderMaterial({
        uniforms: this.starsU, vertexShader: starVert, fragmentShader: starFrag,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      pts.frustumCulled = false;
      this.sky.add(pts);
    } catch { /* stars optional until assets land */ }

    // Milky Way background (equirectangular, celestial J2000 coordinates)
    const mw = await loadMap("sky", "color", "4k").catch(() => null) ?? await loadMilkyWay();
    if (mw) {
      mw.colorSpace = THREE.NoColorSpace;
      const geo = new THREE.SphereGeometry(2500, 64, 32);
      const m = new THREE.Mesh(geo, new THREE.ShaderMaterial({
        uniforms: { uTex: { value: mw }, uFade: this.starsU.uFade },
        vertexShader: `varying vec3 vD; void main(){ vD = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
        fragmentShader: `
          varying vec3 vD; uniform sampler2D uTex; uniform float uFade; uniform mat3 uToEqj;
          void main(){
            vec3 d = normalize(uToEqj * normalize(vD));
            float ra = atan(d.y, d.x); float dec = asin(clamp(d.z, -1.0, 1.0));
            // NASA SVS Deep Star Maps: RA increases to the left, 0h at centre
            vec2 uv = vec2(0.5 - ra / 6.28318530718, 0.5 + dec / 3.14159265);
            vec3 c = texture2D(uTex, uv).rgb;
            // drop the map's noise floor so deep space stays black
            c = max(c - 0.035, 0.0) * 1.1;
            gl_FragColor = vec4(c * c * 1.6 * uFade, 1.0);
          }`,
        side: THREE.BackSide, depthWrite: false,
      }));
      // world → EQJ (inverse of eqjToWorld)
      const w2e = new THREE.Matrix3();
      const ex = eqjToWorld(1, 0, 0), ey = eqjToWorld(0, 1, 0), ez = eqjToWorld(0, 0, 1);
      w2e.set(ex.x, ex.y, ex.z, ey.x, ey.y, ey.z, ez.x, ez.y, ez.z);
      (m.material as THREE.ShaderMaterial).uniforms.uToEqj = { value: w2e };
      m.renderOrder = -10;
      this.sky.add(m);
    }
  }

  setDate(d: Date) {
    this.date = d;
    const t = Astro.MakeTime(d);
    let earthPos = new THREE.Vector3();
    for (const p of this.planets) {
      if (p.def.id === "moon") continue;
      const v = Astro.HelioVector(p.def.astro, t);
      eqjToWorld(v.x, v.y, v.z, p.globe.root.position);
      if (p.def.id === "earth") earthPos = p.globe.root.position.clone();
      orient(p.globe, p.def.astro, t);
    }
    // Moon: true direction from Earth, distance enlarged so it clears the enlarged Earth.
    const moon = this.planets.find((p) => p.def.id === "moon");
    const earth = this.planets.find((p) => p.def.id === "earth");
    if (moon && earth) {
      const g = Astro.GeoMoon(t);
      const dir = eqjToWorld(g.x, g.y, g.z).normalize();
      moon.globe.root.position.copy(earthPos).addScaledVector(dir, earth.r * 3.2);
      orient(moon.globe, Astro.Body.Moon, t);
    }
    for (const p of this.planets) p.globe.u.uLightDir.value.copy(p.globe.root.position).negate().normalize();
  }

  positionOf(id: BodyId) { return this.planets.find((p) => p.def.id === id)!.globe.root.position; }
  radiusOf(id: BodyId) { return this.planets.find((p) => p.def.id === id)!.r; }

  /** Ease the camera to frame a body (used by the dive transition). */
  frame(id: BodyId | null, distance?: number) {
    if (id) {
      this.targetGoal.copy(this.positionOf(id));
      this.distGoal = distance ?? this.radiusOf(id) * 7;
    } else {
      this.targetGoal.set(0, 0, 0);
      this.distGoal = distance ?? 16;
    }
    this.focus = id;
  }

  setView(t: THREE.Vector3, dist: number, snap = false) {
    this.targetGoal.copy(t); this.distGoal = dist;
    if (snap) { this.target.copy(t); this.dist = dist; }
  }

  private bindInput() {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => {
      if (document.body.dataset.mode !== "system" || this.locked) return;
      this.dragging = { x: e.clientX, y: e.clientY, id: e.pointerId };
      (this as any)._down = { x: e.clientX, y: e.clientY };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener("pointermove", (e) => {
      if (document.body.dataset.mode !== "system") return;
      if (this.dragging && e.pointerId === this.dragging.id) {
        const dx = e.clientX - this.dragging.x, dy = e.clientY - this.dragging.y;
        this.dragging.x = e.clientX; this.dragging.y = e.clientY;
        this.azGoal -= dx * 0.005;
        this.elGoal = clamp(this.elGoal + dy * 0.004, -1.45, 1.45);
      } else {
        this.hovered = this.pick(e.clientX, e.clientY);
        c.style.cursor = this.hovered ? "pointer" : "";
      }
    });
    c.addEventListener("pointerup", (e) => {
      if (!this.dragging || e.pointerId !== this.dragging.id) return;
      const d = (this as any)._down;
      this.dragging = null;
      if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) {
        const hit = this.pick(e.clientX, e.clientY);
        if (hit && !this.locked) this.onSelect(hit);
      }
    });
    c.addEventListener("wheel", (e) => {
      if (document.body.dataset.mode !== "system" || this.locked) return;
      e.preventDefault();
      this.distGoal = clamp(this.distGoal * Math.exp(e.deltaY * 0.0012), 0.6, 140);
    }, { passive: false });
    // pinch
    const touches = new Map<number, { x: number; y: number }>();
    let pinch0 = 0, dist0 = 0;
    c.addEventListener("pointerdown", (e) => { if (e.pointerType === "touch") touches.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (touches.size === 2) { const [a, b] = [...touches.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); dist0 = this.distGoal; this.dragging = null; } });
    c.addEventListener("pointermove", (e) => {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2 && pinch0 > 0) { const [a, b] = [...touches.values()]; this.distGoal = clamp(dist0 * pinch0 / Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), 0.6, 140); }
    });
    const up = (e: PointerEvent) => { touches.delete(e.pointerId); if (touches.size < 2) pinch0 = 0; };
    c.addEventListener("pointerup", up); c.addEventListener("pointercancel", up);
  }

  private pick(x: number, y: number): BodyId | null {
    // generous screen-space hit test: nearest body within 18px or within its disc
    let best: BodyId | null = null, bestD = 18;
    const v = new THREE.Vector3();
    for (const p of this.planets) {
      v.copy(p.globe.root.position).project(this.camera);
      if (v.z > 1) continue;
      const sx = (v.x * 0.5 + 0.5) * innerWidth, sy = (-v.y * 0.5 + 0.5) * innerHeight;
      const pr = this.pixelRadius(p);
      const d = Math.hypot(sx - x, sy - y) - pr;
      if (d < bestD) { bestD = d; best = p.def.id; }
    }
    return best;
  }

  private pixelRadius(p: Planet) {
    const d = this.camera.position.distanceTo(p.globe.root.position);
    return (p.r / d) * (innerHeight / 2) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
  }

  resize(w: number, h: number) { this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }

  update(dt: number, t: number, active: boolean) {
    // camera
    if (!this.dragging && active && !this.focus) this.azGoal += dt * 0.006;
    const k = 0.35;
    this.az = follow(this.az, this.azGoal, dt, 0.12);
    this.el = follow(this.el, this.elGoal, dt, 0.12);
    this.dist = Math.exp(follow(Math.log(this.dist), Math.log(this.distGoal), dt, k));
    this.target.x = follow(this.target.x, this.targetGoal.x, dt, k);
    this.target.y = follow(this.target.y, this.targetGoal.y, dt, k);
    this.target.z = follow(this.target.z, this.targetGoal.z, dt, k);
    const ce = Math.cos(this.el);
    this.camera.position.set(
      this.target.x + this.dist * ce * Math.sin(this.az),
      this.target.y + this.dist * Math.sin(this.el),
      this.target.z + this.dist * ce * Math.cos(this.az),
    );
    this.camera.near = Math.max(0.0005, this.dist * 0.002);
    this.camera.far = 6000;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(this.target);
    this.sky.position.copy(this.camera.position);

    this.sunU.uCamPos.value.copy(this.camera.position);
    this.sunU.uTime.value = t;
    this.glow.quaternion.copy(this.camera.quaternion);
    this.starsU.uScale.value = Math.min(devicePixelRatio, 2);

    for (const p of this.planets) p.globe.update(t, this.camera);
    if (active) this.updateLabels();
  }

  private updateLabels() {
    const v = new THREE.Vector3();
    const w = innerWidth, h = innerHeight;
    for (const p of this.planets) {
      v.copy(p.globe.root.position).project(this.camera);
      const on = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      // hide the Moon label unless we're close enough to separate it from Earth
      const moonFar = p.def.id === "moon" && this.dist > 3;
      const pr = this.pixelRadius(p);
      const x = (v.x * 0.5 + 0.5) * w + pr + 4, y = (-v.y * 0.5 + 0.5) * h;
      p.label.style.transform = `translate(${x.toFixed(1)}px, ${(y - 11).toFixed(1)}px)`;
      p.label.style.opacity = on && !moonFar ? (this.hovered === p.def.id ? "1" : "") : "0";
      p.label.style.pointerEvents = on && !moonFar ? "" : "none";
      // tiny planets: keep at least ~1.5px so they never vanish
      const minPx = 1.6;
      const s = pr < minPx ? (minPx / Math.max(pr, 1e-4)) : 1;
      p.globe.root.scale.setScalar(p.r * s);
    }
  }

  /** Fade every world except `keep` (0 = all visible, 1 = only `keep`). */
  dimOthers(keep: BodyId | null, k: number) {
    for (const p of this.planets) {
      const o = keep && p.def.id !== keep ? 1 - k : 1;
      p.globe.setOpacity(o);
      if (p.orbit) ((p.orbit.material as THREE.ShaderMaterial).uniforms.uO.value = 1 - k * 0.85);
    }
  }
}

function atmosphereToday(id: BodyId) {
  return ({ earth: 0.9, venus: 0.8, mars: 0.35, jupiter: 0.4, saturn: 0.35, uranus: 0.6, neptune: 0.6 } as Record<string, number>)[id] ?? 0;
}
function atmTint(id: BodyId): [number, number, number] {
  const m: Record<string, [number, number, number]> = {
    earth: [0.45, 0.68, 1.0], venus: [1.0, 0.9, 0.7], mars: [0.95, 0.65, 0.45], jupiter: [0.95, 0.85, 0.7],
    saturn: [0.95, 0.88, 0.7], uranus: [0.6, 0.9, 0.95], neptune: [0.45, 0.6, 1.0],
  };
  return m[id] ?? [1, 1, 1];
}

const tq = new THREE.Matrix4();
/** IAU rotation model: pole + prime-meridian angle W → globe orientation. */
function orient(globe: Globe, body: Astro.Body, t: Astro.AstroTime) {
  const ax = Astro.RotationAxis(body, t);
  const P = eqjToWorld(ax.north.x, ax.north.y, ax.north.z).normalize();
  // node of the body's equator on the ICRF equator: ẑ × P (in EQJ), then to world
  const n = new THREE.Vector3(-ax.north.y, ax.north.x, 0).normalize();
  const Q = eqjToWorld(n.x, n.y, n.z).normalize();
  const R = new THREE.Vector3().crossVectors(P, Q);
  const W = THREE.MathUtils.degToRad(ax.spin);
  const X = Q.clone().multiplyScalar(Math.cos(W)).addScaledVector(R, Math.sin(W));
  const Z = new THREE.Vector3().crossVectors(X, P);
  tq.makeBasis(X, P, Z);
  globe.tilt.quaternion.setFromRotationMatrix(tq);
  globe.spin.rotation.set(0, 0, 0);
}

async function loadMilkyWay(): Promise<THREE.Texture | null> {
  for (const u of ["/textures/milkyway-4k.webp", "/textures/milkyway-4k.jpg", "/textures/milkyway-2k.webp"]) {
    try { return await new THREE.TextureLoader().loadAsync(u); } catch { /* next */ }
  }
  return null;
}
