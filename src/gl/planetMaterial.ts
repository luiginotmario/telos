import * as THREE from "three";
import { NOISE } from "./noise.glsl";

export const MAX_GLOWS = 24;
/** Shared switch: globes output linear light while the post-processing path is active. */
export const LINEAR_OUT = { value: 0 };

const vert = /* glsl */ `
varying vec2 vUv;
varying vec3 vObjN;
varying vec3 vWorldN;
varying vec3 vWorldPos;
varying float vCamAlt;   // camera height above this globe, in its radii
void main() {
  vUv = uv;
  vec3 c = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vCamAlt = distance(cameraPosition, c) / length(modelMatrix[0].xyz) - 1.0;
  vObjN = normalize(position);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vWorldN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const frag = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec3 vObjN;
varying vec3 vWorldN;
varying float vCamAlt;
varying vec3 vWorldPos;

uniform sampler2D uColor;   uniform float uHasColor;
uniform sampler2D uNight;   uniform float uHasNight;
uniform sampler2D uClouds;  uniform float uHasClouds;
uniform sampler2D uSpec;    uniform float uHasSpec;
uniform sampler2D uNormal;  uniform float uHasNormal;
uniform sampler2D uElev;    uniform float uHasElev; uniform vec2 uElevRange;
uniform sampler2D uHazeTex; uniform float uHasHaze;
uniform sampler2D uPaleo;   uniform float uPaleoN; uniform vec3 uPaleo3; // slice A, slice B, t
uniform float uPaleoMix;

uniform vec3 uTint;          // body fallback colour
uniform vec3 uLightDir;      // world space, towards the light
uniform vec3 uCamPos;
uniform float uTime;
uniform float uCloudDrift;
uniform float uBlur;         // longitude smear (uv units) from fast spin
uniform float uDarkSpace;    // 1 = rendered against black space, 0 = white studio
uniform float uIsEarth;
uniform float uGas;
uniform float uSeaLevel;     // metres, for bodies with elevation and an "ocean" past
uniform float uOpacity;
uniform float uSeed;

// era
uniform float uLava, uOcean, uIce, uCloudAmt, uHaze, uVeg, uCraters, uLights, uDust, uAtm;
uniform float uBands, uStorm, uBaseMix, uTintMix;
uniform vec3 uAtmTint, uSurfTint;

uniform float uFogDensity; uniform vec3 uFogColor;
uniform vec3 uHoleDir; uniform float uHoleCos;
uniform float uLinearOut; uniform float uGain; uniform float uPhysAtm;
uniform vec4 uGlows[${MAX_GLOWS}];
uniform int uGlowCount;

${NOISE}

float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 texBlur(sampler2D t, vec2 uv) {
  if (uBlur < 0.0005) return texture2D(t, uv).rgb;
  vec3 s = vec3(0.0);
  for (int i = 0; i < 7; i++) {
    float o = (float(i) / 6.0 - 0.5) * uBlur;
    s += texture2D(t, vec2(fract(uv.x + o), uv.y)).rgb;
  }
  return s / 7.0;
}

float paleoElev(vec2 uv, float slice) {
  float y = clamp(uv.y, 0.5 / 256.0, 1.0 - 0.5 / 256.0);
  float ay = 1.0 - (slice + (1.0 - y)) / uPaleoN;
  float v = texture2D(uPaleo, vec2(uv.x, ay)).r;
  return v * 12000.0 - 6000.0;
}

// cheap cellular craters: returns rim/bowl shading in [-1,1]
float craterField(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  float acc = 0.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 h = fract(sin(vec3(dot(i + g, vec3(127.1, 311.7, 74.7)), dot(i + g, vec3(269.5, 183.3, 246.1)), dot(i + g, vec3(113.5, 271.9, 124.6)))) * 43758.5453);
    float r = 0.18 + 0.32 * h.x * h.x;
    float d = length(g + h - f) / r;
    if (d < 1.25) acc += (d < 1.0 ? -0.6 * (1.0 - d * d) : 0.9 * (1.25 - d) * 4.0 * (d - 1.0)) * step(0.35, h.y);
  }
  return acc;
}

void main() {
  vec3 emit = vec3(0.0);   // light brighter than white (linear), added after the encode: it blooms
  vec3 n = normalize(vObjN);
  if (dot(n, uHoleDir) > uHoleCos) discard;   // terrain patches cover this cap (descent scene)
  vec3 N = normalize(vWorldN);
  vec3 L = normalize(uLightDir);
  vec3 V = normalize(uCamPos - vWorldPos);
  vec2 uv = vUv;
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float alat = abs(lat);
  vec3 sp = n * 1.0 + uSeed;

  // ── base surface ───────────────────────────────────────────
  vec3 base = uHasColor > 0.5 ? texBlur(uColor, uv) : uTint * (0.85 + 0.15 * fbm3(sp * 3.0));
  float water = 0.0;
  if (uIsEarth > 0.5 && uHasSpec > 0.5) water = texture2D(uSpec, uv).r * uBaseMix;

  // elevation (metres) where known
  float elev = 0.0;
  if (uHasElev > 0.5) elev = mix(uElevRange.x, uElevRange.y, texture2D(uElev, uv).r);

  // ── primordial / procedural surface (no "today" map yet) ──
  float hN = fbm(sp * 2.2);                 // generic height noise, ~[-0.6,0.6]
  vec3 prim = mix(vec3(0.16, 0.15, 0.14), vec3(0.32, 0.30, 0.28), smoothstep(-0.5, 0.5, hN + 0.3 * fbm3(sp * 9.0)));
  if (uGas > 0.5) {
    float b = sin(lat * (14.0 + 6.0 * uBands) + 1.6 * fbm(vec3(n.x * 2.0, lat * 4.0, n.z * 2.0) + uSeed));
    prim = uTint * (0.82 + 0.22 * b * (0.35 + uBands));
  }
  vec3 alb = mix(prim, base, uBaseMix);

  // ── Earth paleogeography (Scotese & Wright 2018 PaleoDEMs) ─
  if (uPaleoMix > 0.001) {
    float eA = paleoElev(uv, uPaleo3.x);
    float eB = paleoElev(uv, uPaleo3.y);
    float e = mix(eA, eB, uPaleo3.z) + 220.0 * fbm(sp * 18.0);
    float land = smoothstep(-40.0, 40.0, e);
    float depth = clamp(-e / 5000.0, 0.0, 1.0);
    vec3 sea = mix(vec3(0.17, 0.47, 0.62), vec3(0.06, 0.20, 0.45), smoothstep(0.0, 0.35, depth));
    float arid = exp(-pow((degrees(alat) - 24.0) / 9.0, 2.0)) * (0.6 + 0.4 * fbm3(sp * 5.0));
    vec3 barren = mix(vec3(0.47, 0.40, 0.33), vec3(0.62, 0.52, 0.40), 0.5 + 0.5 * fbm3(sp * 7.0));
    vec3 green = mix(vec3(0.20, 0.33, 0.16), vec3(0.33, 0.41, 0.22), 0.5 + 0.5 * fbm3(sp * 6.0));
    vec3 desert = vec3(0.78, 0.67, 0.48);
    vec3 ground = mix(barren, green, uVeg * (1.0 - arid));
    ground = mix(ground, desert, arid * 0.75);
    ground = mix(ground, vec3(0.45, 0.42, 0.40), smoothstep(1800.0, 3500.0, e));
    vec3 paleo = mix(sea, ground, land);
    alb = mix(alb, paleo, uPaleoMix);
    water = mix(water, 1.0 - land, uPaleoMix);
  }

  // ── oceans for bodies with a wet past ──────────────────────
  if (uOcean > 0.001) {
    float sea;
    if (uHasElev > 0.5) {
      // ocean ≥ 0.6 reaches the mapped shoreline (Mars: Deuteronilus contact)
      float lvl = mix(uElevRange.x, uSeaLevel, smoothstep(0.0, 0.6, uOcean));
      sea = smoothstep(lvl + 60.0, lvl - 60.0, elev + 80.0 * fbm3(sp * 30.0));
    } else {
      float thr = mix(-0.7, 0.35, uOcean);
      sea = smoothstep(thr + 0.02, thr - 0.02, hN);
    }
    float earthBase = uIsEarth * max(uBaseMix, uPaleoMix);
    sea *= (1.0 - earthBase);
    vec3 seaCol = mix(vec3(0.07, 0.20, 0.42), vec3(0.14, 0.36, 0.52), 0.5 + 0.5 * fbm3(sp * 4.0));
    alb = mix(alb, seaCol, sea);
    water = max(water, sea);
  }

  // ── craters (primordial bombardment) ───────────────────────
  if (uCraters * (1.0 - uBaseMix) > 0.001) {
    float c = craterField(sp * 7.0) * 0.6 + craterField(sp * 19.0) * 0.4;
    alb *= 1.0 + 0.22 * c * uCraters * (1.0 - uBaseMix) * (1.0 - water);
  }

  // ── vegetation tint on bodies that don't have it baked in ──
  // (Earth uses it through paleo; elsewhere it stays 0.)

  // ── ice ────────────────────────────────────────────────────
  if (uIce > 0.001) {
    float line = mix(1.62, -0.05, uIce) + 0.10 * fbm(sp * 4.0);
    float ice = smoothstep(line, line + 0.08, alat);
    // sea ice is smoother and bluer
    vec3 iceCol = mix(vec3(0.93, 0.96, 0.98), vec3(0.80, 0.88, 0.94), water * 0.6 + 0.2 * fbm3(sp * 12.0));
    alb = mix(alb, iceCol, ice);
    water *= 1.0 - ice;
  }

  // ── dust ───────────────────────────────────────────────────
  if (uDust > 0.001) {
    float d = smoothstep(-0.3, 0.6, fbm(sp * 3.0 + vec3(uTime * 0.01, 0.0, 0.0)));
    alb = mix(alb, vec3(0.72, 0.50, 0.33), uDust * (0.45 + 0.4 * d));
  }

  // ── surface tint (era-specific colour cast) ────────────────
  alb = mix(alb, uSurfTint * (0.55 + 0.9 * luma(alb)), uTintMix * 0.3 * (1.0 - water * 0.8));

  // ── haze (thick atmospheres) ───────────────────────────────
  vec3 hazeCol = uHasHaze > 0.5 ? texBlur(uHazeTex, uv) : uAtmTint * (0.92 + 0.08 * sin(lat * 9.0 + fbm3(sp * 3.0)));
  alb = mix(alb, hazeCol, uHaze);
  water *= 1.0 - uHaze;

  // ── normal mapping ────────────────────────────────────────
  vec3 Nn = N;
  if (uHasNormal > 0.5 && uHaze < 0.95) {
    vec3 tn = texture2D(uNormal, uv).xyz * 2.0 - 1.0;
    vec3 T = normalize(cross(vec3(0.0, 1.0, 0.0), N) + vec3(1e-4, 0.0, 0.0));
    vec3 B = cross(N, T);
    Nn = normalize(mix(N, normalize(T * tn.x + B * tn.y + N * tn.z), (1.0 - water) * (1.0 - uHaze) * 0.9));
  }

  // ── lighting ──────────────────────────────────────────────
  float ndl = dot(Nn, L);
  float wrap = uDarkSpace > 0.5 ? 0.02 : 0.18;
  float diff = clamp((ndl + wrap) / (1.0 + wrap), 0.0, 1.0);
  diff = pow(diff, 0.9);
  float term = smoothstep(-0.15, 0.25, dot(N, L));
  vec3 col = alb * diff;
  // soft studio fill so the night side never goes pure black on white
  col += alb * (uDarkSpace > 0.5 ? 0.012 : 0.07) * (1.0 - diff);

  // specular glint on water
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 140.0) * water * term;
  col += vec3(1.0, 0.97, 0.92) * spec * 0.28;
  emit += vec3(1.0, 0.95, 0.86) * spec * 2.4;          // the Sun's glint off the sea

  // ── clouds ─────────────────────────────────────────────────
  if (uCloudAmt > 0.001) {
    float cl;
    vec2 cuv = vec2(fract(uv.x + uTime * uCloudDrift), uv.y);
    if (uHasClouds > 0.5) {
      float real = texBlur(uClouds, cuv).r;
      float proc = smoothstep(mix(0.86, 0.36, uCloudAmt), mix(0.86, 0.36, uCloudAmt) + 0.14, fbm(sp * 2.8 + vec3(uTime * 0.02, 0.0, 0.0)) * 0.5 + 0.5);
      cl = mix(proc, real, uBaseMix) * uCloudAmt;
    } else {
      // wispy, domain-warped cloud field; coverage grows with the amount
      vec3 cq = vec3(n.x * 2.0, n.y * 3.2, n.z * 2.0) + uSeed + vec3(uTime * 0.02, 0.0, 0.0); // stretched along latitude bands
      cq += 0.7 * vec3(fbm3(cq + 5.2), fbm3(cq + 1.7), fbm3(cq + 9.1));
      float cn = fbm(cq) * 0.5 + 0.5;
      float thr = mix(0.80, 0.34, uCloudAmt);
      cl = smoothstep(thr, thr + 0.26, cn) * 0.9;
    }
    // cloud shadow + body
    col *= 1.0 - 0.25 * cl * term;
    col = mix(col, vec3(1.0) * (diff * 0.95 + (uDarkSpace > 0.5 ? 0.01 : 0.08)), cl);
  }

  // ── lava (emissive, ignores lighting) ─────────────────────
  if (uLava > 0.001) {
    vec3 q = sp * 2.4;
    q += 0.6 * vec3(fbm3(q + 3.1), fbm3(q + 7.7), fbm3(q + 1.3)) + vec3(0.0, uTime * 0.015, 0.0);
    float r = ridge(q);
    float crust = smoothstep(0.55, 0.85, r);
    float molten = smoothstep(0.2, 1.0, uLava);
    vec3 hot = mix(vec3(1.0, 0.36, 0.06), vec3(1.0, 0.82, 0.45), smoothstep(0.75, 1.0, r));
    vec3 crustCol = vec3(0.10, 0.08, 0.07) * (0.6 + diff);
    // low lava: dark crust with glowing seams. high lava: bright marbled ocean of melt.
    float seam = smoothstep(0.80 - 0.25 * uLava, 0.95, r);
    vec3 lowL = mix(crustCol, hot * 1.2, seam);
    vec3 highL = mix(vec3(0.62, 0.12, 0.03), hot * 1.25, crust);
    vec3 lav = mix(lowL, highL, molten);
    col = mix(col, lav, smoothstep(0.0, 0.25, uLava));
  }

  // ── night lights ──────────────────────────────────────────
  float night = 1.0 - smoothstep(-0.05, 0.2, dot(N, L));
  if (uLights > 0.001) {
    float lights = 0.0;
    if (uHasNight > 0.5) lights = texBlur(uNight, uv).r * uBaseMix;
    col += vec3(1.0, 0.72, 0.38) * lights * uLights * (0.15 + 1.4 * night);
    emit += vec3(1.0, 0.45, 0.14) * lights * lights * uLights * night * 1.6;   // city cores glow
  }
  // site glows (bases, cities)
  for (int i = 0; i < ${MAX_GLOWS}; i++) {
    if (i >= uGlowCount) break;
    vec4 g = uGlows[i];
    float d = acos(clamp(dot(n, g.xyz), -1.0, 1.0));
    float r = 0.012 + 0.05 * g.w;
    float m = smoothstep(r, 0.0, d) * (0.6 + 0.4 * fbm3(n * 160.0));
    col += vec3(1.0, 0.78, 0.5) * m * g.w * (0.35 + 1.6 * night);
  }

  // ── atmosphere rim ────────────────────────────────────────
  // a rim seen on the whole globe; from low orbit nearly everything grazes, so it fades out there
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.2) * smoothstep(0.12, 0.9, vCamAlt) * (1.0 - uPhysAtm);   // the physical sky does this
  float lit = smoothstep(-0.1, 0.6, dot(N, L));
  // airglow-free night side: the atmosphere only shows where it scatters sunlight
  col = mix(col, uAtmTint * (0.35 + 0.8 * lit), clamp(fres * uAtm * 0.75 * (uDarkSpace > 0.5 ? lit : 1.0), 0.0, 1.0));

  col *= uGain;   // exposure: the planet view sits a little brighter than the overview
  // aerial perspective (descent scene only)
  if (uFogDensity > 0.0) {
    float fd = distance(uCamPos, vWorldPos);
    col = mix(col, uFogColor, 1.0 - exp(-fd * uFogDensity));
  }
  if (uDarkSpace < 0.5) col = 1.0 - (1.0 - col) * (1.0 - 0.06) ; // gentle studio lift
  // authored + lit in display (sRGB) space; no tonemapping so the white studio stays white
  // when post-processing, hand the compositor linear light (it encodes to sRGB at the end)
  if (uLinearOut > 0.5) col = pow(max(col, 0.0), vec3(2.2)) + emit * uGain;
  gl_FragColor = vec4(col, uOpacity);
}
`;

const blank = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
blank.needsUpdate = true;

export function createPlanetMaterial(seed: number) {
  const u = {
    uColor: { value: blank as THREE.Texture }, uHasColor: { value: 0 },
    uNight: { value: blank as THREE.Texture }, uHasNight: { value: 0 },
    uClouds: { value: blank as THREE.Texture }, uHasClouds: { value: 0 },
    uSpec: { value: blank as THREE.Texture }, uHasSpec: { value: 0 },
    uNormal: { value: blank as THREE.Texture }, uHasNormal: { value: 0 },
    uElev: { value: blank as THREE.Texture }, uHasElev: { value: 0 }, uElevRange: { value: new THREE.Vector2(0, 1) },
    uHazeTex: { value: blank as THREE.Texture }, uHasHaze: { value: 0 },
    uPaleo: { value: blank as THREE.Texture }, uPaleoN: { value: 1 }, uPaleo3: { value: new THREE.Vector3() },
    uPaleoMix: { value: 0 },
    uTint: { value: new THREE.Color(0.5, 0.5, 0.5) },
    uLightDir: { value: new THREE.Vector3(-0.6, 0.45, 0.65).normalize() },
    uCamPos: { value: new THREE.Vector3() },
    uTime: { value: 0 }, uCloudDrift: { value: 0.0015 }, uBlur: { value: 0 },
    uDarkSpace: { value: 0 }, uIsEarth: { value: 0 }, uGas: { value: 0 },
    uSeaLevel: { value: 0 }, uOpacity: { value: 1 }, uSeed: { value: seed },
    uLava: { value: 0 }, uOcean: { value: 0 }, uIce: { value: 0 }, uCloudAmt: { value: 0 }, uHaze: { value: 0 },
    uVeg: { value: 0 }, uCraters: { value: 0 }, uLights: { value: 0 }, uDust: { value: 0 }, uAtm: { value: 0 },
    uBands: { value: 0 }, uStorm: { value: 0 }, uBaseMix: { value: 1 }, uTintMix: { value: 0 },
    uAtmTint: { value: new THREE.Color(0.6, 0.75, 1) }, uSurfTint: { value: new THREE.Color(1, 1, 1) },
    uGlows: { value: Array.from({ length: MAX_GLOWS }, () => new THREE.Vector4()) },
    uGlowCount: { value: 0 },
    uFogDensity: { value: 0 }, uFogColor: { value: new THREE.Color(0.8, 0.65, 0.5) },
    uHoleDir: { value: new THREE.Vector3(0, 1, 0) }, uHoleCos: { value: 2 },
    uLinearOut: LINEAR_OUT, uGain: { value: 1 }, uPhysAtm: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({ uniforms: u, vertexShader: vert, fragmentShader: frag, transparent: false });
  return { mat, u };
}

export type PlanetUniforms = ReturnType<typeof createPlanetMaterial>["u"];
