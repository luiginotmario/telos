import {
  type BodyData, type Era, type HumansData, type TEvent, type VisualN,
  TODAY_YEAR, formatYear, lerpVisual, resolveVisual,
} from "./data";

export interface Stop {
  year: number;
  headline: string;
  title: string;
  line: string;
  event?: TEvent;
  era?: Era;
  future: boolean;
  visual: VisualN;
}

/** Monotonic "felt time" so deep time and recent history both get room. */
function tau(year: number) {
  const d = year - TODAY_YEAR;
  return Math.sign(d) * Math.log10(1 + Math.abs(d));
}

/**
 * Stops are every event, plus (on Earth) every human era. They are spaced evenly on the
 * ruler like the reference: position is index, not time.
 */
export function buildStops(body: BodyData, humans: HumansData | null): Stop[] {
  const events = body.events;
  const ev = events.map((e) => ({ e, v: resolveVisual(e.visual), t: tau(e.year) }));

  const stops: Stop[] = ev.map(({ e, v }) => ({
    year: e.year,
    headline: e.label || formatYear(e.year),
    title: e.title,
    line: e.line,
    event: e,
    future: e.kind === "projected",
    visual: v,
  }));

  if (humans) {
    // Skip eras that collide with an existing event year (within 1%).
    for (const era of humans.eras) {
      if (stops.some((s) => Math.abs(s.year - era.year) <= Math.max(1, Math.abs(TODAY_YEAR - era.year) * 0.01))) continue;
      const t = tau(era.year);
      let i = ev.findIndex((x) => x.t > t);
      if (i < 0) i = ev.length;
      const a = ev[Math.max(0, i - 1)], b = ev[Math.min(ev.length - 1, i)];
      const k = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
      const pop = era.world_population ?? (era.population_range ? Math.round((era.population_range[0] + era.population_range[1]) / 2) : null);
      stops.push({
        year: era.year,
        headline: era.label || formatYear(era.year),
        title: pop ? `${compactPop(pop)} people` : (era.peoples[0]?.name ?? ""),
        line: era.peoples.slice(pop ? 0 : 1, pop ? 2 : 3).map((p) => p.name).join(", "),
        era,
        future: false,
        visual: lerpVisual(a.v, b.v, Math.min(1, Math.max(0, k))),
      });
    }
    stops.sort((a, b) => a.year - b.year);
  }
  return stops;
}

export function visualAt(stops: Stop[], p: number): VisualN {
  const i = Math.max(0, Math.min(stops.length - 1, Math.floor(p)));
  const j = Math.min(stops.length - 1, i + 1);
  const t = p - i;
  // smootherstep between stops so morphs ease in and out of each era
  const s = t * t * t * (t * (t * 6 - 15) + 10);
  return lerpVisual(stops[i].visual, stops[j].visual, s);
}

/** The era (humans) that applies at fractional position p, if any. */
export function eraAt(stops: Stop[], humans: HumansData | null, idx: number): Era | null {
  if (!humans || !humans.eras.length) return null;
  const y = stops[idx]?.year;
  if (y == null || y < humans.eras[0].year) return null;
  let found: Era | null = null;
  for (const e of humans.eras) if (e.year <= y) found = e;
  return found;
}

export function compactPop(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1).replace(/\.0$/, "")} billion`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} million`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} thousand`;
  return `${n}`;
}
