import * as THREE from "three";
import { latLonToDir } from "../Globe";

/**
 * The ground under the ISS, as it really looked yesterday: NASA GIBS true-colour imagery from the
 * three VIIRS satellites (Suomi NPP, NOAA-20, NOAA-21), merged so each fills the others' gaps
 * between passes. 3 × 3 tiles of 9° (≈ 2 km per pixel) around the station's ground point, laid on
 * the globe just above its surface, lit by the real Sun and faded at the edges and into night
 * (where the globe's own city lights take over). Refetched as the station moves on.
 */
const LAYERS = ["VIIRS_SNPP", "VIIRS_NOAA20", "VIIRS_NOAA21"];
const TILE = 9;          // degrees per tile at GIBS 250m level 5
const LEVEL = 5;
const N = 3;             // tiles across

const vert = /* glsl */ `
varying vec2 vUv; varying vec3 vN;
void main(){
  vUv = uv;
  vN = normalize(mat3(modelMatrix) * position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const frag = /* glsl */ `
varying vec2 vUv; varying vec3 vN;
uniform sampler2D uMap; uniform vec3 uSun; uniform float uA;
void main(){
  float edge = smoothstep(0.0, 0.16, min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y)));
  float d = dot(normalize(vN), uSun);
  float day = smoothstep(-0.06, 0.25, d);
  vec3 c = pow(texture2D(uMap, vUv).rgb, vec3(2.2));
  // VIIRS reflectance is already display-ready; shade only by the Sun's height
  c *= 0.25 + 0.85 * smoothstep(-0.05, 0.5, d);
  float a = edge * day * uA;
  gl_FragColor = vec4(c, a);
}`;

export class EarthPatch {
  private mesh: THREE.Mesh | null = null;
  private centre: { lat: number; lon: number } | null = null;
  private loading = false;
  private fade = 0;
  private u = { uMap: { value: null as THREE.Texture | null }, uSun: { value: new THREE.Vector3(1, 0, 0) }, uA: { value: 0 } };
  private date: string;

  constructor(private parent: THREE.Object3D) {
    // yesterday (UTC): today's passes are still being processed
    this.date = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  }

  /** Keep a patch centred near the ground point; fade it with the close-up. */
  update(dt: number, lat: number, lon: number, sunLocal: THREE.Vector3, want: boolean) {
    this.u.uSun.value.copy(sunLocal);
    const far = !this.centre || angDist(this.centre, { lat, lon }) > TILE * 0.85;
    if (want && far && !this.loading) void this.build(lat, lon);
    this.fade += ((want && this.mesh ? 1 : 0) - this.fade) * (1 - Math.exp(-dt * 2.5));
    this.u.uA.value = this.fade;
    if (this.mesh) this.mesh.visible = this.fade > 0.01;
  }

  private async build(lat: number, lon: number) {
    this.loading = true;
    try {
      const c0 = Math.floor((lon + 180) / TILE) - 1, r0 = Math.floor((90 - lat) / TILE) - 1;
      const rows = Math.min(180 / TILE - N, Math.max(0, r0));
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 512 * N;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      await Promise.all(Array.from({ length: N * N }, (_, k) => this.tile(ctx, (c0 + (k % N) + 40) % 40, rows + Math.floor(k / N), k % N, Math.floor(k / N))));
      const lonMin = c0 * TILE - 180, latMax = 90 - rows * TILE;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.NoColorSpace;
      tex.anisotropy = 8;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      const geo = capGeometry(latMax - N * TILE, latMax, lonMin, lonMin + N * TILE, 1 + 1.5 / 6371);
      if (!this.mesh) {
        this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms: this.u, vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false }));
        this.mesh.renderOrder = 1;
        this.mesh.frustumCulled = false;
        this.parent.add(this.mesh);
      } else {
        this.mesh.geometry.dispose();
        this.mesh.geometry = geo;
      }
      this.u.uMap.value?.dispose();
      this.u.uMap.value = tex;
      this.centre = { lat, lon };
    } catch { /* offline or GIBS unavailable: the globe's own texture stays */ }
    finally { this.loading = false; }
  }

  /** One 9° tile: the first satellite's pass, gaps filled from the other two. */
  private async tile(ctx: CanvasRenderingContext2D, col: number, row: number, i: number, j: number) {
    const imgs = await Promise.all(LAYERS.map((L) => load(`https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/${L}_CorrectedReflectance_TrueColor/default/${this.date}/250m/${LEVEL}/${row}/${col}.jpg`)));
    const x = i * 512, y = j * 512;
    const ok = imgs.filter((im): im is HTMLImageElement => !!im);
    if (!ok.length) return;
    ctx.drawImage(ok[0], x, y);
    if (ok.length < 2) return;
    const base = ctx.getImageData(x, y, 512, 512);
    const tmp = document.createElement("canvas");
    tmp.width = tmp.height = 512;
    const t = tmp.getContext("2d", { willReadFrequently: true })!;
    for (const im of ok.slice(1)) {
      t.drawImage(im, 0, 0);
      const fill = t.getImageData(0, 0, 512, 512).data;
      const b = base.data;
      for (let p = 0; p < b.length; p += 4) {
        if (b[p] + b[p + 1] + b[p + 2] < 8) { b[p] = fill[p]; b[p + 1] = fill[p + 1]; b[p + 2] = fill[p + 2]; }
      }
    }
    ctx.putImageData(base, x, y);
  }
}

function load(url: string) {
  return new Promise<HTMLImageElement | null>((res) => {
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = url;
  });
}

function angDist(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const d = THREE.MathUtils.degToRad;
  const c = Math.sin(d(a.lat)) * Math.sin(d(b.lat)) + Math.cos(d(a.lat)) * Math.cos(d(b.lat)) * Math.cos(d(a.lon - b.lon));
  return THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.max(-1, c))));
}

/** A lat/lon box on a sphere, UVs matching the tile mosaic (north up). */
function capGeometry(latMin: number, latMax: number, lonMin: number, lonMax: number, r: number, seg = 96) {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const v = new THREE.Vector3();
  for (let j = 0; j <= seg; j++) {
    const lat = latMin + (latMax - latMin) * (j / seg);
    for (let i = 0; i <= seg; i++) {
      const lon = lonMin + (lonMax - lonMin) * (i / seg);
      latLonToDir(Math.max(-89.9, Math.min(89.9, lat)), lon, v).multiplyScalar(r);
      pos.push(v.x, v.y, v.z);
      uv.push(i / seg, j / seg);
    }
  }
  for (let j = 0; j < seg; j++) for (let i = 0; i < seg; i++) {
    const a = j * (seg + 1) + i, b = a + 1, c = a + seg + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}
