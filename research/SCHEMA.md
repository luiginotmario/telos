# Telos data schema

Every body gets `data/<id>.json`. Everything must be grounded: each event carries at least one
source URL (NASA, ESA, JPL, USGS, peer-reviewed papers, Wikipedia only as a last resort and
ideally pointing at its primary citation). No invented facts. Projections are allowed only when
a real person or agency published them, and they are labelled as projections with who said it
and when.

```jsonc
{
  "id": "earth",                 // mercury venus earth moon mars jupiter saturn uranus neptune
  "name": "Earth",
  "tagline": "8 billion people",  // shown under the name at "today", ≤ 4 words
  "physical": {
    "radius_km": 6371.0, "mass_kg": 5.972e24, "sidereal_day_h": 23.934, "orbital_period_d": 365.256,
    "axial_tilt_deg": 23.44, "mean_temp_c": 15, "moons": 1, "semi_major_axis_au": 1.0
  },
  "events": [
    {
      "id": "magma-ocean",
      "year": -4.5e9,             // astronomical year number; negative = years before 0 CE.
                                  // For deep time just use -(years ago). Today = 2026. Future = 2030 etc.
      "label": "4.5 billion years ago",   // human label shown as the headline
      "title": "Magma ocean",     // ≤ 3 words, shown bold
      "line": "The surface is molten",    // ≤ 6 words, shown grey after the title
      "detail": "1–3 plain sentences with the actual science.",
      "kind": "past",             // past | present | projected
      "confidence": "established",// established | debated | projection
      "projected_by": null,       // for projections: "Elon Musk, SpaceX update, May 2025" etc.
      "visual": {                 // drives the planet shader; all 0..1 unless noted
        "lava": 0, "ocean": 0, "ice": 0, "clouds": 0, "haze": 0, "vegetation": 0,
        "craters": 0, "lights": 0, "dust": 0,
        "atmosphere": 0,          // rim-glow strength
        "atmosphere_tint": "#7fb2ff",
        "surface_tint": null,     // optional hex multiply for the base map
        "base": "today",          // which real texture to start from: today | none
        "bands": 0, "storm": 0, "rings": 0   // gas giants only
      },
      "sites": [                  // optional surface pins (Moon, Mars, Earth)
        { "name": "Apollo 11", "lat": 0.674, "lon": 23.473, "kind": "landing",  // landing | rover | base | city | launch
          "status": "real",       // real | planned | projected
          "source": "https://..." }
      ],
      "sources": [ { "title": "…", "url": "https://…" } ]
    }
  ]
}
```

Rules
- 10–30 events per body, sorted by `year`. Include "today" (2026) as the anchor event.
- Prefer events that change how the planet *looks*, so the scrubber visibly transforms it.
- Keep `title` and `line` short and concrete, matching the reference: "Snowball Earth · Ice reaches the equator".
- Numbers: use the current scientific consensus value; if debated, say so in `detail` and set confidence.
- Future events (kind = projected) must name who projected them and link the statement.
</content>
</invoke>
