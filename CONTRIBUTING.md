# Contributing

Thanks for wanting to help.

- **Facts first.** Every event in `data/*.json` cites its sources (see `research/SCHEMA.md`). Corrections need a source: NASA, ESA, JPL, USGS, a peer-reviewed paper or the organisation that made a projection. Projections must say who made them and when.
- **Assets.** New textures, sounds or data must have a licence that allows redistribution; add them to `research/ASSETS.md` and the in-app credits (`public/credits.json`).
- **Code.** TypeScript + Three.js, no framework. Run `npm run build` (typecheck + build) before opening a PR, and keep the bundle lean.

Open an issue first for anything large, so we can agree on the approach.
