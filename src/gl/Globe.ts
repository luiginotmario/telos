import * as THREE from "three";
import type { BodyDef } from "../bodies";
import type { Site, VisualN } from "../data";
import { TODAY_YEAR, resolveVisual } from "../data";
import { LINEAR_OUT, MAX_GLOWS, createPlanetMaterial, type PlanetUniforms } from "./planetMaterial";
import { elevationRange, loadMap, loadPaleo } from "./textures";
import { ATMOSPHERES, createAtmosphere } from "./atmosphere";

// Axial tilts (deg), NASA fact sheets. Moon: 6.68° to its orbit plane.
const TILT: Record<string, number> = {
  mercury: 0.03, venus: 177.4, earth: 23.44, moon: 6.68, mars: 25.19,
  jupiter: 3.13, saturn: 26.73, uranus: 97.77, neptune: 28.32,
};
// Mars ancient shoreline candidate: Deuteronilus contact ≈ −3760 m (Ivanov et al. 2017, Icarus).
const SEA_LEVEL: Record<string, number> = { mars: -3760 };
// Saturn ring texture span, fitted to ring features (C ring ≈ 72,200 km → F ring ≈ 140,500 km; R_eq = 60,268 km)
const RING_INNER = 72200 / 60268, RING_OUTER = 140500 / 60268;

const atmVert = /* glsl */ `
varying vec3 vN; varying vec3 vP;
void main(){ vN = normalize(mat3(modelMatrix)*normal); vec4 w = modelMatrix*vec4(position,1.0); vP = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`;
const atmFrag = /* glsl */ `
varying vec3 vN; varying vec3 vP;
uniform vec3 uCamPos; uniform vec3 uLightDir; uniform vec3 uTint; uniform float uStrength; uniform float uDark; uniform float uOpacity; uniform float uLinearOut;
void main(){
  vec3 N = normalize(vN), V = normalize(uCamPos - vP), L = normalize(uLightDir);
  float rim = 1.0 - abs(dot(N, V));
  // thin limb: rises sharply at the very edge, fades before the shell's own silhouette
  float a = pow(smoothstep(0.55, 1.0, rim), 3.0) * (1.0 - smoothstep(0.965, 1.0, rim));
  // only where sunlight reaches, with forward-scattering brightening toward the sun side
  float lit = smoothstep(-0.25, 0.45, dot(N, L));
  float fwd = pow(max(dot(-V, L), 0.0), 3.0);
  a *= lit * (0.75 + 0.6 * fwd) * uStrength * uOpacity;
  vec3 c = uTint * (uDark > 0.5 ? 1.1 : 1.0);
  if (uLinearOut > 0.5) c = pow(c, vec3(2.2));
  gl_FragColor = vec4(c, a * (uDark > 0.5 ? 0.85 : 0.28));
}`;

const ringVert = /* glsl */ `
varying vec2 vUv; varying vec3 vP;
void main(){ vUv = uv; vec4 w = modelMatrix*vec4(position,1.0); vP = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`;
const ringFrag = /* glsl */ `
varying vec2 vUv; varying vec3 vP;
uniform sampler2D uRing; uniform float uHas; uniform vec3 uLightDir; uniform vec3 uCenter; uniform float uRadius; uniform float uOpacity; uniform float uAmount;
void main(){
  float r = vUv.x;
  vec4 t = uHas > 0.5 ? texture2D(uRing, vec2(r, 0.5)) : vec4(vec3(0.85,0.78,0.65), 0.6*smoothstep(0.0,0.1,r)*smoothstep(1.0,0.9,r));
  // planet shadow on the rings: ray from fragment toward the sun hits the sphere?
  vec3 L = normalize(uLightDir); vec3 oc = vP - uCenter;
  float b = dot(oc, L); float c = dot(oc, oc) - uRadius*uRadius; float h = b*b - c;
  float shadow = (h > 0.0 && -b - sqrt(h) > 0.0) ? 0.12 : 1.0;
  gl_FragColor = vec4(t.rgb * shadow, t.a * uOpacity * uAmount);
}`;

export class Globe {
  readonly def: BodyDef;
  readonly root = new THREE.Group();   // position + scale
  readonly tilt = new THREE.Group();   // axial tilt
  readonly spin = new THREE.Group();   // rotation about the axis
  readonly mesh: THREE.Mesh;
  readonly u: PlanetUniforms;
  readonly atm: THREE.Mesh;
  /** the physical sky, for worlds with air (dark-space views) */
  phys: { mesh: THREE.Mesh; u: ReturnType<typeof createAtmosphere>["u"]; def: import("./atmosphere").AtmosphereDef; todayTint: THREE.Color } | null = null;
  readonly atmU: Record<string, THREE.IUniform>;
  ring?: THREE.Mesh;
  ringU?: Record<string, THREE.IUniform>;
  private paleo?: { slices: { ma: number; index: number }[] };
  private tier: "2k" | "4k" | null = null;
  private loading: Promise<void> | null = null;
  visual: VisualN;

  constructor(def: BodyDef, opts: { dark: boolean; segments?: number }) {
    this.def = def;
    const seg = opts.segments ?? 128;
    const geo = new THREE.SphereGeometry(1, seg, seg / 2);
    const { mat, u } = createPlanetMaterial(def.id.length * 13.37);
    this.u = u;
    u.uDarkSpace.value = opts.dark ? 1 : 0;
    u.uIsEarth.value = def.id === "earth" ? 1 : 0;
    u.uGas.value = def.gas ? 1 : 0;
    u.uSeaLevel.value = SEA_LEVEL[def.id] ?? 0;
    u.uTint.value.setRGB(...hex(def.tint));
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.scale.y = 1 - def.flattening;

    this.atmU = {
      uCamPos: { value: new THREE.Vector3() }, uLightDir: u.uLightDir, uTint: { value: new THREE.Color(0.6, 0.75, 1) },
      uStrength: { value: 0 }, uDark: { value: opts.dark ? 1 : 0 }, uOpacity: { value: 1 }, uLinearOut: LINEAR_OUT,
    };
    this.atm = new THREE.Mesh(
      new THREE.SphereGeometry(1.025, 96, 48),
      new THREE.ShaderMaterial({
        uniforms: this.atmU, vertexShader: atmVert, fragmentShader: atmFrag, transparent: true, depthWrite: false,
        side: THREE.FrontSide, blending: opts.dark ? THREE.AdditiveBlending : THREE.NormalBlending,
      }),
    );
    this.atm.scale.y = 1 - def.flattening;
    this.atm.renderOrder = 2;
    // worlds with air get the physical sky instead (in the dark-space views)
    const phys = opts.dark ? ATMOSPHERES[def.id] : undefined;
    if (phys) {
      const a = createAtmosphere(phys, u.uLightDir);
      // raw components, like the era visuals (no sRGB-to-linear conversion)
      const hexv = parseInt(phys.today.tint.slice(1), 16);
      this.phys = { ...a, def: phys, todayTint: new THREE.Color().setRGB(((hexv >> 16) & 255) / 255, ((hexv >> 8) & 255) / 255, (hexv & 255) / 255) };
      a.mesh.renderOrder = 2;
      this.atm = a.mesh;
      u.uPhysAtm.value = 1;
    }

    this.spin.add(this.mesh);
    this.tilt.add(this.spin, this.atm);
    this.tilt.rotation.z = -THREE.MathUtils.degToRad(TILT[def.id] ?? 0);
    this.root.add(this.tilt);

    if (def.id === "saturn") this.makeRing(opts.dark);

    this.visual = resolveVisual({ base: "today" });
    this.setVisual(this.visual);
  }

  private makeRing(dark: boolean) {
    const g = new THREE.RingGeometry(RING_INNER, RING_OUTER, 256, 1);
    // radial u so a 1D strip texture maps inner→outer
    const pos = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i));
      uv.setXY(i, (r - RING_INNER) / (RING_OUTER - RING_INNER), 0.5);
    }
    this.ringU = {
      uRing: { value: null }, uHas: { value: 0 }, uLightDir: this.u.uLightDir, uCenter: { value: new THREE.Vector3() },
      uRadius: { value: 1 }, uOpacity: { value: 1 }, uAmount: { value: 1 },
    };
    this.ring = new THREE.Mesh(g, new THREE.ShaderMaterial({
      uniforms: this.ringU, vertexShader: ringVert, fragmentShader: ringFrag, transparent: true, depthWrite: false,
      side: THREE.DoubleSide, blending: THREE.NormalBlending,
    }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.renderOrder = 3;
    void dark;
    this.tilt.add(this.ring);
  }

  /** Load textures at the given tier (2k first; 4k on demand when zoomed). */
  load(tier: "2k" | "4k" = "2k"): Promise<void> {
    if (this.tier === tier || (this.tier === "4k" && tier === "2k")) return this.loading ?? Promise.resolve();
    this.tier = tier;
    const id = this.def.id, u = this.u;
    const set = (t: THREE.Texture | null, tex: { value: THREE.Texture }, has: { value: number }) => {
      if (t) { tex.value = t; has.value = 1; }
    };
    this.loading = Promise.all([
      loadMap(id, "color", tier).then((t) => set(t, u.uColor, u.uHasColor)),
      id === "earth" ? loadMap(id, "night", tier).then((t) => set(t, u.uNight, u.uHasNight)) : null,
      id === "earth" ? loadMap(id, "clouds", tier).then((t) => set(t, u.uClouds, u.uHasClouds)) : null,
      id === "earth" ? loadMap(id, "specular", "2k").then((t) => set(t, u.uSpec, u.uHasSpec)) : null,
      id === "venus" ? loadMap(id, "atmosphere", tier).then((t) => set(t, u.uHazeTex, u.uHasHaze)) : null,
      !this.def.gas ? loadMap(id, "normal", tier).then((t) => set(t, u.uNormal, u.uHasNormal)) : null,
      id === "mars" || id === "moon" ? Promise.all([loadMap(id, "elevation", "2k"), elevationRange(id)]).then(([t, r]) => {
        if (t && r) { u.uElev.value = t; u.uHasElev.value = 1; u.uElevRange.value.set(r[0], r[1]); }
      }) : null,
      id === "earth" ? loadPaleo().then((p) => {
        if (!p) return;
        u.uPaleo.value = p.tex; u.uPaleoN.value = p.meta.slices.length;
        this.paleo = { slices: [...p.meta.slices].sort((a, b) => a.ma - b.ma) };
      }) : null,
      this.ring ? loadMap(id, "ring", "2k").then((t) => { if (t && this.ringU) { this.ringU.uRing.value = t; this.ringU.uHas.value = 1; } }) : null,
    ]).then(() => {});
    return this.loading;
  }

  setVisual(v: VisualN) {
    this.visual = v;
    const u = this.u;
    u.uLava.value = v.lava; u.uOcean.value = v.ocean; u.uIce.value = v.ice; u.uCloudAmt.value = v.clouds;
    u.uHaze.value = v.haze; u.uVeg.value = v.vegetation; u.uCraters.value = v.craters; u.uLights.value = v.lights;
    u.uDust.value = v.dust; u.uAtm.value = v.atmosphere; u.uBands.value = v.bands; u.uStorm.value = v.storm;
    u.uBaseMix.value = v.baseMix; u.uTintMix.value = v.tintMix;
    u.uAtmTint.value.setRGB(...v.atm); u.uSurfTint.value.setRGB(...v.tint);
    this.atmU.uTint.value.setRGB(...v.atm);
    this.atmU.uStrength.value = Math.min(1, v.atmosphere * 1.1);
    if (this.phys) {
      // eras scale today's air (thinner, thicker, hazier) relative to the timeline's present
      const p = this.phys;
      p.u.uDensity.value = Math.max(0, v.atmosphere / p.def.today.amount);
      const c = new THREE.Color().setRGB(...v.atm);
      p.u.uTint.value.setRGB(c.r / Math.max(0.05, p.todayTint.r), c.g / Math.max(0.05, p.todayTint.g), c.b / Math.max(0.05, p.todayTint.b));
    }
    if (this.ringU) this.ringU.uAmount.value = this.def.id === "saturn" ? (v.rings || (v.baseMix > 0.5 ? 1 : 0)) : v.rings;
  }

  /** Earth only: continuous paleogeography from the Scotese & Wright slices. */
  setYear(year: number) {
    if (!this.paleo) { this.u.uPaleoMix.value = 0; return; }
    const ma = (TODAY_YEAR - year) / 1e6;
    const s = this.paleo.slices;
    const last = s[s.length - 1];
    if (ma > last.ma + 15 || ma < 0) { this.u.uPaleoMix.value = 0; return; }
    let a = s[0], b = s[0];
    for (let i = 0; i < s.length - 1; i++) if (ma >= s[i].ma && ma <= s[i + 1].ma) { a = s[i]; b = s[i + 1]; break; }
    if (ma > last.ma) { a = b = last; }
    const t = b.ma === a.ma ? 0 : (ma - a.ma) / (b.ma - a.ma);
    this.u.uPaleo3.value.set(a.index, b.index, t);
    // fade in from today's maps over the last ~2 Myr, fade out past the oldest slice
    const fadeIn = THREE.MathUtils.smoothstep(ma, 0.02, 2.0);
    const fadeOut = 1 - THREE.MathUtils.smoothstep(ma, last.ma, last.ma + 15);
    this.u.uPaleoMix.value = fadeIn * fadeOut;
  }

  setGlows(sites: (Site & { glow: number })[]) {
    const arr = this.u.uGlows.value;
    let n = 0;
    for (const s of sites) {
      if (n >= MAX_GLOWS || s.glow <= 0.001) continue;
      const d = latLonToDir(s.lat, s.lon);
      arr[n++].set(d.x, d.y, d.z, s.glow);
    }
    this.u.uGlowCount.value = n;
  }

  setOpacity(o: number) {
    this.u.uOpacity.value = o;
    this.atmU.uOpacity.value = o;
    if (this.phys) this.phys.u.uOpacity.value = o;
    if (this.ringU) this.ringU.uOpacity.value = o;
    this.tilt.visible = o > 0.002;
  }

  update(t: number, cam: THREE.Camera) {
    this.u.uTime.value = t;
    const cp = cam.getWorldPosition(tmp);
    this.u.uCamPos.value.copy(cp);
    (this.atmU.uCamPos.value as THREE.Vector3).copy(cp);
    if (this.ringU) {
      this.root.getWorldPosition(this.ringU.uCenter.value);
      this.ringU.uRadius.value = this.root.getWorldScale(tmp).x;
    }
  }
}

const tmp = new THREE.Vector3();
function hex(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Matches THREE.SphereGeometry's UV layout with lon −180 at u = 0. */
export function latLonToDir(lat: number, lon: number, out = new THREE.Vector3()) {
  const phi = ((lon + 180) / 360) * Math.PI * 2;
  const la = THREE.MathUtils.degToRad(lat);
  return out.set(-Math.cos(phi) * Math.cos(la), Math.sin(la), Math.sin(phi) * Math.cos(la));
}
