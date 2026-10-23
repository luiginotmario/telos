/**
 * The Arcadia Planitia (AP-9) base, as it could grow window by window.
 *
 * What is sourced:
 *  - Site: AP-9, a SpaceX/JPL candidate (Golombek et al., LPSC 2021), chosen for shallow ground ice.
 *  - Start: Musk (8 Feb 2026) "begin [a Mars city] in about 5 to 7 years" → first ships ~2031–2033.
 *  - Cadence: Earth–Mars transfer windows recur every ~26 months (synodic period 780 days).
 *  - First cargo carries Optimus robots (Musk, 2024–2025 statements), landed Starships double as
 *    early habitats, propellant made on site from CO₂ + ice (Sabatier/ISRU, SpaceX architecture).
 *  - Target: "a million people by 2050" (Musk, Jan 2020) — far beyond one 4 km tile; this is
 *    the first district only.
 * What is ours: the exact layout. It is a projection and is labelled as one.
 */

export type Kind = "ship" | "pad" | "solar" | "isru" | "mine" | "hab" | "dome" | "rover" | "road" | "block" | "street" | "tower" | "reactor" | "driver" | "hotel";

export interface Item {
  kind: Kind;
  year: number;          // appears at this (fractional) year
  x: number; z: number;  // metres, x east, z south
  rot: number;
  size?: number;         // dome radius, hab length, solar rows…
  w?: number; d?: number; h?: number;  // blocks
  pressurized?: boolean;
  path?: [number, number][];
  until?: number;        // solar fields deploy across [year, until]
}

// Arrival windows (approximate decimal years of Earth→Mars opportunities, ~26-month spacing).
export const WINDOWS = [2031.0, 2033.2, 2035.3, 2037.5, 2039.7, 2041.8, 2043.9, 2046.0, 2048.1, 2050.2];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export function buildMarsPlan(): Item[] {
  const r = rng(40023);
  const items: Item[] = [];
  const add = (i: Item) => items.push(i);

  // 2031 · first cargo: two ships on raw ground, robots, the first solar field
  add({ kind: "ship", year: WINDOWS[0], x: -240, z: 110, rot: 0.3 });
  add({ kind: "ship", year: WINDOWS[0] + 0.02, x: -150, z: 30, rot: 1.2 });
  add({ kind: "solar", year: WINDOWS[0] + 0.05, until: WINDOWS[1], x: 120, z: 40, rot: 0, size: 12 });
  add({ kind: "road", year: WINDOWS[0] + 0.1, x: 0, z: 0, rot: 0, path: [[-150, 30], [-40, 40], [60, 40]] });

  // 2033 · first crews: more ships, propellant plant, ice mine to the north, first rover
  add({ kind: "ship", year: WINDOWS[1], x: -360, z: -90, rot: 2.0 });
  add({ kind: "ship", year: WINDOWS[1] + 0.01, x: -300, z: 230, rot: 0.8 });
  add({ kind: "ship", year: WINDOWS[1] + 0.02, x: -430, z: 90, rot: 2.6 });
  add({ kind: "isru", year: WINDOWS[1] + 0.1, x: 70, z: -170, rot: 0.15 });
  add({ kind: "mine", year: WINDOWS[1] + 0.15, x: 20, z: -640, rot: 0 });
  add({ kind: "road", year: WINDOWS[1] + 0.15, x: 0, z: 0, rot: 0, path: [[20, -600], [40, -420], [60, -260], [70, -190]] });
  add({ kind: "road", year: WINDOWS[1] + 0.2, x: 0, z: 0, rot: 0, path: [[-300, 230], [-200, 120], [-150, 30], [-40, -60], [70, -170]] });
  add({ kind: "rover", year: WINDOWS[1] + 0.2, x: 0, z: 0, rot: 0, pressurized: false, path: [[20, -600], [40, -420], [60, -260], [70, -190], [60, -260], [40, -420]] });
  add({ kind: "solar", year: WINDOWS[1] + 0.05, until: WINDOWS[2], x: 120, z: 120, rot: 0, size: 14 });

  // 2035 · pads replace raw-ground landings, shielded habitats, pressurised rover
  for (let i = 0; i < 6; i++) add({ kind: "pad", year: WINDOWS[2] - 0.4 + i * 0.05, x: -820 + (i % 3) * 160, z: -160 + Math.floor(i / 3) * 170, rot: 0 });
  for (let i = 0; i < 3; i++) add({ kind: "hab", year: WINDOWS[2] + 0.1 + i * 0.05, x: -40, z: 120 + i * 30, rot: 0, size: 22 });
  add({ kind: "road", year: WINDOWS[2], x: 0, z: 0, rot: 0, path: [[-820, -160], [-560, -40], [-300, 20], [-150, 30]] });
  add({ kind: "rover", year: WINDOWS[2] + 0.2, x: 0, z: 0, rot: 0, pressurized: true, path: [[-820, -160], [-560, -40], [-300, 20], [-150, 30], [-40, 60], [-150, 30], [-300, 20], [-560, -40]] });

  // 2037 → 2050 · each window: ships onto pads, more domes, habitats and power
  const padSlots: [number, number][] = [];
  for (let i = 0; i < 6; i++) padSlots.push([-820 + (i % 3) * 160, -160 + Math.floor(i / 3) * 170]);
  for (let w = 2; w < WINDOWS.length; w++) {
    const y = WINDOWS[w];
    // new pads every other window from 2041
    if (w >= 5 && w % 2 === 1) for (let i = 0; i < 3; i++) {
      const p: [number, number] = [-820 + i * 160, 180 + (w - 5) * 90];
      padSlots.push(p);
      add({ kind: "pad", year: y - 0.5, x: p[0], z: p[1], rot: 0 });
    }
    // arrivals: 2–6 ships per window, landing on pads, then moved to parking rows
    const n = Math.min(6, 2 + Math.floor((w - 2) * 0.7));
    for (let i = 0; i < n; i++) {
      const slot = padSlots[(w * 3 + i) % padSlots.length];
      add({ kind: "ship", year: y + i * 0.015, x: slot[0] + (r() - 0.5) * 6, z: slot[1] + (r() - 0.5) * 6, rot: r() * 6.28 });
    }
    // greenhouses grow south-east of the habitats
    if (w >= 3) {
      const k = w - 3;
      const domes = 1 + Math.floor(k * 0.6);
      for (let d = 0; d < domes; d++) {
        const ang = 0.6 + (k * 1.7 + d * 0.9);
        const rad = 230 + k * 28 + d * 20;
        add({ kind: "dome", year: y + 0.2 + d * 0.06, x: 260 + Math.cos(ang) * rad * 0.6, z: 260 + Math.sin(ang) * rad * 0.5, rot: 0, size: Math.min(24, 13 + r() * 9 + k * 0.8) });
      }
    }
    if (w >= 3 && w % 2 === 0) for (let i = 0; i < 3; i++) add({ kind: "hab", year: y + 0.3 + i * 0.05, x: -40 - (w - 2) * 34, z: 120 + i * 30, rot: 0, size: 22 });
    if (w % 2 === 1) add({ kind: "solar", year: y + 0.05, until: y + 1.6, x: 120 + (w - 1) * 46, z: -40 + (w % 4) * 50, rot: 0, size: 10 + w });
    // work/hab blocks fill in along the spine road, a street grid growing east
    if (w >= 2) {
      const nb = 2 + Math.floor((w - 2) * 0.9);
      for (let b = 0; b < nb; b++) {
        const col = (w - 2) * 2 + (b % 3), row = Math.floor(b / 3);
        add({ kind: "block", year: y + 0.25 + b * 0.03, x: -60 + col * 34, z: 230 + row * 40 + (col % 2) * 6, rot: 0, w: 18 + r() * 10, d: 14 + r() * 8, h: 4 + r() * 5 });
      }
      if (w === 2) add({ kind: "road", year: y, x: 0, z: 0, rot: 0, path: [[-150, 30], [-80, 200], [-60, 270], [200, 280], [520, 300]] });
    }
    if (w >= 4 && w % 3 === 1) add({ kind: "rover", year: y + 0.3, x: 0, z: 0, rot: 0, pressurized: true, path: [[70, -170], [200, 0], [300, 220], [180, 300], [-40, 150], [-150, 30], [70, -170]] });
  }
  relax(items);
  // 2040 → 2050: the city spreads in street-grid districts toward Musk's million-person target
  districts(items, { cx: 80, cz: 120, from: 2039.7, to: 2050.2, rMin: 480, rMax: 1550, cell: 40, seed: 7, domes: true });
  return items.sort((a, b) => a.year - b.year);
}

/**
 * Street-grid districts growing outward: inner rings first, each block a small white
 * building, streets every fourth cell. Cells near existing structures are skipped.
 */
export function districts(items: Item[], o: { cx: number; cz: number; from: number; to: number; rMin: number; rMax: number; cell: number; seed: number; domes?: boolean }) {
  const r = rng(o.seed);
  const solid = items.filter((i) => radiusOf(i) > 0);
  const n = Math.ceil(o.rMax / o.cell);
  const cells: { x: number; z: number; d: number; street: boolean; sx: boolean }[] = [];
  for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) {
    const x = o.cx + i * o.cell, z = o.cz + j * o.cell;
    // a little organic edge: noise on the radius
    const d = Math.hypot(i, j) * o.cell * (0.85 + 0.3 * r());
    if (d < o.rMin || d > o.rMax) continue;
    const street = i % 4 === 0 || j % 4 === 0;
    cells.push({ x, z, d, street, sx: i % 4 === 0 });
  }
  cells.sort((a, b) => a.d - b.d);
  for (const c of cells) {
    if (solid.some((s) => Math.hypot(s.x - c.x, s.z - c.z) < radiusOf(s) * 0.5 + o.cell * 0.7)) continue;
    const year = o.from + (o.to - o.from) * Math.pow((c.d - o.rMin) / (o.rMax - o.rMin), 1.25);
    if (c.street) { items.push({ kind: "street", year: year - 0.15, x: c.x, z: c.z, rot: c.sx ? Math.PI / 2 : 0, w: o.cell * 1.02 }); continue; }
    if (r() < 0.06) continue; // plazas, gaps
    if (o.domes && r() < 0.08) { items.push({ kind: "dome", year, x: c.x, z: c.z, rot: 0, size: 5.5 + r() * 2.5 }); continue; }
    // taller toward the centre, low at the edge
    const core = 1 - (c.d - o.rMin) / (o.rMax - o.rMin);
    items.push({ kind: "block", year, x: c.x + (r() - 0.5) * 4, z: c.z + (r() - 0.5) * 4, rot: (r() < 0.5 ? 0 : Math.PI / 2) + (r() - 0.5) * 0.05, w: 10 + r() * 4, d: 9 + r() * 4, h: 2.5 + r() * (3 + 10 * core * core) });
  }
}

// ── Moon: de Gerlache Rim 2 (an Artemis III/IV candidate region, NASA 2024) ──────────
// Sourced beats (data/moon.json): uncrewed lunar Starship by end-2027; Artemis IV crewed landing
// 2028; NASA Moon Base phases 2026–28 / 2029–32 / 2033–36 (vertical solar towers, fission surface
// power, habitats); Musk 8 Feb 2026 "self-growing city" in <10 years and a lunar mass driver.
export function buildMoonPlan(): Item[] {
  const r = rng(88);
  const items: Item[] = [];
  const add = (i: Item) => items.push(i);
  add({ kind: "ship", year: 2027.9, x: -120, z: 60, rot: 0 });                       // uncrewed HLS demo
  add({ kind: "ship", year: 2028.2, x: 60, z: -40, rot: 0.2 });                      // Artemis IV crew
  add({ kind: "rover", year: 2029.3, x: 0, z: 0, rot: 0, pressurized: false, path: [[60, -40], [180, -10], [260, 110], [120, 160], [-40, 90], [60, -40]] });
  for (let i = 0; i < 4; i++) add({ kind: "tower", year: 2029.8 + i * 0.4, x: 260 + i * 70, z: -220 + (i % 2) * 40, rot: 0 });   // vertical solar
  add({ kind: "reactor", year: 2030.6, x: -420, z: -260, rot: 0 });                  // fission surface power, set back
  add({ kind: "road", year: 2030.6, x: 0, z: 0, rot: 0, path: [[-420, -260], [-200, -120], [60, -40], [260, -200]] });
  for (let i = 0; i < 3; i++) add({ kind: "pad", year: 2030.9 + i * 0.6, x: -480 + i * 170, z: 260, rot: 0 });
  add({ kind: "road", year: 2031, x: 0, z: 0, rot: 0, path: [[-480, 260], [-200, 150], [60, -40]] });
  for (let i = 0; i < 3; i++) add({ kind: "ship", year: 2031.2 + i * 0.7, x: -480 + i * 170, z: 260, rot: 0 });
  add({ kind: "mine", year: 2032, x: 120, z: -620, rot: 0 });                         // ice in a shadowed crater floor
  add({ kind: "road", year: 2032, x: 0, z: 0, rot: 0, path: [[120, -600], [100, -300], [60, -40]] });
  // GRU Space (YC-backed): inflatable four-guest lunar hotel, opening targeted for 2032 (Jan 2026 plan).
  // Its site isn't announced; it sits with the base here. The regolith "grand hotel" from GRU's
  // film has no date; we raise it in 2038 (until = palace year), and say so in the story.
  add({ kind: "hotel", year: 2032, x: -230, z: -40, rot: 0, until: 2038 });
  add({ kind: "road", year: 2032, x: 0, z: 0, rot: 0, path: [[-230, -40], [-120, -20], [60, -40]] });
  add({ kind: "isru", year: 2033, x: -60, z: -200, rot: 0.3 });
  for (let i = 0; i < 4; i++) add({ kind: "hab", year: 2033.3 + i * 0.4, x: -20 - i * 38, z: 40 + (i % 2) * 34, rot: 0, size: 22 });
  add({ kind: "rover", year: 2034, x: 0, z: 0, rot: 0, pressurized: true, path: [[-480, 260], [-200, 150], [60, -40], [100, -300], [120, -600], [100, -300], [60, -40], [-200, 150]] });
  for (let i = 0; i < 4; i++) add({ kind: "tower", year: 2034.5 + i * 0.3, x: 540 + i * 70, z: -180 + (i % 2) * 40, rot: 0 });
  // Musk: the self-growing city, and a mass driver to throw cargo off the Moon
  add({ kind: "driver", year: 2036.1, x: 520, z: -420, rot: Math.PI / 2 });   // runs north, away from the viewer
  for (let k = 0; k < 9; k++) {
    const p: [number, number] = [-900 + (k % 3) * 170, 420 + Math.floor(k / 3) * 170];
    add({ kind: "pad", year: 2036.1 + k * 0.25, x: p[0], z: p[1], rot: 0 });
    add({ kind: "ship", year: 2036.4 + k * 0.3, x: p[0] + (r() - 0.5) * 4, z: p[1] + (r() - 0.5) * 4, rot: 0 });
  }
  relax(items);
  districts(items, { cx: 0, cz: 120, from: 2036.1, to: 2045, rMin: 380, rMax: 1700, cell: 44, seed: 3, domes: true });
  return items.sort((a, b) => a.year - b.year);
}

/** Footprint radius in plan metres (structures are drawn ×2.6 on the globe, so this is generous). */
function radiusOf(i: Item) {
  switch (i.kind) {
    case "dome": return (i.size ?? 18) * 2.7;
    case "block": return Math.max(i.w ?? 18, i.d ?? 14) * 1.6;
    case "hab": return 40;
    case "pad": return 95;
    case "ship": return 0;           // ships stand on pads or open ground
    case "isru": return 80;
    case "mine": return 80;
    case "solar": return (i.size ?? 12) * 9;
    case "tower": return 40;
    case "hotel": return 130;
    case "reactor": return 70;
    case "driver": return 0;
    default: return 0;
  }
}

/** Push overlapping structures apart; pads, plant, mine and solar fields stay put. */
function relax(items: Item[]) {
  const movable = (i: Item) => i.kind === "dome" || i.kind === "block" || i.kind === "hab";
  const solid = items.filter((i) => radiusOf(i) > 0);
  for (let it = 0; it < 60; it++) {
    for (let a = 0; a < solid.length; a++) for (let b = a + 1; b < solid.length; b++) {
      const A = solid[a], B = solid[b];
      if (!movable(A) && !movable(B)) continue;
      const dx = B.x - A.x, dz = B.z - A.z;
      const d = Math.hypot(dx, dz) || 0.01, min = (radiusOf(A) + radiusOf(B)) * 0.5;
      if (d >= min) continue;
      const push = (min - d) / d;
      const wa = movable(A) ? (movable(B) ? 0.5 : 1) : 0, wb = movable(B) ? (movable(A) ? 0.5 : 1) : 0;
      A.x -= dx * push * wa; A.z -= dz * push * wa;
      B.x += dx * push * wb; B.z += dz * push * wb;
    }
  }
}

export function moonRobotsAt(year: number) {
  if (year < 2036.1) return 0;
  return Math.round(6 + 60 * Math.min(1, (year - 2036.1) / 9) ** 1.2);
}

/** Optimus robots on site by year (projection; first cargo carries them). */
export function robotsAt(year: number) {
  if (year < WINDOWS[0]) return 0;
  const k = (year - WINDOWS[0]) / (2050.2 - WINDOWS[0]);
  return Math.round(6 + 90 * Math.min(1, k) ** 1.3);
}
