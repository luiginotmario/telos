import * as THREE from "three";
import * as Astro from "astronomy-engine";
import { loadMap, loadUrl } from "./textures";

const EQJ_ECL = Astro.Rotation_EQJ_ECL();

/** EQJ (J2000 equator) vector → three.js world: ecliptic plane = XZ, ecliptic north = +Y. */
export function eqjToWorld(x: number, y: number, z: number, out = new THREE.Vector3()) {
  const v = Astro.RotateVector(EQJ_ECL, new Astro.Vector(x, y, z, new Astro.AstroTime(0)));
  return out.set(v.x, v.z, -v.y);
}

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
  gl_Position.z = gl_Position.w * 0.99999;          // always behind everything
  float flux = pow(10.0, -0.4 * (aMag - 1.0));
  gl_PointSize = clamp(uScale * (1.6 + 2.6 * sqrt(flux)), 1.5, 11.0);
  vA = clamp(0.32 + 1.1 * sqrt(flux), 0.0, 1.0) * uFade;
  vCol = mix(vec3(1.0), bvToRgb(aCi), 0.55);
}`;
const starFrag = /* glsl */ `
varying vec3 vCol; varying float vA;
uniform float uLinearOut;
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0; float d = dot(p, p);
  float a = exp(-d * 4.0) * vA;
  if (a < 0.003) discard;
  vec3 c = vCol;
  if (uLinearOut > 0.5) c = pow(c, vec3(2.2));
  gl_FragColor = vec4(c * a, a);
}`;

/**
 * The real sky: HYG v4.1 stars to magnitude 7 (true positions and colours) over NASA SVS's
 * Deep Star Maps Milky Way, both in J2000 equatorial coordinates. It follows the camera and
 * draws behind everything, so it works at any scene scale.
 */
export class Sky {
  readonly group = new THREE.Group();
  readonly u = { uScale: { value: 1 }, uFade: { value: 1 }, uLinearOut: { value: 0 } };
  private mwFade = { value: 1 };

  constructor(linearOut?: { value: number }) {
    if (linearOut) this.u.uLinearOut = linearOut;
    this.group.renderOrder = -100;
    this.group.frustumCulled = false;
    void this.load();
  }

  private async load() {
    try {
      const [meta, buf] = await Promise.all([
        fetch("/stars-meta.json").then((r) => r.json()),
        fetch("/stars.bin").then((r) => r.arrayBuffer()),
      ]);
      const f = new Float32Array(buf);
      const stride: number = meta.stride ?? 5;
      const count = Math.floor(f.length / stride);
      const pos = new Float32Array(count * 3), mag = new Float32Array(count), ci = new Float32Array(count);
      const v = new THREE.Vector3();
      for (let i = 0; i < count; i++) {
        const o = i * stride;
        eqjToWorld(f[o], f[o + 1], f[o + 2], v);
        pos.set([v.x, v.y, v.z], i * 3);
        mag[i] = f[o + 3]; ci[i] = f[o + 4];
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("aMag", new THREE.BufferAttribute(mag, 1));
      g.setAttribute("aCi", new THREE.BufferAttribute(ci, 1));
      const pts = new THREE.Points(g, new THREE.ShaderMaterial({
        uniforms: this.u, vertexShader: starVert, fragmentShader: starFrag,
        transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
      }));
      pts.frustumCulled = false;
      pts.renderOrder = -99;
      this.group.add(pts);
    } catch { /* stars optional */ }

    let mw: THREE.Texture | null = await loadMap("sky", "color", "4k").catch(() => null);
    if (!mw) for (const url of ["/textures/milkyway-4k.webp", "/textures/milkyway-2k.webp"]) {
      mw = await loadUrl(url);
      if (mw) break;
    }
    if (!mw) return;
    mw.colorSpace = THREE.NoColorSpace;
    const w2e = new THREE.Matrix3();
    const ex = eqjToWorld(1, 0, 0), ey = eqjToWorld(0, 1, 0), ez = eqjToWorld(0, 0, 1);
    w2e.set(ex.x, ex.y, ex.z, ey.x, ey.y, ey.z, ez.x, ez.y, ez.z);
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), new THREE.ShaderMaterial({
      uniforms: { uTex: { value: mw }, uFade: this.mwFade, uToEqj: { value: w2e }, uLinearOut: this.u.uLinearOut },
      vertexShader: `varying vec3 vD; void main(){ vD = position; vec4 p = projectionMatrix*modelViewMatrix*vec4(position,1.0); gl_Position = p; gl_Position.z = p.w * 0.999995; }`,
      fragmentShader: `
        varying vec3 vD; uniform sampler2D uTex; uniform float uFade; uniform mat3 uToEqj; uniform float uLinearOut;
        void main(){
          vec3 d = normalize(uToEqj * normalize(vD));
          float ra = atan(d.y, d.x); float dec = asin(clamp(d.z, -1.0, 1.0));
          // NASA SVS Deep Star Maps: RA increases to the left, 0h at centre
          vec3 c = texture2D(uTex, vec2(0.5 - ra / 6.28318530718, 0.5 + dec / 3.14159265)).rgb;
          c = max(c - 0.035, 0.0) * 1.1;                 // drop the map's noise floor: deep space stays black
          c = c * c * 1.6 * uFade;
          if (uLinearOut > 0.5) c = pow(c, vec3(2.2));
          gl_FragColor = vec4(c, 1.0);
        }`,
      side: THREE.BackSide, depthWrite: false, depthTest: false,
    }));
    m.renderOrder = -100;
    m.frustumCulled = false;
    this.group.add(m);
  }

  /** Keep the sky centred on the camera and inside its far plane. */
  update(cam: THREE.PerspectiveCamera, fade = 1) {
    this.group.position.copy(cam.position);
    this.group.scale.setScalar(cam.far * 0.5);
    this.u.uScale.value = Math.min(devicePixelRatio, 2);
    this.u.uFade.value = fade;
    this.mwFade.value = fade;
  }
}
