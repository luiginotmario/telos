"""Build the Telos paleo-elevation atlas from Scotese & Wright (2018) PaleoDEMs.

Input : research/raw/paleodem/nc/<dir>/MapNN_PALEOMAP_1deg_<name>_<age>Ma.nc
        (1 deg x 1 deg, grid-registered: lon -180..180 (361 nodes, 180 == -180),
         lat -90..90 ascending (181 nodes), variable z = elevation in metres)
Output: public/textures/earth/paleo-atlas.png  (8-bit grey, 512 x 256*N, slices stacked top->bottom)
        public/textures/earth/paleo-atlas.json
        research/paleo-preview-0-250.png       (colour preview for visual checks)
        research/paleo-contact-sheet.png       (all slices, colour, for visual checks)

Run   : research/.venv/bin/python -I research/scripts/build_paleo_atlas.py
"""

import json
import re
import sys
from pathlib import Path

import numpy as np
from netCDF4 import Dataset
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
NC_DIR = ROOT / "research/raw/paleodem/nc"
OUT_DIR = ROOT / "public/textures/earth"
RESEARCH = ROOT / "research"

TARGET_MA = [0, 20, 66, 100, 150, 200, 250, 300, 350, 400, 450, 500, 540]
W, H = 512, 256
E_MIN, E_MAX = -6000.0, 6000.0
ENCODING = (
    "8-bit greyscale, value = clamp(floor((elev_m + 6000) / 12000 * 255 + 0.5), 0, 255); "
    "decode elev_m = value / 255 * 12000 - 6000 (step 47.06 m). "
    "Sea level (0 m) maps to 127.5 exactly; with round-half-up, value 127 covers [-47.06, 0) m and "
    "value 128 covers [0, +47.06) m, so value >= 128 <=> elev >= 0 m (land) and value <= 127 <=> "
    "elev < 0 m (sea). In a shader (texel = value/255): land = texel >= 0.5. "
    "Elevations beyond -6000/+6000 m are clamped (source range is about -9000..+6000 m). "
    "Each slice is 512x256 equirectangular, lon -180 at left edge to +180 at right edge, "
    "lat +90 at top edge to -90 at bottom edge, pixel centres at half-pixel offsets; "
    "bilinearly resampled from the 1 deg grid. Slices are stacked vertically in 'index' order: "
    "slice i occupies rows [256*i, 256*i+255] of the 512 x (256*N) image."
)


def list_sources():
    out = []
    for p in sorted(NC_DIR.glob("*/*.nc")):
        m = re.search(r"_([0-9.]+)Ma\.nc$", p.name)
        if m:
            out.append((float(m.group(1)), p))
    return out


def load(path):
    with Dataset(path) as ds:
        lon = np.asarray(ds.variables["lon"][:], dtype=np.float64)
        lat = np.asarray(ds.variables["lat"][:], dtype=np.float64)
        z = np.ma.filled(ds.variables["z"][:], np.nan).astype(np.float64)
    assert z.shape == (181, 361), z.shape
    assert abs(lon[0] + 180) < 1e-6 and abs(lon[-1] - 180) < 1e-6
    assert abs(lat[0] + 90) < 1e-6 and abs(lat[-1] - 90) < 1e-6
    if np.isnan(z).any():
        raise ValueError(f"NaNs in {path.name}")
    return z  # z[j, i] at lat = -90 + j, lon = -180 + i


def resample(z):
    """Bilinear sample of the grid-registered 1 deg grid at 512x256 pixel centres."""
    lon = -180.0 + (np.arange(W) + 0.5) * 360.0 / W
    lat = 90.0 - (np.arange(H) + 0.5) * 180.0 / H
    x = lon + 180.0  # fractional column index, within [0.35, 359.65]
    y = lat + 90.0   # fractional row index, within [0.35, 179.65]
    x0 = np.floor(x).astype(int)
    y0 = np.floor(y).astype(int)
    fx = (x - x0)[None, :]
    fy = (y - y0)[:, None]
    x1, y1 = x0 + 1, y0 + 1
    Y0, X0 = np.meshgrid(y0, x0, indexing="ij")
    Y1, X1 = np.meshgrid(y1, x1, indexing="ij")
    top = z[Y0, X0] * (1 - fx) + z[Y0, X1] * fx
    bot = z[Y1, X0] * (1 - fx) + z[Y1, X1] * fx
    return top * (1 - fy) + bot * fy  # row 0 = north


def encode(e):
    v = np.floor((e - E_MIN) / (E_MAX - E_MIN) * 255.0 + 0.5)
    return np.clip(v, 0, 255).astype(np.uint8)


def colourise(v):
    """Simple hypsometric tint from encoded bytes, for previews only."""
    e = v.astype(np.float64) / 255.0 * 12000.0 - 6000.0
    rgb = np.zeros(v.shape + (3,), np.float64)
    sea = e < 0
    t = np.clip(-e / 6000.0, 0, 1)[..., None]
    shallow, deep = np.array([120, 190, 230]), np.array([10, 30, 90])
    rgb[sea] = (shallow * (1 - t) + deep * t)[sea]
    u = np.clip(e / 4000.0, 0, 1)[..., None]
    low, mid, high = np.array([70, 140, 60]), np.array([170, 150, 90]), np.array([245, 245, 245])
    land = np.where(u < 0.5, low + (mid - low) * (u / 0.5), mid + (high - mid) * ((u - 0.5) / 0.5))
    rgb[~sea] = land[~sea]
    return Image.fromarray(rgb.astype(np.uint8), "RGB")


def main():
    sources = list_sources()
    if not sources:
        sys.exit(f"no .nc files under {NC_DIR}")
    slices, tiles = [], []
    for idx, ma in enumerate(TARGET_MA):
        src_ma, path = min(sources, key=lambda s: (abs(s[0] - ma), s[0]))
        tile = encode(resample(load(path)))
        tiles.append(tile)
        slices.append({
            "ma": ma,
            "index": idx,
            "source_ma": src_ma if src_ma % 1 else int(src_ma),
            "source_file": path.name,
        })
        land = float((tile >= 128).mean())
        print(f"[{idx:2d}] {ma:>3} Ma <- {src_ma:g} Ma  {path.name}  land={land:.1%}  "
              f"bytes {tile.min()}..{tile.max()}")

    atlas = np.concatenate(tiles, axis=0)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    png = OUT_DIR / "paleo-atlas.png"
    Image.fromarray(atlas, "L").save(png, optimize=True)

    meta = {
        "encoding": ENCODING,
        "width": W,
        "slice_height": H,
        "height": H * len(tiles),
        "elev_min_m": E_MIN,
        "elev_max_m": E_MAX,
        "sea_level_value": 127.5,
        "source": "Scotese, C.R., Wright, N., 2018, PALEOMAP Paleodigital Elevation Models (PaleoDEMS) "
                  "for the Phanerozoic, Zenodo, doi:10.5281/zenodo.5460860 (1deg x 1deg netCDF v2), CC BY 4.0",
        "slices": slices,
    }
    (OUT_DIR / "paleo-atlas.json").write_text(json.dumps(meta, indent=2) + "\n")

    # Preview: 0 Ma above 250 Ma, colourised, 2x scale.
    def big(i):
        return colourise(tiles[i]).resize((W * 2, H * 2), Image.NEAREST)

    i0, i250 = TARGET_MA.index(0), TARGET_MA.index(250)
    prev = Image.new("RGB", (W * 2, H * 4 + 8), (255, 255, 255))
    prev.paste(big(i0), (0, 0))
    prev.paste(big(i250), (0, H * 2 + 8))
    d = ImageDraw.Draw(prev)
    d.text((8, 8), f"0 Ma  ({slices[i0]['source_file']})", fill=(0, 0, 0))
    d.text((8, H * 2 + 16), f"250 Ma  ({slices[i250]['source_file']})", fill=(0, 0, 0))
    prev.save(RESEARCH / "paleo-preview-0-250.png", optimize=True)

    # Contact sheet of all slices.
    cols = 3
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (W * cols, (H + 14) * rows), (255, 255, 255))
    d = ImageDraw.Draw(sheet)
    for i, t in enumerate(tiles):
        x, y = (i % cols) * W, (i // cols) * (H + 14)
        d.text((x + 4, y + 1), f"{slices[i]['ma']} Ma <- {slices[i]['source_ma']} Ma", fill=(0, 0, 0))
        sheet.paste(colourise(t), (x, y + 14))
    sheet.save(RESEARCH / "paleo-contact-sheet.png", optimize=True)
    print(f"wrote {png} {atlas.shape[1]}x{atlas.shape[0]}")


if __name__ == "__main__":
    main()
