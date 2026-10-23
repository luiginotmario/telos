# Paleogeography

## PaleoDEM elevation atlas (Scotese & Wright 2018)

**Credit (show in the app's credits):**
PaleoDEMs: Scotese, C.R., Wright, N., 2018, PALEOMAP Paleodigital Elevation Models (PaleoDEMS) for the
Phanerozoic, PALEOMAP Project, Zenodo, https://doi.org/10.5281/zenodo.5460860. Licensed CC BY 4.0.
Resampled to 512×256 and quantised to 8 bits for Telos.

- **Licence:** Creative Commons Attribution 4.0 International (CC BY 4.0). `License.txt` inside the zip
  says the same. Redistribution and modification are allowed with attribution.
- **Record:** https://zenodo.org/records/5460860 (DOI 10.5281/zenodo.5460860)
- **Mirror and report:** https://www.earthbyte.org/paleodem-resource-scotese-and-wright-2018/ and the
  report at https://www.earthbyte.org/webdav/ftp/Data_Collections/Scotese_Wright_2018_PaleoDEM/Scotese_Wright2018_PALEOMAP_PaleoDEMs.pdf
- **File used:** `Scotese_Wright_2018_Maps_1-88_1degX1deg_PaleoDEMS_nc.zip` (9.3 MB, md5
  `77147998623ab039d86ff3e0b5e40344`, matches Zenodo), from
  https://zenodo.org/records/5460860/files/Scotese_Wright_2018_Maps_1-88_1degX1deg_PaleoDEMS_nc.zip?download=1.
  Raw files are in `research/raw/paleodem/` (gitignored). The zip has 109 netCDF grids from 0 to 540 Ma,
  mostly every 5 Myr.
- **Grid:** each grid is 1°×1° and grid-registered, with lon −180..180 (361 nodes) and lat −90..90 (181 nodes,
  south first). The variable is `z`, in metres, and covers roughly −9000..+6000 m. Ocean floor older than about
  200 Ma is a smooth synthetic depth, because no real seafloor that old survives.

### Output

- `public/textures/earth/paleo-atlas.png`: 8-bit greyscale, 512 × 3328, made of 13 slices of 512×256 stacked
  top to bottom in `index` order. Slice *i* is rows `256*i .. 256*i+255`.
- `public/textures/earth/paleo-atlas.json`: the encoding string plus `slices[]` with `ma`, `index`,
  `source_ma` and `source_file`.
- **Projection:** equirectangular, with lon −180 at the left edge and +180 at the right edge, lat +90 at the
  top edge and −90 at the bottom edge. Pixel centres sit at half-pixel offsets. Values are bilinearly
  resampled from the 1° grid.
- **Encoding:** `value = clamp(floor((elev_m + 6000) / 12000 * 255 + 0.5), 0, 255)` (round half up).
  - Decode with `elev_m = value / 255 * 12000 − 6000`. One step is 47.06 m.
  - Sea level (0 m) maps to exactly 127.5. Value **127** covers [−47.06, 0) m and **128** covers [0, +47.06) m,
    so **value ≥ 128 ⇔ land (elev ≥ 0)**. In a shader, `land = texel.r >= 0.5`.
  - Depths below −6000 m (trenches, abyssal plains at 0 Ma) and peaks above +6000 m are clamped.

| index | requested Ma | source Ma | source file |
|---|---|---|---|
| 0 | 0 | 0 | Map01_PALEOMAP_1deg_Holocene_0Ma.nc |
| 1 | 20 | 20 | Map07_PALEOMAP_1deg_Early_Miocene_20Ma.nc |
| 2 | 66 | **65** | Map16_PALEOMAP_1deg_KT_Boundary_65Ma.nc |
| 3 | 100 | 100 | Map23_PALEOMAP_1deg_Early_Cretaceous_100Ma.nc |
| 4 | 150 | 150 | Map33_PALEOMAP_1deg_Late_Jurassic_150Ma.nc |
| 5 | 200 | 200 | Map43_PALEOMAP_1deg_Late_Triassic_200Ma.nc |
| 6 | 250 | 250 | Map49_PALEOMAP_1deg_Permo-Triassic Boundary_250Ma.nc |
| 7 | 300 | 300 | Map57_PALEOMAP_1deg_Late_Pennsylvanian_300Ma.nc |
| 8 | 350 | 350 | Map64_PALEOMAP_1deg_Early_Mississippian_350Ma.nc |
| 9 | 400 | 400 | Map70_PALEOMAP_1deg_Early_Devonian_400Ma.nc |
| 10 | 450 | 450 | Map78_PALEOMAP_1deg_Late_Ordovician_450Ma.nc |
| 11 | 500 | 500 | Map84_PALEOMAP_1deg_late_Middle_Cambrian_500Ma.nc |
| 12 | 540 | 540 | Map88_PALEOMAP_1deg_Cambrian_Precambrian boundary_540Ma.nc |

Notes:

- There is no 66 Ma grid, so the nearest one (65 Ma, the K–Pg boundary map) is used.
- The netCDF history attribute of the "250Ma" file names its source grid as 252 Ma.

### Rebuild

```sh
python3 -m venv research/.venv
research/.venv/bin/python -I -m pip install netCDF4 numpy Pillow
research/.venv/bin/python -I research/scripts/build_paleo_atlas.py
```

The script also writes `research/paleo-preview-0-250.png` and `research/paleo-contact-sheet.png` for visual
checks. They were checked as follows:

- 0 Ma shows modern continents in the correct orientation.
- 250 Ma shows Pangaea with the Tethys embayment.
- 400–540 Ma show Gondwana across the south polar region.
