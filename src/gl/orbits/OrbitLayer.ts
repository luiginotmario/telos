import * as THREE from "three";
import * as Astro from "astronomy-engine";
import type { Globe } from "../Globe";
import { LINEAR_OUT } from "../planetMaterial";

/**
 * Everything humans keep in Earth orbit, from CelesTrak's public element sets: ~11k Starlink,
 * OneWeb, the other active satellites, navigation constellations in MEO, the geostationary belt,
 * the four great debris clouds, and the crewed stations.
 *
 * Each object is propagated on the GPU every frame (Kepler's equation + the J2 secular drift of
 * node and perigee) and turned from inertial to Earth-fixed by Greenwich sidereal time, so every
 * satellite sits over the ground it is really over. Objects in Earth's shadow go dark.
 */
export const ORBIT_WARP = 30;           // overview time runs ×30 so LEO visibly moves (labelled)
export const KIND = { starlink: 0, oneweb: 1, leo: 2, meo: 3, geo: 4, debris: 5, station: 6, heo: 7 } as const;

interface Meta { epoch: string; count: number; stride: number; counts: Record<string, number>; named: Record<string, number> }

// shared: elements → globe-frame position, colour, size and visibility per object
const COMMON = /* glsl */ `
attribute vec4 aE0;   // a [R⊕], e, i, raan0
attribute vec4 aE1;   // argp0, M0, n [rad/min], raanDot
attribute vec4 aE2;   // argpDot, t0 [min], kind, year
uniform float uT; uniform float uGmst; uniform vec3 uSun; uniform float uYear; uniform float uScale;
uniform float uFade; uniform float uFocus; uniform float uZoom;
uniform float uHide;        // object index to hide (the station being shown close up), or -1
uniform float uIss; uniform float uIssEnd;   // the ISS's index, and the year it re-enters

vec3 eci(float dtm){
  float a = aE0.x, e = aE0.y, inc = aE0.z;
  float raan = aE0.w + aE1.w * dtm;
  float argp = aE1.x + aE2.x * dtm;
  float M = mod(aE1.y + aE1.z * dtm, 6.28318530718);
  float E = M + e * sin(M);
  for (int k = 0; k < 5; k++) E -= (E - e * sin(E) - M) / (1.0 - e * cos(E));
  float xp = a * (cos(E) - e), yp = a * sqrt(1.0 - e * e) * sin(E);
  float cO = cos(raan), sO = sin(raan), cw = cos(argp), sw = sin(argp), ci = cos(inc), si = sin(inc);
  return vec3((cO*cw - sO*sw*ci) * xp + (-cO*sw - sO*cw*ci) * yp,
              (sO*cw + cO*sw*ci) * xp + (-sO*sw + cO*cw*ci) * yp,
              (sw*si) * xp + (cw*si) * yp);
}

// position in the globe's Earth-fixed frame, "back" minutes ago (the Earth turns meanwhile)
vec3 place(float back){
  vec3 r = eci(uT - back - aE2.y);
  float g = uGmst - back * 0.00437526951;          // sidereal rate, rad/min
  float cg = cos(g), sg = sin(g);
  vec3 ef = vec3(cg * r.x + sg * r.y, -sg * r.x + cg * r.y, r.z);
  return vec3(ef.x, ef.z, -ef.y);                    // see latLonToDir
}

// colour, point size and opacity for this object at this place
float styleOf(vec3 p, float id, out vec3 col, out float size){
  float kind = aE2.z;
  if (abs(id - uHide) < 0.5 || (abs(id - uIss) < 0.5 && uYear > uIssEnd)) { col = vec3(0.0); size = 0.0; return 0.0; }
  float born = smoothstep(aE2.w - 0.2, aE2.w + 0.6, uYear);   // only what was up there by this year
  float s = dot(p, uSun);                                       // Earth's cylindrical shadow
  float lit = (s > 0.0 || length(p - s * uSun) > 1.0) ? 1.0 : 0.1;
  col = vec3(1.0, 0.95, 0.86);
  size = 2.6;
  float a = 0.9;
  if (kind < 0.5) { col = vec3(0.84, 0.92, 1.0); size = 2.4; a = 0.85; }            // Starlink
  else if (kind < 1.5) { col = vec3(0.9, 0.95, 1.0); size = 2.4; }                   // OneWeb
  else if (kind > 2.5 && kind < 3.5) { col = vec3(0.78, 1.0, 0.88); size = 3.0; }    // GNSS
  else if (kind > 3.5 && kind < 4.5) { col = vec3(1.0, 0.88, 0.66); size = 3.0; }    // GEO
  else if (kind > 4.5 && kind < 5.5) { col = vec3(1.0, 0.58, 0.4); size = 2.0; a = 0.7; } // debris
  else if (kind > 5.5 && kind < 6.5) { col = vec3(1.0); size = 7.0; a = 1.0; lit = max(lit, 0.6); } // stations
  a *= mix(1.0, kind > 5.5 ? 1.0 : 0.35, uFocus);     // close to a station, the swarm steps back
  size *= mix(1.0, 1.7, clamp((uZoom - 1.0) / 1.5, 0.0, 1.0));
  return a * lit * born * uFade;
}
`;

const vert = /* glsl */ `
${COMMON}
varying vec3 vCol; varying float vA;
void main(){
  vec3 p = place(0.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  float size;
  vA = styleOf(p, float(gl_VertexID), vCol, size);
  gl_PointSize = size * uScale;
  if (vA < 0.004) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // cull
}`;

const frag = /* glsl */ `
varying vec3 vCol; varying float vA;
uniform float uLinearOut;
void main(){
  // a crisp lit core in a faint dark halo: reads over cloud tops and over black space alike
  float d = length(gl_PointCoord * 2.0 - 1.0);
  float core = smoothstep(0.62, 0.18, d);
  float halo = smoothstep(1.0, 0.45, d);
  float a = (core + 0.35 * halo * (1.0 - core)) * vA;
  if (a < 0.008) discard;
  vec3 c = vCol;
  if (uLinearOut > 0.5) c = pow(c, vec3(2.2));
  gl_FragColor = vec4(c * core * vA, a);   // premultiplied
}`;

// a short streak behind each object: where it was over the last minutes of its orbit
const trailVert = /* glsl */ `
${COMMON}
attribute float aTail;
uniform float uTrail;
varying vec3 vCol; varying float vA;
void main(){
  // only near-circular low orbits streak: high and eccentric ones would draw long chords
  float back = aTail * uTrail;
  vec3 p = place(back);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  float size;
  float head = styleOf(place(0.0), float(gl_VertexID / 2), vCol, size);
  vA = head * (1.0 - aTail) * 0.38;
  // cull both ends together (one end alone would stretch the line to the cull point)
  if (head < 0.004 || aE1.z < 0.03 || aE0.y > 0.03) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

const trailFrag = /* glsl */ `
varying vec3 vCol; varying float vA;
uniform float uLinearOut;
void main(){
  vec3 c = vCol;
  if (uLinearOut > 0.5) c = pow(c, vec3(2.2));
  gl_FragColor = vec4(c * vA, vA);
}`;

export class OrbitLayer {
  readonly group = new THREE.Group();
  meta: Meta | null = null;
  private data: Float32Array | null = null;
  private epochMs = 0;
  /** simulated time (ms) — real "now" at load, then running at `warp` × real time */
  simMs = Date.now();
  warp = ORBIT_WARP;
  readonly u = {
    uT: { value: 0 }, uGmst: { value: 0 }, uSun: { value: new THREE.Vector3(1, 0, 0) }, uYear: { value: 2026 },
    uScale: { value: 1 }, uFade: { value: 0 }, uFocus: { value: 0 }, uZoom: { value: 1 }, uTrail: { value: 1.7 },
    uHide: { value: -1 }, uIss: { value: -1 }, uIssEnd: { value: 2030.95 },
    uLinearOut: LINEAR_OUT,
  };
  private ready: Promise<void>;

  constructor(private globe: Globe) {
    globe.spin.add(this.group);
    this.group.renderOrder = 5;
    this.ready = this.load();
  }

  whenReady() { return this.ready; }

  private async load() {
    const [meta, buf] = await Promise.all([
      fetch("/orbits/catalog.json").then((r) => r.json() as Promise<Meta>),
      fetch("/orbits/catalog.bin").then((r) => r.arrayBuffer()),
    ]);
    const f = new Float32Array(buf);
    this.meta = meta; this.data = f;
    this.u.uIss.value = meta.named.ISS ?? -1;
    this.epochMs = Date.parse(meta.epoch);
    const ib = new THREE.InterleavedBuffer(f, meta.stride);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.InterleavedBufferAttribute(ib, 3, 0));
    g.setAttribute("aE0", new THREE.InterleavedBufferAttribute(ib, 4, 0));
    g.setAttribute("aE1", new THREE.InterleavedBufferAttribute(ib, 4, 4));
    g.setAttribute("aE2", new THREE.InterleavedBufferAttribute(ib, 4, 8));
    const pts = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: this.u, vertexShader: vert, fragmentShader: frag,
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    }));
    pts.frustumCulled = false;
    pts.renderOrder = 5;

    // trails: two vertices per object, head (aTail 0) and tail (aTail 1)
    const n = meta.count, st = meta.stride;
    const el = new Float32Array(n * 2 * st), tail = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      el.set(f.subarray(i * st, i * st + st), i * 2 * st);
      el.set(f.subarray(i * st, i * st + st), (i * 2 + 1) * st);
      tail[i * 2 + 1] = 1;
    }
    const tb = new THREE.InterleavedBuffer(el, st);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute("position", new THREE.InterleavedBufferAttribute(tb, 3, 0));
    tg.setAttribute("aE0", new THREE.InterleavedBufferAttribute(tb, 4, 0));
    tg.setAttribute("aE1", new THREE.InterleavedBufferAttribute(tb, 4, 4));
    tg.setAttribute("aE2", new THREE.InterleavedBufferAttribute(tb, 4, 8));
    tg.setAttribute("aTail", new THREE.BufferAttribute(tail, 1));
    const trails = new THREE.LineSegments(tg, new THREE.ShaderMaterial({
      uniforms: this.u, vertexShader: trailVert, fragmentShader: trailFrag,
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    }));
    trails.frustumCulled = false;
    trails.renderOrder = 4;
    this.group.add(trails, pts);
  }

  /** Minutes since the catalogue epoch at simulated time. */
  get tMin() { return (this.simMs - this.epochMs) / 60000; }

  /** Greenwich sidereal angle (rad) at simulated time. */
  gmst(ms = this.simMs) { return (Astro.SiderealTime(new Date(ms)) / 24) * Math.PI * 2; }

  /** CPU twin of the shader: an object's position in the globe frame (Earth radii). */
  positionOf(index: number, out = new THREE.Vector3(), ms = this.simMs) {
    const f = this.data;
    if (!f) return out.set(0, 0, 0);
    const o = index * 12;
    const [a, e, inc, raan0, argp0, M0, n, raanDot, argpDot, t0] = f.subarray(o, o + 10);
    const dtm = (ms - this.epochMs) / 60000 - t0;
    const raan = raan0 + raanDot * dtm, argp = argp0 + argpDot * dtm;
    const M = (((M0 + n * dtm) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    let E = M + e * Math.sin(M);
    for (let k = 0; k < 6; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
    const cO = Math.cos(raan), sO = Math.sin(raan), cw = Math.cos(argp), sw = Math.sin(argp), ci = Math.cos(inc), si = Math.sin(inc);
    const x = (cO * cw - sO * sw * ci) * xp + (-cO * sw - sO * cw * ci) * yp;
    const y = (sO * cw + cO * sw * ci) * xp + (-sO * sw + cO * cw * ci) * yp;
    const z = sw * si * xp + cw * si * yp;
    const g = this.gmst(ms), cg = Math.cos(g), sg = Math.sin(g);
    const ex = cg * x + sg * y, ey = -sg * x + cg * y;
    return out.set(ex, z, -ey);
  }

  /** Index of a named object (ISS, Tiangong), or -1. */
  index(name: string) { return this.meta?.named[name] ?? -1; }

  update(dt: number, year: number, fade: number, focus: number, sunWorld: THREE.Vector3, zoom = 1) {
    this.simMs += dt * 1000 * this.warp;
    const u = this.u;
    u.uT.value = this.tMin;
    u.uGmst.value = this.gmst();
    u.uYear.value = year;
    u.uFade.value = fade;
    u.uFocus.value = focus;
    u.uZoom.value = zoom;
    u.uScale.value = Math.min(devicePixelRatio, 2);
    // the globe's light, in the spinning frame the satellites live in
    const q = this.globe.spin.getWorldQuaternion(new THREE.Quaternion()).invert();
    u.uSun.value.copy(sunWorld).applyQuaternion(q).normalize();
    this.group.visible = fade > 0.005;
  }
}
