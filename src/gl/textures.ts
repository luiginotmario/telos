import * as THREE from "three";

export type MapName = "color" | "night" | "clouds" | "specular" | "normal" | "elevation" | "ring" | "atmosphere";

interface ManifestEntry { maps: Partial<Record<MapName, { tiers?: string[]; ext?: string; range_m?: [number, number] } | string[] | true>> }
type Manifest = Record<string, ManifestEntry | Record<string, unknown>>;


let anisotropy = 8;
let uploader: ((t: THREE.Texture) => void) | null = null;
/** Upload textures to the GPU as soon as they decode, so first use never stalls a frame. */
export function setUploader(f: (t: THREE.Texture) => void) { uploader = f; }
const queue: THREE.Texture[] = [];
function enqueue(t: THREE.Texture) {
  queue.push(t);
  if (queue.length === 1) pump();
}
function pump() {
  // one texture per idle slice keeps the main thread smooth while worlds stream in
  const idle = (window as any).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 16));
  idle(() => {
    const t = queue.shift();
    if (t && uploader) uploader(t);
    if (queue.length) pump();
  });
}
const cache = new Map<string, Promise<THREE.Texture | null>>();
const loader = new THREE.TextureLoader();

export function setAnisotropy(a: number) { anisotropy = a; }

let manifestP: Promise<Manifest | null> | null = null;
export function getManifest(): Promise<Manifest | null> {
  manifestP ??= fetch("/textures/manifest.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return manifestP;
}

function entryFor(m: Manifest | null, body: string): Record<string, any> | null {
  if (!m) return null;
  const e = (m as any)[body] ?? (m as any).bodies?.[body];
  if (!e) return null;
  return e.maps ?? e;
}

export async function hasMap(body: string, map: MapName): Promise<boolean> {
  const m = await getManifest();
  const e = entryFor(m, body);
  if (!e) return true; // unknown → try
  return map in e;
}

export async function elevationRange(body: string): Promise<[number, number] | null> {
  const e = entryFor(await getManifest(), body);
  const el = e?.elevation;
  const r = el?.range_m ?? el?.range ?? (el?.min_m != null ? [el.min_m, el.max_m] : null);
  return Array.isArray(r) ? [Number(r[0]), Number(r[1])] : null;
}

function urlFor(body: string, map: MapName, tier: "2k" | "4k", ext: string) {
  return `/textures/${body}/${map}-${tier}.${ext}`;
}

export function loadMap(body: string, map: MapName, tier: "2k" | "4k" = "2k"): Promise<THREE.Texture | null> {
  const key = `${body}/${map}/${tier}`;
  let p = cache.get(key);
  if (p) return p;
  p = (async () => {
    if (!(await hasMap(body, map))) return null;
    const e = entryFor(await getManifest(), body)?.[map];
    const exts: string[] = e?.ext ? [e.ext] : map === "ring" ? ["png", "webp"] : ["webp", "png", "jpg"];
    for (const ext of exts) {
      try {
        const t = await loader.loadAsync(urlFor(body, map, tier, ext));
        t.colorSpace = THREE.NoColorSpace;
        t.anisotropy = anisotropy;
        t.wrapS = map === "ring" ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
        t.generateMipmaps = true;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.needsUpdate = true;
        enqueue(t);
        return t;
      } catch { /* try next ext */ }
    }
    return null;
  })();
  cache.set(key, p);
  return p;
}

export function loadPaleo(): Promise<{ tex: THREE.Texture; meta: { slices: { ma: number; index: number }[] } } | null> {
  const key = "earth/paleo";
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      try {
        const [tex, meta] = await Promise.all([
          loader.loadAsync("/textures/earth/paleo-atlas.png"),
          fetch("/textures/earth/paleo-atlas.json").then((r) => r.json()),
        ]);
        tex.colorSpace = THREE.NoColorSpace;
        tex.wrapS = THREE.RepeatWrapping;
        tex.generateMipmaps = false;
        tex.minFilter = THREE.LinearFilter;
        (tex as any).userData = { meta };
        enqueue(tex);
        return tex;
      } catch { return null; }
    })());
  }
  return cache.get(key)!.then((t) => (t ? { tex: t, meta: (t as any).userData.meta } : null));
}
