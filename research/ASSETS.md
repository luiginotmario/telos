# Telos asset sources

Every file shipped in `public/` from the asset-sourcing pass: where it came from, its licence, the credit line to show, and what was done to it. Raw downloads and intermediates live in `research/raw/`, which is gitignored. Nothing downloaded was executed.

Totals: 2k texture tier **3.70 MB** (36 files incl. `milkyway-2k`), 4k tier **14.1 MB**, audio **3.8 MB** (.m4a) + **2.7 MB** (.ogg), `stars.bin` **305 KB**.

## Credits block (paste into the app's About / credits)

> Planet textures: NASA Blue Marble & Black Marble (NASA Earth Observatory); NASA Scientific Visualization Studio CGI Moon Kit (LRO LROC / LOLA); NASA PDS MGS MOLA; Solar System Scope (solarsystemscope.com), CC BY 4.0, resized and re-encoded. Sky: NASA/Goddard Space Flight Center Scientific Visualization Studio, Deep Star Maps 2020, from ESA/Gaia/DPAC data. Stars: HYG Database v4.1 by David Nash (astronexus), CC BY-SA 4.0. Sounds: NASA/JPL-Caltech/University of Iowa (Voyager, Cassini, Juno); NASA/University of Iowa (Van Allen Probes EMFISIS); NASA/JPL-Caltech/LANL/CNES/IRAP (Perseverance SuperCam); NASA SVS / Parker Solar Probe FIELDS; ESA/NASA SOHO MDI, sonification A. Kosovichev (Stanford); ESA/BepiColombo/MPO-MAG/IGEP-IWF-IC-ISAS (ESA Standard Licence); NASA Apollo 10 onboard recording.

## Licence summary

| Source | Licence | What it requires |
|---|---|---|
| NASA (Earth Observatory, SVS, PDS, JPL, Photojournal, nasa.gov audio) | US-government work, not copyrighted in the US ([NASA media guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/)) | Credit NASA (and the named partners); don't imply NASA endorses Telos; don't use the NASA insignia |
| Solar System Scope textures | **CC BY 4.0** | Attribution, plus a note that the textures were modified (resized and re-encoded to WebP) |
| HYG Database v4.1 | **CC BY-SA 4.0** | Attribution. **`stars.bin` is a derivative, so it must also be distributed under CC BY-SA 4.0** |
| SVS Deep Star Maps 2020 | NASA SVS, built from Gaia DR2 | Credit NASA/GSFC SVS and ESA/Gaia/DPAC |
| ESA BepiColombo sound | **ESA Standard Licence** | Free for non-commercial, educational and information use with credit; **commercial use needs ESA's permission** (see Gaps) |
| SOHO | ESA/NASA | Credit "SOHO (ESA & NASA)" |
| Voyager PWS (NASA PDS volume VGPW_2001, hosted by the Univ. of Iowa instrument team) | NASA PDS archive data | Credit NASA/JPL/University of Iowa |

---

## 1. Textures — `public/textures/<body>/<map>-{2k,4k}.webp`

Every map is equirectangular 2:1: left edge at 180°W, prime meridian in the centre, north at the top. Colour maps are lossy WebP at q82 (`cwebp -m 6 -sharp_yuv`). Normal maps are q82 for the Moon and Mars and q90 for Earth. Elevation maps are greyscale q90. Images were resampled with Lanczos (elevation with box or bilinear filtering, in float). `public/textures/manifest.json` lists every map with its byte size, elevation ranges and the encoding formula.

I cross-checked the longitude alignment of Earth (colour, specular and elevation; zero shift), Moon (LROC colour vs LOLA; zero shift) and Mars (SSS colour vs MOLA; zero shift after rolling MOLA 180°). The Solar System Scope maps of the other bodies were not independently checked; they follow SSS's own convention.

| Body | Map | Source file and URL | Notes |
|---|---|---|---|
| sun | color | SSS `8k_sun.jpg` (actually 4096×2048) — https://www.solarsystemscope.com/textures/download/8k_sun.jpg | Artistic map based on SDO imagery. Not a real full-surface map; the Sun has no fixed surface. |
| mercury | color | SSS `8k_mercury.jpg` — …/download/8k_mercury.jpg | Based on MESSENGER mosaics |
| venus | color | SSS `8k_venus_surface.jpg` — …/download/8k_venus_surface.jpg | Based on Magellan **radar**. The orange colours are artistic (Venera-style tint), not true colour. |
| venus | atmosphere | SSS `4k_venus_atmosphere.jpg` — …/download/4k_venus_atmosphere.jpg | Artistic cloud-top map |
| earth | color | NASA Blue Marble: Next Generation, **June 2004**, `world.200406.3x5400x2700.jpg` — https://eoimages.gsfc.nasa.gov/images/imagerecords/76000/76487/world.200406.3x5400x2700.jpg | Cloud-free, no bathymetry shading. Credit: NASA Earth Observatory (Reto Stöckli). |
| earth | night | NASA Black Marble 2016, `BlackMarble_2016_3km.jpg` (13500×6750) — https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144898/BlackMarble_2016_3km.jpg | **Modified:** the colour composite includes moonlit blue land and ice. That base was removed with a colour-ratio mask, `k = clip((R−0.6B)/(0.4R))`, leaving warm city lights on black. Credit: NASA Earth Observatory / Suomi NPP VIIRS (Miguel Román, NASA GSFC). |
| earth | clouds | NASA `cloud_combined_8192.tif` — https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57747/cloud_combined_8192.tif | Greyscale; white = cloud. Static composite (Blue Marble clouds); Antarctica reads as white. |
| earth | specular | SSS `8k_earth_specular_map.tif` — …/download/8k_earth_specular_map.tif | White = water (checked: Atlantic 255, Sahara 0) |
| earth | normal | SSS `8k_earth_normal_map.tif` — …/download/8k_earth_normal_map.tif | Tangent space (mean ≈ 128,128,255); very subtle |
| earth | elevation | NASA Blue Marble GEBCO_08 `gebco_08_rev_elev_5400x2700.tif` + `gebco_08_rev_bath_5400x2700.tif` — https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/topography/… and …/bmng/bathymetry/… | Merged: land = v/255·6400 m, ocean = −(255−v)/255·8000 m. **Range −8000 … +6400 m. Sea level (0 m) = grey 141.67.** Both ends are clipped by the source: the Mariana Trench reads −8000 and Everest about 6325 m. |
| moon | color | NASA SVS CGI Moon Kit (SVS 4720), **2025** LROC WAC colour `lroc_color_16bit_srgb_4k.tif` — https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_16bit_srgb_4k.tif | Credit: NASA's Scientific Visualization Studio; LRO LROC (NASA/GSFC/Arizona State University) |
| moon | elevation | SVS 4720 `ldem_16_uint.tif` (5760×2880, LOLA) — https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_16_uint.tif | uint16 in half-metres with a 10 km offset: h = v/2 − 10000 m, relative to a 1737.4 km sphere. I verified this against `ldem_4.tif` (float km); the median residual offset was −10.0009 km. **Range −8982 … +10686 m.** |
| moon | normal | Derived from the LOLA elevation map above, per tier | Tangent space in the three.js/OpenGL convention: R = +east, G = +north, B = out. **Slopes exaggerated ×3.** Faded to flat between 82° and 88° latitude to hide polar singularity streaks. |
| mars | color | SSS `8k_mars.jpg` — …/download/8k_mars.jpg | Based on Viking/MGS imagery; colour is **enhanced** (saturated orange) compared with true colour |
| mars | elevation | NASA PDS MGS MOLA MEGDR `megt90n000eb.img` (16 px/deg, int16 big-endian, metres) — https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/meg016/megt90n000eb.img (+ `.xml` label) | Rolled 180° (MEGDR starts at 0°E). Heights are relative to the MOLA areoid. **Range −8177 … +21171 m.** Credit: NASA/JPL/GSFC MOLA Science Team, PDS Geosciences Node. |
| mars | normal | Derived from the MOLA elevation map above | Same convention and processing as the Moon: ×3 slope exaggeration, polar fade |
| jupiter | color | SSS `8k_jupiter.jpg` (actually 4096×2048) | Based on Cassini imagery |
| saturn | color | SSS `8k_saturn.jpg` (actually 4096×2048) | Based on Cassini imagery |
| saturn | ring | SSS `8k_saturn_ring_alpha.png` (8192×500 RGBA) — …/download/8k_saturn_ring_alpha.png | WebP **with alpha** (`-alpha_q 100 -exact`), 2048×125 and 4096×250. x is radial: x=0 is the inner edge and x=1 the outer edge. I fitted the mapping to ring features (B-ring outer edge, Encke gap, A-ring outer edge): **x=0 ≈ 72,200 km (1.20 Rₛ), x=1 ≈ 140,500 km (2.33 Rₛ)**, ±1%. |
| uranus | color | SSS `2k_uranus.jpg` | **2k only.** No 4k source exists; I did not upscale. |
| neptune | color | SSS `2k_neptune.jpg` | **2k only**, as for Uranus |

SSS base URL: `https://www.solarsystemscope.com/textures/download/<file>`. The download only works with a GET request; a HEAD request returns HTML.

### Milky Way — `public/textures/milkyway-{2k,4k}.webp`

- **Source:** NASA SVS Deep Star Maps 2020 (SVS 4851), `milkyway_2020_4k.exr` — https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/milkyway_2020_4k.exr. This is the **Milky Way background without the bright Hipparcos/Tycho stars**, so it does not double-draw the stars in `stars.bin`.
- **Frame:** **celestial (equatorial, ICRF/J2000), not galactic.** Plate carrée projection. The image centre is RA 0h, dec 0; **RA increases to the left** (the sky as seen from inside); top = +90° dec. Pixel → sky: RA = (0.5 − x/W)·360° mod 360, dec = 90° − y/H·180°. Checked: the LMC and SMC land at RA ≈ 80° / 13°, dec ≈ −69° / −73°.
- **Processing:** linear EXR → sRGB transfer, clipped at 1.0, no tone curve.
- **Credit:** NASA/Goddard Space Flight Center Scientific Visualization Studio. Gaia DR2: ESA/Gaia/DPAC.

## 2. Stars — `public/stars.bin`, `public/stars-meta.json`

- **Source:** HYG Database v4.1, `hyg/CURRENT/hygdata_v41.csv` — https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv. Licence CC BY-SA 4.0 (repo `LICENSE`).
- **Selection:** 15,598 stars with V mag ≤ 7.0, excluding Sol. Sorted brightest first (Sirius −1.44 … 7.0).
- **Layout:** little-endian Float32 × 5 per star (20 bytes), no header: `x, y, z, mag, ci`.
  - (x, y, z) is the unit vector in **J2000 equatorial** coordinates, computed from HYG `rarad`/`decrad` at epoch J2000 with no proper motion applied: x = cos δ cos α, y = cos δ sin α, z = sin δ.
  - `ci` is B−V. 55 stars with a blank `ci` were filled from their spectral class (O −0.32, B −0.16, A 0.15, F 0.44, G 0.68, K 1.15, M 1.6, else 0.65).
- **three.js note:** with Y up, map (x, y, z) → (x, z, −y) to put the north celestial pole on +Y.
- **Licence:** `stars.bin` is a derivative of HYG and is **CC BY-SA 4.0**. Credit: "HYG Database v4.1, David Nash / astronexus, CC BY-SA 4.0".

## 3. Sounds — `public/audio/<body>.{m4a,ogg}`

- **Processing (all bodies):** decoded to mono 48 kHz, DC removed, then cut to a loop with a **2 s equal-power crossfade** so the end of the file flows continuously into its start (seamless loop, no fade-to-silence). Normalised to −20 dBFS RMS, with peaks capped at −1 dBFS.
- **Encoding:** AAC-LC at 96 kbps mono (`.m4a`, faststart) and Opus at 64 kbps mono (`.ogg`).

**Only Mars is a real acoustic recording.** Space is a vacuum, so every other file is either radio or plasma-wave data played as audio, or a data-driven sonification.

| Body | What it actually is | Kind | Source (page → file) | Loop window | Credit |
|---|---|---|---|---|---|
| **sun** | SOHO MDI Doppler-velocity data averaged over the solar disk, low-degree modes only, filtered near 3 mHz (the Sun's 5-minute acoustic p-mode oscillations), then **sped up 42,000×** into the audible band (A. Kosovichev, Stanford). This is real solar sound waves, but heavily time-compressed. The source is 8-bit, 8 kHz. | Time-compressed helioseismic data | https://soho.nascom.nasa.gov/pickoftheweek/old/21oct2005/ → `one_mode_1_1_2_30s.au` | 0–28 s of 30.3 s | SOHO (ESA & NASA) / MDI; sonification A. Kosovichev, Stanford |
| **mercury** | Sonification of the BepiColombo MPO magnetometer data from the 1 Oct 2021 Mercury flyby. Two **synthesizers** are driven by the field: the pitch of one follows field strength (lower pitch = stronger field); the other follows the field's fluctuations. You hear solar wind → Mercury's magnetosphere → solar wind. | Synthesised sonification (most "artificial" of the set) | https://esa.int/ESA_Multimedia/Videos/2021/10/Sound_of_the_solar_wind_at_Mercury → `orig-2110_013_AR_EN.mp4` | 0–26 s of 28.7 s | ESA/BepiColombo/MPO-MAG/IGEP-IWF-IC-ISAS, **ESA Standard Licence** |
| **venus** | Parker Solar Probe FIELDS data from the 11 Jul 2020 Venus flyby (833 km altitude). A natural **low-frequency radio emission from Venus' ionosphere**, translated into sound by NASA SVS. The rising and falling tone is the emission; the rest is quiet background. | Sonification of radio emission | https://svs.gsfc.nasa.gov/13847 → `13847_Parker_Venus.mp4` | 6–33 s of 47.5 s | NASA/GSFC SVS (data viz Mark SubbaRao; scientist Glyn Collinson), Parker Solar Probe FIELDS (NASA/JHUAPL/UC Berkeley) |
| **earth** | "Chorus" — electromagnetic plasma waves in Earth's **magnetosphere** (the radiation belts), recorded by the EMFISIS instrument on NASA's Van Allen Probes. Chorus occurs naturally at audio frequencies (~0.1–10 kHz), so it is heard as rising "birdsong" chirps. NASA's page calls it "Earth's Atmosphere"; it is actually space around Earth. The NASA page gives no processing details. | Electromagnetic waves played as audio | https://www.nasa.gov/historical-sounds/ → https://www.nasa.gov/wp-content/uploads/2015/01/693857main_emfisis_chorus_1.mp3 | 0–27.5 s of 29.8 s | NASA / University of Iowa (Van Allen Probes EMFISIS) |
| **moon** | **Not a sound of the Moon.** This is the Apollo 10 LM *Snoopy* onboard (DSEA) recording, 21 May 1969 (GET ≈ 102:20:32–102:20:58), behind the lunar far side. It captures the "whistling / outer-space music" the crew heard, which was **VHF radio interference between the LM and CSM radios** (Young guessed "VHF ranging"; NASA confirmed it was interference). The window was chosen between transcript lines to avoid speech, but faint cabin noise remains. | Real onboard recording of radio interference | Apollo Flight Journal, Apollo 10 Day 5 pt 20 (https://apollojournals.org/afj/ap10fj/as10-day5-pt20.html) → `audio/a10o-1021815.mp3` | 137–165 s of 642 s | NASA (clip courtesy John Stoll, ACR, NASA JSC, via the Apollo Flight Journal) |
| **mars** | **Real acoustic recording.** Martian wind recorded by the SuperCam microphone on Perseverance's mast, sol 4 (22 Feb 2021). Rover background sounds were removed by the team; the wind is clearest around 20 s. The source is a 24-bit, 100 kHz WAV. | Real sound (microphone) | https://science.nasa.gov/resource/perseverance-rovers-supercam-records-wind-on-mars/ → https://assets.science.nasa.gov/content/dam/science/psd/mars/downloadable_items/4/5/45827_SCAM_MIC_SOL004_RUN001.wav | 0–37.5 s of 40 s | NASA/JPL-Caltech/LANL/CNES/IRAP |
| **jupiter** | Juno Waves instrument radio emissions recorded during the **Ganymede** flyby, 7 Jun 2021 (inside Jupiter's magnetosphere). The emissions span 10–50 kHz and were **frequency-shifted down** into the audio range. The abrupt jump mid-track is Juno crossing between regions of Ganymede's magnetosphere. The file is about Ganymede's environment, not Jupiter itself. | Frequency-shifted radio/plasma waves | https://photojournal.jpl.nasa.gov/catalog/PIA25030 → https://assets.science.nasa.gov/content/dam/science/psd/photojournal/pia/pia25/pia25030/PIA25030.mov | 2–42 s of 49 s | NASA/JPL-Caltech/SwRI/Univ. of Iowa |
| **saturn** | Cassini RPWS plasma waves recorded **2 Sep 2017** in the Grand Finale orbits: waves moving from Saturn to Enceladus along the magnetic field lines that connect them. About 16 minutes of data (12:14–12:30) are compressed to 28.5 s and converted to a "whooshing" sound. | Time-compressed, frequency-shifted plasma waves | https://science.nasa.gov/resource/sound-of-saturn-radio-emissions-of-the-planet-and-enceladus/ → https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/c/cas-enceladus-tulip-black-17-245-1214-1230.mp4 | 0–26 s of 28.5 s | NASA/JPL-Caltech/University of Iowa |
| **uranus** | Voyager 2 Plasma Wave Subsystem wideband **electric-field waveform**, frame SCET 1986-01-24 18:01:36–18:02:24 UT, about 2 min after closest approach. Banded emissions and plasma waves inside Uranus' magnetosphere, **played back directly at the rate it was sampled** (28.8 kHz, 4-bit, band ≈ 50 Hz–12 kHz; no frequency shift). Narrow lines are spacecraft interference; sound quality is roughly telephone-grade. | Direct audification of plasma-wave data | PDS volume VGPW_2001 browse: https://space.physics.uiowa.edu/plasma-wave/voyager/data/VGPW_2001/EXTRAS/HTML/URANUS_ENCOUNTER/V2P3_014/V2P3_014.HTM → `EXTRAS/AUDIO/P3/V2P3_014/C2684754_AUDIO.MP3` (label `DATA/P3/V2P3_014/C2684754.LBL`) | 1–39 s of 44.5 s | NASA/JPL/University of Iowa (Voyager PWS team) |
| **neptune** | Same instrument and processing as Uranus. Frame SCET 1989-08-25 04:15:11–04:15:59 UT, about 19 min after closest approach. Plasma-wave emissions in Neptune's magnetosphere, played back at the original sample rate. The steady tones are spacecraft interference lines. | Direct audification of plasma-wave data | …/VGPW_2001/EXTRAS/HTML/NEPTUNE_ENCOUNTER/V2P4_012/V2P4_012.HTM → `EXTRAS/AUDIO/P4/V2P4_012/C1139041_AUDIO.MP3` (label `DATA/P4/V2P4_012/C1139041.LBL`) | 1–38 s of 42 s | NASA/JPL/University of Iowa (Voyager PWS team) |

Alternatives already downloaded to `research/raw/audio/` (not shipped):

- Juno crossing Jupiter's **bow shock** on 24 Jun 2016 (PIA20753, 16.5 s; a more literally "Jupiter" sound, but short): `PIA20753_jno-bshock-16-176-0700-0900-blk.mp4`.
- Voyager "Lightning on Jupiter" whistler (7.8 s).
- Cassini "Saturn Radio Emissions #1/#2" (kilometric radiation; 8 kHz, 19 s and 13 s).
- ESA BepiColombo 6th Mercury flyby accelerometer sonification (2025, 80 s).
- NASA SVS 13011 "Sounds of the Sun" audiogram (182 s, mixed with narration, so unusable as a loop).

## Gaps and caveats

1. **Moon audio is not lunar.** It is VHF radio interference recorded in the Apollo 10 LM. There is no real "sound of the Moon"; consider muting the Moon or labelling the file as such in the UI. The clip is served from apollojournals.org (the Apollo Flight Journal, formerly hosted on history.nasa.gov; the nasa.gov copies now render as a JavaScript shell).
2. **Mercury audio is under the ESA Standard Licence**: non-commercial, educational and information use with credit. If Telos is ever commercial, replace it or ask ESA for permission.
3. **Uranus and Neptune audio** comes from the University of Iowa PWS team's server (space.physics.uiowa.edu), which hosts the NASA PDS Voyager PWS volume VGPW_2001. This host was not in the pre-approved list, but it is the instrument team's official archive. NASA itself only publishes Uranus/Neptune Voyager audio on YouTube, which I did not use.
4. **Uranus and Neptune textures exist at 2k only.** No 4k file was made; the manifest omits the 4k tier for them.
5. **Several textures are artistic:** the Sun, Venus surface colours, Venus atmosphere and Mars (enhanced colour) come from Solar System Scope. True-colour Viking MDIM / USGS mosaics were too large (hundreds of MB to GB) to justify for a 4k tier.
6. **Normal maps for the Moon and Mars are derived, with ×3 slope exaggeration**; tune `normalScale` in the app. The Earth normal map (SSS) is very faint.
7. **The Earth elevation map is clipped** at −8000 m and +6400 m by the source.
8. The Mercury, Venus, Jupiter, Saturn and Sun SSS maps' prime-meridian placement follows SSS's convention and was not independently verified.
9. `public/textures/earth/paleo-atlas.{png,json}` were already present and were not produced by this pass.

## Reproduce

Scripts are in `research/scripts/`: `stars.py` (HYG → `stars.bin`), `textures.py` (all maps + milky way), `audio.py` (loops) and `manifest.py`. Inputs are in `research/raw/{sss,nasa,moon,mars,hyg,sky,audio}`; intermediates are in `research/raw/work`. Tools: Python 3.13 + Pillow + NumPy, `cwebp`, `ffmpeg`.

## 4. Mars landing-site terrain — `public/terrain/mars/<site>/`

Real local terrain for the "descend and land" sequence. There are two sites: `arcadia-ap9` (AP-9, Arcadia Planitia, the SpaceX Starship candidate site, 40.02 N, -156.65 E, primary) and `jezero` (Perseverance, 18.4457 N, 77.4508 E). Each folder has `height.png`, `color.webp`, `tint.webp`, `context-height.png`, `context-color.webp` and `meta.json`. All extents, ranges and decode rules are in `meta.json`.

- **Frame:** orthographic (tangent plane) centred on the site, on the 3396.19 km Mars 2000 sphere. North is up (row 0 = north), +x = east. Heights are relative to the MOLA areoid and are *not* curvature-corrected. The sphere drops r²/2R below the plane: about 66 m at 20 km and about 13.2 km at the 300 km edge of the context patch.
- **Height encoding (`rg16`):** 8-bit RGB PNG, lossless. `v = R*256 + G` (B = 0), and `metres = lo + v/65535·(hi−lo)`.

| Site | Patch extent | Patch lat / lon | height.png range | Context (600 km) range |
|---|---|---|---|---|
| arcadia-ap9 | 58 × 58 km (56.6 m/px height, 28.3 m/px colour) | 39.529–40.509 N, -157.293 – -156.007 E | **-4073 … -3764 m** | -4993 … -3482 m |
| jezero | 60 × 60 km (58.6 m/px height, 29.3 m/px colour) | 17.939–18.952 N, 76.916–77.986 E | **-2814 … -1414 m** | -4830 … +1476 m |

| Product | Source | Licence / credit |
|---|---|---|
| Heights (both sites, patch + context) | USGS Astrogeology, *Mars HRSC MOLA Blended DEM Global 200m v2* (Fergason, Hare & Laura 2018). Only the needed bytes are range-read from the uncompressed BigTIFF at planetarymaps.usgs.gov (S3 mirror) | Public domain (USGS). HRSC: ESA/DLR/FU Berlin. MOLA: NASA/GSFC |
| Jezero high-res height | USGS *Mars 2020 TRN CTX DTM*, 20 m (`JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m`, Fergason et al. 2020). It covers 77.16–77.70 E, 18.21–18.72 N, which is the central 25% of the patch. It is shifted by +2.5 m (median offset) and feathered over about 1.4 km into the 200 m blend | Public domain (USGS). CTX: NASA/JPL-Caltech/MSSS |
| color.webp (greyscale) | Murray Lab *Global CTX Mosaic of Mars V01*, 5 m/px. Quads E-160_N40 + E-160_N36 (AP-9) and E076_N16 (Jezero). The Mosaic.tif member is stream-inflated from the zip, then 5×5 box-averaged and stretched to the 0.5–99.5 percentiles | Free use with citation: Dickson, J.L. et al. (2024), *Earth and Space Science*, doi:10.1029/2024EA003555. CTX images NASA/JPL-Caltech/MSSS |
| tint.webp, context-color.webp | USGS *Viking MDIM 2.1 colour mosaic* (232 m), via the NASA Mars Trek WMTS layer `Mars_Viking_MDIM21_ClrMosaic_global_232m`, zoom 7 (~325 m/px) | Public domain (NASA/USGS) |

**Credit line:** "Mars terrain: USGS Astrogeology HRSC/MOLA blended DEM (ESA/DLR/FU Berlin, NASA/GSFC); Mars 2020 CTX DTM (USGS); Global CTX Mosaic V01, Caltech Murray Lab (Dickson et al. 2024), CTX images NASA/JPL-Caltech/MSSS; Viking MDIM 2.1 colour mosaic (NASA/USGS) via NASA Mars Trek."

**Caveats**

1. **AP-9 is 58 km, not 60.** A 60 km patch would cross -156 E by 0.01° and need two more 1.8 GB CTX quads.
2. **There is no high-res DTM for AP-9.** HRSC stereo strips show up as rectangles of about 10–20 m noise on the very flat plains (~300 m total relief). Some CTX features, such as a ~7 km bright-rimmed ghost crater near the north edge, have no DEM expression. Let the CTX image carry the fine relief, for example through a derived normal map.
3. **Mars Trek has no global CTX layer.** The only CTX on Trek is regional mosaics, none of them at AP-9. So CTX comes from the Murray Lab quads. murray-lab.caltech.edu serves an incomplete TLS chain, so those streams use `curl -k` (image data only).
4. **Colour and context imagery are lower resolution.** `context-color` is Viking colour, not CTX, at about 325 m/px native. `tint` is the same Viking data at the patch extent and is meant as a low-frequency colour multiplier over the greyscale CTX.
5. **The Jezero HiRISE 1 m DTM (1.8 GB) was not used.** It is about 60× finer than `height.png`.
6. **Previews:** `research/terrain-preview-<site>.png` show patch hillshade (×3), CTX, tinted CTX, context hillshade, context colour, and context with the patch outline. Jezero's rim, western delta and Neretva Vallis inlet line up between the DEM and CTX. Arcadia is smooth plains.
7. **Reproduce:** `research/.venv/bin/python -I research/scripts/terrain.py fetch|build|preview`. Raw files are in `research/raw/terrain/` (about 3.7 GB of inflated CTX TIFFs), and rasterio was added to the venv. Fetch is single-process, uses at most 4 HTTP connections and is cached. Build takes about 7 s.
