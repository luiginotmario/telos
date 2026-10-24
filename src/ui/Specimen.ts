import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { esc } from "./swap";

/** data/hominins.json, written from Smithsonian / NHM / peer-reviewed measurements. */
export interface Hominin {
  key: string; name: string; alias?: string[]; alias_eras?: Record<string, number[]>; years: string;
  height_m: { mean?: number | null; male: number | null; female: number | null; range?: [number, number] | null; unreviewed_proxy?: { value: [number, number]; source: string } } | null;
  mass_kg?: { male: number | null; female: number | null; range?: [number, number] | null } | null;
  cranial_cc?: { mean: number | null; range?: [number, number] | null } | null;
  proportions?: { arm_to_leg?: number; torso?: string; build?: string };
  posture?: string; known_from?: string; confidence?: string; note?: string;
  sources?: { title: string; url: string }[];
}
export interface HomininData { modern: Hominin; species: Hominin[]; modern_aliases?: string[]; modern_alias_eras?: string[]; unmapped_aliases?: string[] | Record<string, unknown> }

const loader = new GLTFLoader();
const files = import.meta.glob<HomininData>("../../data/hominins.json", { import: "default" });
const avg = (h: Hominin["height_m"]) => {
  if (!h) return null;
  if (typeof h.mean === "number") return h.mean;
  const v = [h.male, h.female].filter((x): x is number => typeof x === "number");
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : h.range ? (h.range[0] + h.range[1]) / 2 : null;
};

/**
 * Side panel: the species and a modern human on one turntable, at true relative height,
 * with a metre scale. Its own small renderer; it only draws while open.
 */
export class Specimen {
  private el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(18, 1, 0.1, 50);
  private stage = new THREE.Group();
  private figs: THREE.Object3D[] = [];
  private raf = 0;
  private yaw = 0.5; private yawV = 0; private dragging = false; private lastX = 0;
  private data: HomininData | null = null;
  private dataP: Promise<HomininData | null> | null = null;
  private openKey = "";

  constructor() {
    this.el = document.createElement("aside");
    this.el.className = "specimen";
    this.el.setAttribute("aria-hidden", "true");
    this.el.innerHTML = `
      <button class="sp-x" aria-label="Close">
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
      </button>
      <div class="sp-stage"><canvas></canvas><div class="sp-scale"></div><div class="sp-tags"><span class="a"></span><span class="b">You</span></div></div>
      <div class="sp-body"></div>`;
    document.body.appendChild(this.el);
    this.canvas = this.el.querySelector("canvas")!;
    this.el.querySelector(".sp-x")!.addEventListener("click", () => this.close());
    addEventListener("keydown", (e) => { if (e.key === "Escape" && this.isOpen) { e.stopImmediatePropagation(); this.close(); } }, { capture: true });
    // drag to turn
    this.canvas.addEventListener("pointerdown", (e) => { this.dragging = true; this.lastX = e.clientX; this.canvas.setPointerCapture(e.pointerId); });
    this.canvas.addEventListener("pointermove", (e) => { if (!this.dragging) return; const dx = e.clientX - this.lastX; this.lastX = e.clientX; this.yaw += dx * 0.012; this.yawV = dx * 0.6; });
    const up = () => { this.dragging = false; };
    this.canvas.addEventListener("pointerup", up); this.canvas.addEventListener("pointercancel", up);
    this.scene.add(this.stage);
  }

  get isOpen() { return this.el.hasAttribute("data-open"); }

  load() {
    const f = files["../../data/hominins.json"];
    this.dataP ??= f ? f().catch(() => null) : Promise.resolve(null);
    return this.dataP.then((d) => (this.data = d));
  }

  /** Which species a people label refers to (or "modern"), following hominins.json's alias rules. */
  keyFor(name: string, eraYear: number): string | null {
    const d = this.data;
    if (!d) return null;
    const un = d.unmapped_aliases;
    if (un && (Array.isArray(un) ? un.includes(name) : name in un)) return null;
    for (const x of d.species) {
      if (x.name !== name && !x.alias?.includes(name)) continue;
      const eras = x.alias_eras?.[name];
      if (eras && !eras.some((e) => Math.abs(e - eraYear) <= Math.max(1, Math.abs(eraYear) * 0.05))) continue;
      return x.key;
    }
    if (d.modern_aliases?.includes(name) || d.modern_alias_eras?.includes(name)) return "modern";
    return eraYear >= -10000 ? "modern" : null;
  }

  private ensureRenderer() {
    if (this.renderer) return;
    const r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    const pm = new THREE.PMREMGenerator(r);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.28;
    pm.dispose();
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    // sculpture lighting: warm key from upper front-left, cool fill, a rim from behind to cut the silhouette
    const key = new THREE.DirectionalLight(0xfff1e2, 3.2);
    key.position.set(-2.2, 3.6, 2.6); key.castShadow = true; key.shadow.mapSize.set(1024, 1024); key.shadow.radius = 4;
    const sc = key.shadow.camera; sc.left = -2; sc.right = 2; sc.top = 3; sc.bottom = -1; sc.near = 0.5; sc.far = 12;
    const fill = new THREE.DirectionalLight(0xdfe8ff, 0.55); fill.position.set(2.6, 1.2, 2);
    const rim = new THREE.DirectionalLight(0xffffff, 1.6); rim.position.set(0.5, 2.4, -3);
    this.scene.add(key, fill, rim, new THREE.HemisphereLight(0xffffff, 0xb9aea2, 0.35));
    const floor = new THREE.Mesh(new THREE.CircleGeometry(3, 48).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ opacity: 0.22 }));
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.renderer = r;
  }

  async open(key: string, eraLabel: string) {
    await this.load();
    const d = this.data;
    if (!d) return;
    const sp = key === "modern" ? { ...d.modern, name: "Anatomically modern humans", note: "Same body as yours: this group is us.", known_from: "" } : d.species.find((s) => s.key === key);
    if (!sp) return;
    this.openKey = key;
    this.ensureRenderer();
    this.el.setAttribute("aria-hidden", "false");
    // re-trigger the entrance when switching species while open
    this.el.removeAttribute("data-open"); void this.el.offsetWidth; this.el.setAttribute("data-open", "");
    this.renderBody(sp, d.modern, eraLabel);
    await this.stageFigures(sp, d.modern, key);
    this.resize();
    cancelAnimationFrame(this.raf);
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (!this.dragging) { this.yawV *= Math.exp(-dt * 3); this.yaw += (0.25 + this.yawV * 0.02) * dt; }
      this.stage.rotation.y = this.yaw;
      this.renderer!.render(this.scene, this.camera);
      if (this.isOpen) this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  close() {
    this.el.removeAttribute("data-open");
    this.el.setAttribute("aria-hidden", "true");
    this.openKey = "";
  }

  private renderBody(sp: Hominin, modern: Hominin, era: string) {
    const h = avg(sp.height_m), hm = avg(modern.height_m) ?? 1.65;
    const cc = sp.cranial_cc?.mean ?? null, ccm = modern.cranial_cc?.mean ?? 1350;
    const row = (k: string, v: string, bar?: number) =>
      `<div class="sp-row"><dt>${k}</dt><dd>${v}${bar != null ? `<i class="sp-bar"><b style="transform:scaleX(${Math.min(1, bar).toFixed(3)})"></b></i>` : ""}</dd></div>`;
    const conf = sp.confidence === "low" ? `<span class="sp-conf">Body largely unknown</span>` : sp.confidence === "medium" ? `<span class="sp-conf">Partly reconstructed</span>` : "";
    (this.el.querySelector(".sp-tags .a") as HTMLElement).textContent = sp.name.replace(/^Homo /, "H. ");
    this.el.querySelector(".sp-body")!.innerHTML = `
      <p class="sp-eyebrow">${esc(era)}</p>
      <h2>${esc(sp.name)}</h2>
      <p class="sp-years">${esc(sp.years)}${conf}</p>
      ${sp.note ? `<p class="sp-note">${esc(sp.note)}</p>` : ""}
      <dl>
        ${h ? row("Height", `${h.toFixed(2)} m · you ${hm.toFixed(2)} m`) : sp.height_m?.unreviewed_proxy
          ? row("Height", `Unknown · preprint suggests ${sp.height_m.unreviewed_proxy.value[0].toFixed(2)}–${sp.height_m.unreviewed_proxy.value[1].toFixed(2)} m (not peer-reviewed)`)
          : row("Height", "Unknown: too few bones to reconstruct a body")}
        ${cc ? row("Brain", `${Math.round(cc)} cc · you ${ccm}`, cc / ccm) : ""}
        ${sp.posture ? row("Walked", esc(sp.posture)) : ""}
        ${sp.known_from ? row("Known from", esc(sp.known_from)) : ""}
      </dl>
      <div class="sp-src">${(sp.sources ?? []).slice(0, 3).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title.length > 34 ? s.title.slice(0, 32) + "…" : s.title)}</a>`).join("")}</div>`;
  }

  private async figure(key: string, height: number | null, ghost: boolean, uncertain = false) {
    let obj: THREE.Object3D;
    try {
      const g = await loader.loadAsync(`/models/hominins/${key}.glb`);
      obj = g.scene;
    } catch {
      obj = fallbackFigure();
    }
    // normalise: models are authored in metres, feet at y = 0; scale to the species' mean height
    const box = new THREE.Box3().setFromObject(obj);
    const modelH = box.max.y - box.min.y || 1;
    const s = (height ?? 1.6) / modelH;
    obj.scale.multiplyScalar(s);
    obj.position.y -= box.min.y * s;
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = true; m.receiveShadow = true;
      // warm clay for the species, cool grey for "you" — both solid, so the form reads
      m.material = new THREE.MeshStandardMaterial({ color: ghost ? 0xb9bec4 : 0xc9b8a4, roughness: 0.58, metalness: 0 });
      if (uncertain) { const mm = m.material as THREE.MeshStandardMaterial; mm.opacity = 0.45; mm.transparent = true; mm.depthWrite = false; }
    });
    return obj;
  }

  private async stageFigures(sp: Hominin, modern: Hominin, key: string) {
    for (const f of this.figs) this.stage.remove(f);
    this.figs = [];
    const hm = avg(modern.height_m) ?? 1.65;
    const proxy = sp.height_m?.unreviewed_proxy?.value;
    const hs = avg(sp.height_m) ?? (proxy ? (proxy[0] + proxy[1]) / 2 : null);
    const unknownBody = hs == null;
    const [a, b] = await Promise.all([
      unknownBody ? Promise.resolve(new THREE.Group()) : this.figure(key === "modern" ? "modern" : key, hs, false, !!proxy && avg(sp.height_m) == null),
      this.figure("modern", hm, true),
    ]);
    if (this.openKey !== key) return;
    a.position.x = -0.42; b.position.x = unknownBody ? 0 : 0.42;
    this.stage.add(a, b);
    this.figs = [a, b];
    // camera frames the taller of the two plus headroom
    const top = Math.max(hs ?? 1.6, hm) * 1.12;
    const dist = (top / 2) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.12;
    this.camera.position.set(0, top * 0.5, dist);
    this.camera.lookAt(0, top * 0.47, 0);
    // metre scale beside the stage (CSS, positioned by projection)
    const scale = this.el.querySelector(".sp-scale") as HTMLElement;
    scale.innerHTML = [0, 0.5, 1, 1.5, 2].filter((m) => m <= top).map((m) => `<span data-m="${m}"><i></i>${m % 1 ? "" : `${m} m`}</span>`).join("");
    this.layoutScale(top);
  }

  private layoutScale(top: number) {
    const H = this.canvas.clientHeight;
    for (const s of this.el.querySelectorAll<HTMLElement>(".sp-scale span")) {
      const m = Number(s.dataset.m);
      const p = new THREE.Vector3(0, m, 0).project(this.camera);
      s.style.transform = `translateY(${((-p.y * 0.5 + 0.5) * H).toFixed(1)}px)`;
    }
    void top;
  }

  private resize() {
    const r = this.renderer;
    if (!r) return;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    r.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}

/** Until a species model exists: a neutral mannequin so the comparison still reads. */
function fallbackFigure() {
  const g = new THREE.Group();
  const m = new THREE.MeshStandardMaterial({ color: 0xc9b8a4, roughness: 0.6 });
  const add = (geo: THREE.BufferGeometry, x: number, y: number, z = 0) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); g.add(o); };
  add(new THREE.SphereGeometry(0.11, 24, 16), 0, 1.6);
  add(new THREE.CapsuleGeometry(0.16, 0.42, 6, 16), 0, 1.2);
  for (const s of [-1, 1]) {
    add(new THREE.CapsuleGeometry(0.065, 0.72, 4, 12), s * 0.1, 0.48);
    add(new THREE.CapsuleGeometry(0.045, 0.56, 4, 12), s * 0.24, 1.12);
  }
  return g;
}
