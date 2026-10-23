import { Body } from "astronomy-engine";

export type BodyId =
  | "mercury" | "venus" | "earth" | "moon" | "mars"
  | "jupiter" | "saturn" | "uranus" | "neptune";

export interface BodyDef {
  id: BodyId;
  name: string;
  astro: Body;
  /** Mean radius in km (IAU/NASA fact sheets). */
  radiusKm: number;
  /** Equatorial / polar flattening for the giants, (a−c)/a. */
  flattening: number;
  /** Fallback tint before textures arrive. */
  tint: string;
  /** Sidereal rotation period, hours (negative = retrograde). */
  rotationH: number;
  gas: boolean;
}

// Values: NASA Planetary Fact Sheets (nssdc.gsfc.nasa.gov/planetary/factsheet).
export const BODIES: BodyDef[] = [
  { id: "mercury", name: "Mercury", astro: Body.Mercury, radiusKm: 2439.7, flattening: 0, tint: "#9a9590", rotationH: 1407.6, gas: false },
  { id: "venus", name: "Venus", astro: Body.Venus, radiusKm: 6051.8, flattening: 0, tint: "#e3c99a", rotationH: -5832.6, gas: false },
  { id: "earth", name: "Earth", astro: Body.Earth, radiusKm: 6371.0, flattening: 0.00335, tint: "#3d6aa8", rotationH: 23.9345, gas: false },
  { id: "moon", name: "Moon", astro: Body.Moon, radiusKm: 1737.4, flattening: 0.0012, tint: "#a8a6a2", rotationH: 655.72, gas: false },
  { id: "mars", name: "Mars", astro: Body.Mars, radiusKm: 3389.5, flattening: 0.00589, tint: "#b5623b", rotationH: 24.6229, gas: false },
  { id: "jupiter", name: "Jupiter", astro: Body.Jupiter, radiusKm: 69911, flattening: 0.06487, tint: "#c9a77f", rotationH: 9.925, gas: true },
  { id: "saturn", name: "Saturn", astro: Body.Saturn, radiusKm: 58232, flattening: 0.09796, tint: "#d8c08e", rotationH: 10.656, gas: true },
  { id: "uranus", name: "Uranus", astro: Body.Uranus, radiusKm: 25362, flattening: 0.02293, tint: "#9fd3dc", rotationH: -17.24, gas: true },
  { id: "neptune", name: "Neptune", astro: Body.Neptune, radiusKm: 24622, flattening: 0.01708, tint: "#4b70dd", rotationH: 16.11, gas: true },
];

export const SUN_RADIUS_KM = 695700;
export const AU_KM = 149597870.7;

export const bodyById = (id: string) => BODIES.find((b) => b.id === id);
export const bodyIndex = (id: BodyId) => BODIES.findIndex((b) => b.id === id);
