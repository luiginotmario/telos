import type { BodyId } from "./bodies";

export const TODAY_YEAR = 2026;

export interface Visual {
  lava: number; ocean: number; ice: number; clouds: number; haze: number; vegetation: number;
  craters: number; lights: number; dust: number; atmosphere: number;
  atmosphere_tint: string; surface_tint: string | null; base: "today" | "none";
  bands: number; storm: number; rings: number;
}

export interface Site {
  name: string; lat: number; lon: number;
  kind: "landing" | "rover" | "base" | "city" | "launch" | string;
  status: "real" | "planned" | "projected";
  source?: string;
}

export interface Source { title: string; url: string }

export interface TEvent {
  id: string; year: number; label: string; title: string; line: string; detail: string;
  kind: "past" | "present" | "projected";
  confidence: "established" | "debated" | "projection";
  projected_by: string | null;
  visual: Partial<Visual>;
  sites?: Site[];
  sources: Source[];
}

export interface BodyData {
  id: BodyId; name: string; tagline: string;
  physical: Record<string, number>;
  events: TEvent[];
}

export interface People { name: string; region: string; lat: number; lon: number; note: string }
export interface Era {
  year: number; label: string; world_population: number | null;
  population_range?: [number, number];
  peoples: People[]; sources: Source[];
}
export interface HumansData { sources: Source[]; eras: Era[] }

const bodyFiles = import.meta.glob<BodyData>("../data/*.json", { import: "default" });

export async function loadBody(id: BodyId): Promise<BodyData | null> {
  const f = bodyFiles[`../data/${id}.json`];
  if (!f) return null;
  const d = await f();
  d.events.sort((a, b) => a.year - b.year);
  return d;
}

export async function loadHumans(): Promise<HumansData | null> {
  const f = bodyFiles["../data/earth-humans.json"] as unknown as (() => Promise<HumansData>) | undefined;
  if (!f) return null;
  const d = await f();
  d.eras.sort((a, b) => a.year - b.year);
  return d;
}

// ── visual defaults + interpolation ──────────────────────────────

export const DEFAULT_VISUAL: Visual = {
  lava: 0, ocean: 0, ice: 0, clouds: 0, haze: 0, vegetation: 0, craters: 0, lights: 0, dust: 0,
  atmosphere: 0, atmosphere_tint: "#9cc3ff", surface_tint: null, base: "today",
  bands: 0, storm: 0, rings: 0,
};

/** Fully-resolved numeric visual, ready for uniforms. */
export interface VisualN {
  lava: number; ocean: number; ice: number; clouds: number; haze: number; vegetation: number;
  craters: number; lights: number; dust: number; atmosphere: number;
  bands: number; storm: number; rings: number;
  baseMix: number;
  atm: [number, number, number];
  tint: [number, number, number];
  tintMix: number;
}

const NUM_KEYS = ["lava", "ocean", "ice", "clouds", "haze", "vegetation", "craters", "lights", "dust", "atmosphere", "bands", "storm", "rings"] as const;

export function hexToRgb(hex: string | null | undefined): [number, number, number] {
  if (!hex) return [1, 1, 1];
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function resolveVisual(v: Partial<Visual>): VisualN {
  const f = { ...DEFAULT_VISUAL, ...v };
  const out = {} as VisualN;
  for (const k of NUM_KEYS) out[k] = Number(f[k]) || 0;
  out.baseMix = f.base === "none" ? 0 : 1;
  out.atm = hexToRgb(f.atmosphere_tint);
  out.tint = hexToRgb(f.surface_tint);
  out.tintMix = f.surface_tint ? 1 : 0;
  return out;
}

export function lerpVisual(a: VisualN, b: VisualN, t: number): VisualN {
  const o = {} as VisualN;
  for (const k of NUM_KEYS) o[k] = a[k] + (b[k] - a[k]) * t;
  o.baseMix = a.baseMix + (b.baseMix - a.baseMix) * t;
  o.tintMix = a.tintMix + (b.tintMix - a.tintMix) * t;
  o.atm = [0, 1, 2].map((i) => a.atm[i] + (b.atm[i] - a.atm[i]) * t) as VisualN["atm"];
  // keep the tint colour of whichever side actually has one so the fade isn't through white
  const ta = a.tintMix > 0 ? a.tint : b.tint, tb = b.tintMix > 0 ? b.tint : a.tint;
  o.tint = [0, 1, 2].map((i) => ta[i] + (tb[i] - ta[i]) * t) as VisualN["tint"];
  return o;
}

// ── time labels ──────────────────────────────────────────────────

export function yearsAgo(year: number) { return TODAY_YEAR - year; }

export function formatYear(year: number): string {
  if (year > TODAY_YEAR + 0.5) {
    const ahead = year - TODAY_YEAR;
    if (ahead >= 1e9) return `In ${trim(ahead / 1e9)} billion years`;
    if (ahead >= 1e6) return `In ${trim(ahead / 1e6)} million years`;
    return `${Math.round(year)}`;
  }
  if (Math.abs(year - TODAY_YEAR) < 0.5) return "Today";
  const ago = yearsAgo(year);
  if (ago >= 1e9) return `${trim(ago / 1e9)} billion years ago`;
  if (ago >= 1e6) return `${trim(ago / 1e6)} million years ago`;
  if (ago >= 12000) return `${Math.round(ago / 1000).toLocaleString("en-US")},000 years ago`;
  if (year < 0) return `${Math.round(-year).toLocaleString("en-US")} BCE`;
  if (year < 1000) return `${Math.round(year)} CE`;
  return `${Math.round(year)}`;
}

export function formatShortAgo(year: number): string {
  if (year > TODAY_YEAR + 0.5) {
    const ahead = year - TODAY_YEAR;
    if (ahead >= 1e9) return `In ${trim(ahead / 1e9)}B years`;
    if (ahead >= 1e6) return `In ${trim(ahead / 1e6)}M years`;
    return `${Math.round(year)}`;
  }
  const ago = yearsAgo(year);
  if (ago >= 1e9) return `${trim(ago / 1e9)}B years ago`;
  if (ago >= 1e6) return `${trim(ago / 1e6)}M years ago`;
  return formatYear(year);
}

function trim(n: number) {
  return n >= 10 ? n.toFixed(1).replace(/\.0$/, "") : n.toFixed(2).replace(/0$/, "").replace(/\.0$/, "");
}
