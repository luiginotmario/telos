import * as THREE from "three";

/**
 * Single-scattering atmospheres, ray-marched through a real-thickness shell around each world.
 * Rayleigh (molecules), Mie (aerosols / dust / haze, Cornette-Shanks phase) and ozone absorption,
 * each with its own exponential scale height, lit by the Sun with transmittance along both the
 * view ray and the ray toward the Sun. Output is linear radiance (it can exceed white at the
 * limb and blooms) plus the view transmittance, which dims what lies behind.
 *
 * Coefficients are per kilometre. Earth: Hillaire (2020), "A Scalable and Production Ready Sky
 * and Atmosphere Rendering Technique". Mars: CO₂ Rayleigh at ~0.6 kPa plus dust of visible
 * optical depth ~0.5 over an ~11 km scale height, absorbing blue more than red (butterscotch sky).
 * Venus: sulphuric-acid haze above the cloud deck. Giants: H₂ Rayleigh with methane absorbing red
 * on Uranus and Neptune. Thickness and scale heights are real (relative to each world's radius).
 */
export interface AtmosphereDef {
  radiusKm: number;          // planet (or cloud-deck) radius
  topKm: number;             // shell thickness
  rayleigh: [number, number, number]; rayleighH: number;
  mie: number; mieAbs: [number, number, number]; mieH: number; g: number;
  ozone?: [number, number, number];
  sun: number;               // irradiance scale (linear)
  today: { tint: string; amount: number };   // the timeline's present-day atmosphere visual (relative scaling)
}

export const ATMOSPHERES: Partial<Record<string, AtmosphereDef>> = {
  earth: { radiusKm: 6371, topKm: 100, rayleigh: [5.802e-3, 13.558e-3, 33.1e-3], rayleighH: 8, mie: 3.996e-3, mieAbs: [0.444e-3, 0.444e-3, 0.444e-3], mieH: 1.2, g: 0.8,
    ozone: [0.65e-3, 1.881e-3, 0.085e-3], sun: 5.5 , today: { tint: "#7fb2ff", amount: 1 } },
  mars: { radiusKm: 3390, topKm: 90, rayleigh: [0.09e-3, 0.21e-3, 0.5e-3], rayleighH: 11, mie: 0.04, mieAbs: [0.0012, 0.0045, 0.012], mieH: 11, g: 0.65, sun: 9 , today: { tint: "#d9a27a", amount: 0.15 } },
  venus: { radiusKm: 6052, topKm: 120, rayleigh: [0.6e-3, 1.4e-3, 3.4e-3], rayleighH: 15, mie: 0.06, mieAbs: [0.0015, 0.004, 0.013], mieH: 5, g: 0.7, sun: 12 , today: { tint: "#f2d9a0", amount: 0.8 } },
  jupiter: { radiusKm: 71492, topKm: 900, rayleigh: [0.45e-3, 1.05e-3, 2.6e-3], rayleighH: 27, mie: 0.004, mieAbs: [0.0006, 0.0012, 0.0024], mieH: 25, g: 0.7, sun: 10 , today: { tint: "#e8cfa8", amount: 0.35 } },
  saturn: { radiusKm: 60268, topKm: 1100, rayleigh: [0.35e-3, 0.8e-3, 2.0e-3], rayleighH: 60, mie: 0.003, mieAbs: [0.0004, 0.0008, 0.0018], mieH: 50, g: 0.7, sun: 10 , today: { tint: "#ead9ab", amount: 0.3 } },
  uranus: { radiusKm: 25559, topKm: 600, rayleigh: [1.2e-3, 2.6e-3, 5.2e-3], rayleighH: 28, mie: 0.0008, mieAbs: [0.009, 0.0012, 0.0006], mieH: 25, g: 0.6, sun: 12 , today: { tint: "#ffffff", amount: 0.45 } },
  neptune: { radiusKm: 24764, topKm: 600, rayleigh: [1.2e-3, 2.7e-3, 5.6e-3], rayleighH: 20, mie: 0.0008, mieAbs: [0.011, 0.0013, 0.0006], mieH: 20, g: 0.6, sun: 12 , today: { tint: "#ffffff", amount: 0.5 } },
};

const vert = /* glsl */ `
varying vec3 vP; varying vec3 vC; varying float vS;
void main(){
  vec4 w = modelMatrix * vec4(position, 1.0);
  vP = w.xyz;
  vC = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vS = length(modelMatrix[0].xyz);            // world units per planet radius
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const frag = /* glsl */ `
varying vec3 vP; varying vec3 vC; varying float vS;
uniform vec3 uLightDir; uniform float uOpacity; uniform float uDensity; uniform vec3 uTint;
uniform float uRp; uniform float uRa;                 // planet and shell radii, in planet radii
uniform float uKm;                                     // kilometres per planet radius
uniform vec3 uBR; uniform float uHR; uniform float uBM; uniform vec3 uAM; uniform float uHM; uniform float uG;
uniform vec3 uO3; uniform float uSun;

vec2 hit(vec3 o, vec3 d, float r){
  float b = dot(o, d), c = dot(o, o) - r * r, h = b * b - c;
  if (h < 0.0) return vec2(1e9, -1e9);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}
// densities at height h (km): Rayleigh, Mie, ozone (tent around 25 km)
vec3 dens(float h){
  return vec3(exp(-h / uHR), exp(-h / uHM), max(0.0, 1.0 - abs(h - 25.0) / 15.0)) * uDensity;
}
vec3 ext(vec3 d){ return uBR * d.x + (vec3(uBM) + uAM) * d.y + uO3 * d.z; }

void main(){
  // work in planet radii, centred on the planet
  vec3 o = (cameraPosition - vC) / vS;
  vec3 d = normalize(vP - cameraPosition);
  // one face per pixel: the near side from outside the shell, the far side from within it
  bool inside = length(o) < uRa;
  if (inside == gl_FrontFacing) discard;
  vec3 L = normalize(uLightDir);
  vec2 ta = hit(o, d, uRa);
  if (ta.y <= 0.0) discard;
  vec2 tp = hit(o, d, uRp);
  float t0 = max(ta.x, 0.0);
  float t1 = tp.x > 0.0 ? min(ta.y, tp.x) : ta.y;
  if (t1 <= t0) discard;
  const int N = 18, M = 6;
  float ds = (t1 - t0) / float(N);
  vec3 sumR = vec3(0.0), sumM = vec3(0.0), od = vec3(0.0);
  for (int i = 0; i < N; i++){
    vec3 p = o + d * (t0 + ds * (float(i) + 0.5));
    float h = (length(p) - uRp) * uKm;
    vec3 rho = dens(h) * ds * uKm;
    od += rho;
    // toward the Sun: blocked by the planet, otherwise its own optical depth
    vec2 tl = hit(p, L, uRa);
    if (hit(p, L, uRp * 0.998).x > 0.0) continue;
    float dl = tl.y / float(M);
    vec3 odl = vec3(0.0);
    for (int j = 0; j < M; j++){
      vec3 q = p + L * dl * (float(j) + 0.5);
      odl += dens((length(q) - uRp) * uKm) * dl * uKm;
    }
    vec3 T = exp(-ext(od + odl));
    sumR += T * rho.x;
    sumM += T * rho.y;
  }
  float mu = dot(d, L);
  float pR = 3.0 / (16.0 * 3.14159265) * (1.0 + mu * mu);
  float g2 = uG * uG;
  float pM = 3.0 / (8.0 * 3.14159265) * ((1.0 - g2) * (1.0 + mu * mu)) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * uG * mu, 1.5));
  vec3 L_in = uSun * (sumR * uBR * pR + sumM * uBM * pM) * uTint;
  vec3 Tv = exp(-ext(od));
  float a = clamp(1.0 - (Tv.r + Tv.g + Tv.b) / 3.0, 0.0, 1.0);
  gl_FragColor = vec4(L_in * uOpacity, a * uOpacity);
}`;

export function createAtmosphere(def: AtmosphereDef, lightDir: { value: THREE.Vector3 }) {
  const ra = 1 + def.topKm / def.radiusKm;
  const u = {
    uLightDir: lightDir, uOpacity: { value: 1 }, uDensity: { value: 1 },
    uTint: { value: new THREE.Color(1, 1, 1) },
    uRp: { value: 1 }, uRa: { value: ra }, uKm: { value: def.radiusKm },
    uBR: { value: new THREE.Vector3(...def.rayleigh) }, uHR: { value: def.rayleighH },
    uBM: { value: def.mie }, uAM: { value: new THREE.Vector3(...def.mieAbs) }, uHM: { value: def.mieH }, uG: { value: def.g },
    uO3: { value: new THREE.Vector3(...(def.ozone ?? [0, 0, 0])) }, uSun: { value: def.sun },
  };
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(ra, 128, 64),
    new THREE.ShaderMaterial({
      uniforms: u, vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false,
      // in-scattered light adds; what's behind is dimmed by the view transmittance
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      // drawn from inside too (the camera can sit within the shell near the ground)
      side: THREE.DoubleSide,
    }),
  );
  return { mesh, u };
}
