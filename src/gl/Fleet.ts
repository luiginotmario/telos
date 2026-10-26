import * as THREE from "three";
import * as Astro from "astronomy-engine";
import { eqjToWorld } from "./Sky";

/**
 * Earth → Mars Starship fleets, flown on real transfer geometry.
 *
 * Windows: each Mars opposition (astronomy-engine) is preceded by a departure window; a
 * Hohmann-class transfer leaves when Mars leads Earth by ~44°, about 100 days before
 * opposition. We fly a ~210-day transfer (SpaceX has described fast transfers of ~6 months).
 * The trajectory is the conic through Earth's position at departure (perihelion) and Mars's
 * true position at arrival; ships advance along it by Kepler's equation, so they leave fast and
 * slow toward Mars, and arrive exactly where Mars is.
 *
 * Fleet sizes: 2026 has none (SpaceX moved its near-term focus to the Moon, 8 Feb 2026).
 * From 2031 the counts are an illustrative ramp to SpaceX's stated goal of ~1,000 Starships
 * per window (Elon Musk, Jan 2020), labelled as a projection in the UI.
 */
export interface Window {
  launch: Date; arrive: Date; opposition: Date;
  ships: number; note: string;
}

const DAY = 86400000;
const FLEET: Record<number, [number, string]> = {
  2026: [0, "No Starships fly: SpaceX moved its near-term focus to the Moon (Feb 2026)"],
  2028: [0, "No crewed or cargo Starships planned this window"],
  2031: [2, "First uncrewed cargo Starships (projected)"],
  2033: [4, "More cargo, first crews possible (projected)"],
  2035: [8, "Fleet grows (projected)"],
  2037: [24, "Fleet grows (projected)"],
  2039: [60, "Fleet grows (projected)"],
  2041: [140, "Fleet grows (projected)"],
  2043: [280, "Fleet grows (projected)"],
  2045: [500, "Toward 1,000 per window (projected)"],
  2048: [760, "Toward 1,000 per window (projected)"],
  2050: [1000, "SpaceX's goal: ~1,000 Starships per window"],
};

export function computeWindows(from = new Date(Date.UTC(2026, 0, 1)), until = 2051): Window[] {
  const out: Window[] = [];
  let t = Astro.MakeTime(from);
  for (let i = 0; i < 16; i++) {
    const opp = Astro.SearchRelativeLongitude(Astro.Body.Mars, 0, t);
    const o = opp.date;
    const launch = new Date(o.getTime() - 100 * DAY);
    if (launch.getUTCFullYear() >= until) break;
    const arrive = new Date(launch.getTime() + 210 * DAY);
    const y = launch.getUTCFullYear();
    const key = Object.keys(FLEET).map(Number).reduce((best, k) => (Math.abs(k - y) < Math.abs(best - y) ? k : best), 2026);
    const [ships, note] = FLEET[key];
    out.push({ launch, arrive, opposition: o, ships, note });
    t = opp.AddDays(30);
  }
  return out;
}

/** Conic through r1 (perihelion, at angle φ1) and r2 at φ1+Δ; returns position at true anomaly ν. */
function transfer(p1: THREE.Vector3, p2: THREE.Vector3) {
  const r1 = Math.hypot(p1.x, p1.z), r2 = Math.hypot(p2.x, p2.z);
  const phi1 = Math.atan2(p1.z, p1.x);
  let d = Math.atan2(p2.z, p2.x) - phi1;
  // prograde (counter-clockwise seen from ecliptic north = +Y … our frame has z = −y_ecl)
  while (d > 0) d -= Math.PI * 2;
  const D = -d;                                   // sweep angle, 0..2π
  const e = (r2 - r1) / (r1 - r2 * Math.cos(D));
  const p = r1 * (1 + e);
  const mAt = (nu: number) => {                   // mean anomaly at true anomaly ν
    const E = 2 * Math.atan(Math.sqrt((1 - e) / (1 + e)) * Math.tan(nu / 2));
    return E - e * Math.sin(E);
  };
  const mEnd = mAt(D);
  const at = (s: number, out: THREE.Vector3) => {
    // invert time fraction → ν by bisection (monotonic)
    let lo = 0, hi = D;
    const target = s * mEnd;
    for (let k = 0; k < 22; k++) { const mid = (lo + hi) / 2; if (mAt(mid) < target) lo = mid; else hi = mid; }
    const nu = (lo + hi) / 2;
    const r = p / (1 + e * Math.cos(nu));
    const ang = phi1 - nu;
    return out.set(Math.cos(ang) * r, p1.y + (p2.y - p1.y) * s, Math.sin(ang) * r);
  };
  return { at, valid: e > 0 && e < 1 && D > 1.5 && D < 3.6 };
}

const pointVert = /* glsl */ `
attribute float aSeed; uniform float uScale; uniform float uSize;
varying float vA;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uScale * uSize * (1.6 + aSeed * 1.0);
  vA = 0.75 + 0.25 * aSeed;
}`;
const pointFrag = /* glsl */ `
varying float vA;
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0; float d = dot(p, p);
  float a = exp(-d * 5.0) * vA;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vec3(1.0, 0.93, 0.82) * a, a);
}`;

export class Fleet {
  readonly group = new THREE.Group();
  readonly windows = computeWindows();
  private arcs: (ReturnType<typeof transfer> | null)[] = [];
  private paths: THREE.Line[] = [];
  private pts: THREE.Points;
  private trails: THREE.LineSegments;
  private seeds: Float32Array;
  private u = { uScale: { value: 1 }, uSize: { value: 1 } };
  private max = 1100;

  constructor() {
    const pos = new Float32Array(this.max * 3);
    this.seeds = new Float32Array(this.max).map(() => Math.random());
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(this.seeds, 1));
    this.pts = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: this.u, vertexShader: pointVert, fragmentShader: pointFrag,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.pts.frustumCulled = false;
    const tg = new THREE.BufferGeometry();
    tg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.max * 6), 3));
    this.trails = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ color: 0xffd9a8, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.trails.frustumCulled = false;
    this.group.add(this.pts, this.trails);

    for (const w of this.windows) {
      const e = Astro.HelioVector(Astro.Body.Earth, Astro.MakeTime(w.launch));
      const m = Astro.HelioVector(Astro.Body.Mars, Astro.MakeTime(w.arrive));
      const arc = transfer(eqjToWorld(e.x, e.y, e.z), eqjToWorld(m.x, m.y, m.z));
      this.arcs.push(arc.valid ? arc : null);
      // the route itself, faint and dashed — visible only during its window
      const pts: THREE.Vector3[] = [];
      if (arc.valid) for (let i = 0; i <= 160; i++) pts.push(arc.at(i / 160, new THREE.Vector3()));
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: 0xffe2bd, dashSize: 0.05, gapSize: 0.04, transparent: true, opacity: 0, depthWrite: false }));
      line.computeLineDistances();
      line.visible = false;
      this.paths.push(line);
      this.group.add(line);
    }
  }

  /** Where to look for window `i`: the middle of its route, so departure and arrival both frame. */
  centre(i: number, out = new THREE.Vector3()) {
    const arc = this.arcs[i];
    if (!arc) return out.set(0, 0, 0);
    // the route bows around the Sun; aim just inside its midpoint, not at the chord's centroid
    return arc.at(0.55, out).multiplyScalar(0.82);
  }

  /** The window whose departure-to-arrival span contains `d` (or the nearest upcoming). */
  windowAt(d: Date) {
    const t = d.getTime();
    return this.windows.findIndex((w) => t >= w.launch.getTime() - 40 * DAY && t <= w.arrive.getTime() + 25 * DAY);
  }

  setDate(d: Date) {
    const t = d.getTime();
    const pos = this.pts.geometry.attributes.position as THREE.BufferAttribute;
    const tr = this.trails.geometry.attributes.position as THREE.BufferAttribute;
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    let n = 0;
    // a handful of ships must still read: early fleets draw larger, with longer trails
    const flying = this.windows.find((w) => t > w.launch.getTime() && t < w.arrive.getTime() + 40 * DAY)?.ships ?? 0;
    const few = 1 - THREE.MathUtils.smoothstep(flying, 0, 240);
    this.u.uSize.value = 1 + 1.6 * few;
    const trail = 0.01 + 0.035 * few;
    (this.trails.material as THREE.LineBasicMaterial).opacity = 0.16 + 0.4 * few;
    this.windows.forEach((w, i) => {
      const arc = this.arcs[i];
      const line = this.paths[i];
      const span = w.arrive.getTime() - w.launch.getTime();
      // routes fade in ahead of the window and out after the last arrival
      const vis = arc && w.ships > 0 ? THREE.MathUtils.smoothstep(t, w.launch.getTime() - 60 * DAY, w.launch.getTime()) * (1 - THREE.MathUtils.smoothstep(t, w.arrive.getTime() + 20 * DAY, w.arrive.getTime() + 80 * DAY)) : 0;
      line.visible = vis > 0.01;
      (line.material as THREE.LineDashedMaterial).opacity = vis * 0.28;
      if (!arc || !w.ships) return;
      // departures spread over ~a month; a few days apart in the early, small fleets
      const spread = Math.min(34, 6 + w.ships * 0.04) * DAY;
      for (let k = 0; k < w.ships && n < this.max; k++) {
        const dep = w.launch.getTime() + (k / Math.max(1, w.ships - 1)) * spread * (this.seeds[n] * 0.4 + 0.8);
        const s = (t - dep) / span;
        if (s <= 0 || s >= 1) continue;
        arc.at(s, a);
        // fan the fleet into a ribbon so it reads as many ships, not one line
        const fan = (this.seeds[n] - 0.5) * 0.09 * Math.sin(Math.PI * s) * Math.min(1, w.ships / 60);
        a.y += fan * 0.6; a.x += fan * Math.cos(n); a.z += fan * Math.sin(n);
        pos.setXYZ(n, a.x, a.y, a.z);
        arc.at(Math.max(0, s - trail), b);
        b.y += fan * 0.6; b.x += fan * Math.cos(n); b.z += fan * Math.sin(n);
        tr.setXYZ(n * 2, a.x, a.y, a.z); tr.setXYZ(n * 2 + 1, b.x, b.y, b.z);
        n++;
      }
    });
    this.pts.geometry.setDrawRange(0, n);
    this.trails.geometry.setDrawRange(0, n * 2);
    pos.needsUpdate = true; tr.needsUpdate = true;
    return n;
  }

  update() { this.u.uScale.value = Math.min(devicePixelRatio, 2); }
}
