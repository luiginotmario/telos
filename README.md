# Telos

Every world in the solar system on one timeline. The overview is the real solar system for this moment: true positions, orbits, axial orientation and 15,598 real stars. Pick a world and it opens into a quiet white studio where you scrub its whole story, from formation to the projected bases and cities on the Moon and Mars.

TypeScript + Three.js (WebGL2), Vite. No framework.

```bash
npm install
npm run dev      # http://localhost:5288
npm run build
```

## How it's grounded

- **Positions and rotation**: [astronomy-engine](https://github.com/cosinekitty/astronomy) (VSOP87, IAU rotation models). Planet sizes are enlarged; everything else is true for the current date.
- **Stories**: `data/<body>.json`. Every event cites its sources; projections name who projected them and when (`research/SCHEMA.md`).
- **Earth's continents, 0–540 Ma**: Scotese & Wright (2018) PaleoDEMs, blended continuously while you scrub.
- **Mars' northern ocean**: floods the real MOLA topography up to the Deuteronilus contact (≈ −3760 m).
- **Who lived on Earth**: `data/earth-humans.json`, using HYDE 3.3, McEvedy & Jones and UN WPP 2024.
- **Sounds**: NASA/ESA recordings and sonifications. Only Mars is a real acoustic recording; each one is labelled on screen.
- **Textures, stars, licences**: `research/ASSETS.md`. The in-app Credits sheet lists the required attributions.

## Surface bases

On Mars (Arcadia Planitia, SpaceX candidate site AP-9) and the Moon (de Gerlache Rim 2, a NASA Artemis candidate region), the timeline builds a base on the globe from the first landings on. Scroll to move through time; the camera flies down when there's something happening on the surface. Locations are real; layout and scale are illustrative. GRU Space's planned lunar hotel is modelled from the company's launch film.

## Licences

Data and media keep their own licences (NASA public domain, Solar System Scope CC BY 4.0, PaleoDEMs CC BY 4.0, HYG CC BY-SA 4.0, ESA Standard Licence for the Mercury sound — non-commercial). `public/stars.bin` is derived from HYG and is shared under CC BY-SA 4.0. Full list: `research/ASSETS.md`.

## Keys

Scroll moves through time · pinch or ctrl-scroll zooms · `←` `→` move between worlds · `↑` `↓` scrub time · `Esc` back to the solar system · `1`–`9` dive from the overview.
