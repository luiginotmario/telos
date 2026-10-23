import * as THREE from "three";
import { NOISE } from "../noise.glsl";

// ── plume ───────────────────────────────────────────────────────

const plumeVert = /* glsl */ `
varying vec2 vUv; varying vec3 vN; varying vec3 vP;
void main(){ vUv = uv; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.0); vP = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const plumeFrag = /* glsl */ `
varying vec2 vUv; varying vec3 vN; varying vec3 vP;
uniform float uT; uniform float uThrottle; uniform vec3 uCam;
${NOISE}
void main(){
  float along = 1.0 - vUv.y;          // 0 at the nozzle → 1 at the tip
  vec3 V = normalize(uCam - vP);
  float edge = pow(abs(dot(normalize(vN), V)), 1.6);
  float n = snoise(vec3(vUv.x * 9.0, along * 6.0 - uT * 22.0, uT * 3.0)) * 0.5 + 0.5;
  // methalox in thin CO2: blue-white core near the bells, warming to orange where it spreads
  vec3 core = vec3(0.75, 0.85, 1.0), hot = vec3(1.0, 0.62, 0.28);
  vec3 c = mix(core, hot, smoothstep(0.05, 0.6, along));
  float a = edge * (1.0 - smoothstep(0.2, 1.0, along)) * (0.55 + 0.45 * n) * uThrottle;
  // shock diamonds near the exit
  a += edge * exp(-pow(fract(along * 7.0) - 0.5, 2.0) * 60.0) * (1.0 - smoothstep(0.0, 0.35, along)) * 0.35 * uThrottle;
  gl_FragColor = vec4(c * a * 1.6, a);
}`;

export function createPlume() {
  const u = { uT: { value: 0 }, uThrottle: { value: 0 }, uCam: { value: new THREE.Vector3() } };
  const geo = new THREE.CylinderGeometry(0.0022, 0.0075, 0.06, 32, 1, true);
  geo.translate(0, -0.03, 0);
  const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
    uniforms: u, vertexShader: plumeVert, fragmentShader: plumeFrag,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  }));
  mesh.renderOrder = 5;
  return { mesh, u };
}

// ── dust kicked up on touchdown ─────────────────────────────────

const dustVert = /* glsl */ `
attribute vec3 aVel; attribute float aBorn; attribute float aSeed;
uniform float uT; uniform float uScale; uniform vec3 uSun;
varying float vA; varying float vLit;
void main(){
  float age = uT - aBorn;
  float alive = step(0.0, age) * step(age, 14.0);
  // drag in thin air: x(t) = v·τ·(1 − e^(−t/τ)), plus a slow settling
  float tau = 1.6 + aSeed * 1.2;
  vec3 p = position + aVel * tau * (1.0 - exp(-age / tau));
  p.z += -0.00025 * age * age * 0.1;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float size = (0.004 + 0.018 * (1.0 - exp(-age / 3.0))) * (0.6 + aSeed);
  gl_PointSize = clamp(size * uScale / -mv.z, 1.0, 220.0);
  vA = alive * smoothstep(0.0, 0.4, age) * (1.0 - smoothstep(4.0, 14.0, age)) * 0.32;
  vLit = 0.75 + 0.25 * aSeed;
}`;
const dustFrag = /* glsl */ `
varying float vA; varying float vLit;
uniform vec3 uColor;
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0; float d = dot(p, p);
  float a = exp(-d * 2.5) * vA;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor * vLit, a);
}`;

export function createDust(count = 1600) {
  const pos = new Float32Array(count * 3), vel = new Float32Array(count * 3), born = new Float32Array(count), seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * 0.006;
    pos.set([Math.cos(a) * r, Math.sin(a) * r, 0.0005], i * 3);
    const sp = 0.02 + Math.random() * 0.06; // km/s outward
    vel.set([Math.cos(a) * sp, Math.sin(a) * sp, 0.002 + Math.random() * 0.01], i * 3);
    born[i] = Math.random() * 3.5;          // spread over the last seconds of the burn
    seed[i] = Math.random();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("aVel", new THREE.BufferAttribute(vel, 3));
  g.setAttribute("aBorn", new THREE.BufferAttribute(born, 1));
  g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
  const u = { uT: { value: -100 }, uScale: { value: 800 }, uSun: { value: new THREE.Vector3() }, uColor: { value: new THREE.Color(0.66, 0.48, 0.34) } };
  const pts = new THREE.Points(g, new THREE.ShaderMaterial({
    uniforms: u, vertexShader: dustVert, fragmentShader: dustFrag, transparent: true, depthWrite: false,
  }));
  pts.frustumCulled = false;
  pts.renderOrder = 6;
  return { pts, u };
}
