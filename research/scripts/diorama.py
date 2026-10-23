"""Small, sharp 4 km "diorama" tile at AP-9, Arcadia Planitia, for the miniature-city scene.

Reuses terrain.py (sources, projection, rg16 encoding, caches in research/raw/terrain);
nothing is downloaded. Same orthographic tangent-plane frame as terrain.py: centred on
(lat, lon), north up, +x = east, pixel centres at ((i+0.5)/n - 0.5)*extent.

  diorama-color.webp   1024^2  Murray Lab CTX at native 5 m, bicubic to 3.9 m/px, greyscale
  diorama-tint.webp      64^2  Viking MDIM 2.1 colour (low-frequency multiplier)
  diorama-height.png    256^2  rg16, HRSC/MOLA 200 m DEM, lightly smoothed, bicubic to 15.6 m/px
  diorama.json                 extent, centre, height range, sources, notes

Usage: python -I research/scripts/diorama.py [build|preview]   (default: both)
"""
from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import terrain as T  # noqa: E402

SID = "arcadia-ap9"
SITE = T.SITES[SID]
LAT0, LON0 = SITE["lat"], SITE["lon"]   # requested centre (40.02 N, -156.65 E)
SHIFT_KM = (0.0, 0.0)                    # (east, north) shift applied to the centre, km
EXTENT_M = 4000.0
N_COLOR, N_TINT, N_HEIGHT = 1024, 64, 256
DEM_SIGMA_PX = 0.75                      # Gaussian on the 200 m DEM grid (~150 m)
OD = T.OUT / SID
PREVIEW = T.ROOT / "research" / "diorama-preview.png"


def centre():
    e, n = SHIFT_KM
    lat = LAT0 + math.degrees(n * 1e3 / T.R_MARS)
    lon = LON0 + math.degrees(e * 1e3 / (T.R_MARS * math.cos(math.radians(lat))))
    return lat, lon


# --------------------------------------------------------------------------- resampling
def _keys(t, a=-0.5):
    """Keys cubic-convolution weights for offsets t in [0, 1): taps at -1, 0, 1, 2."""
    def w(x):
        x = np.abs(x)
        return np.where(x <= 1, (a + 2) * x**3 - (a + 3) * x**2 + 1,
                        np.where(x < 2, a * x**3 - 5 * a * x**2 + 8 * a * x - 4 * a, 0.0))
    return [w(t + 1), w(t), w(1 - t), w(2 - t)]


def bicubic(arr, row, col):
    """Bicubic sample of arr at fractional pixel-centre indices (edge-clamped). NaN if any tap is NaN."""
    h, w = arr.shape
    r0 = np.floor(row).astype(np.int64); c0 = np.floor(col).astype(np.int64)
    wr = _keys(row - r0); wc = _keys(col - c0)
    out = np.zeros(row.shape, np.float64)
    for i in range(4):
        ri = np.clip(r0 - 1 + i, 0, h - 1)
        for j in range(4):
            cj = np.clip(c0 - 1 + j, 0, w - 1)
            out += wr[i] * wc[j] * arr[ri, cj]
    inside = (row >= 0) & (row <= h - 1) & (col >= 0) & (col <= w - 1)
    return np.where(inside, out, np.nan)


def gaussian(a, sigma):
    """Separable Gaussian blur (edge-reflected)."""
    r = max(1, int(math.ceil(3 * sigma)))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2); k /= k.sum()
    for ax in (0, 1):
        p = np.pad(a, [(r, r) if i == ax else (0, 0) for i in range(2)], mode="reflect")
        a = sum(k[i] * np.take(p, np.arange(i, i + a.shape[ax]), axis=ax) for i in range(2 * r + 1))
    return a


# --------------------------------------------------------------------------- CTX at native res
def ctx_native(quad, lat_min, lat_max, lon_min, lon_max):
    """Native 5 m window of a quad. Unlike terrain.ctx_window, rows are capped at the TIFF
    height: the fully inflated E-160_N40 file ends with its IFD, which would otherwise be
    read as ~6 rows of garbage at the 40.0 N seam."""
    x0, y0, dx, dy, W, off = T.ctx_quad_geo(quad)
    p = T.RAW / "ctx" / f"{quad}_Mosaic.tif"
    nrows = min((p.stat().st_size - off) // W, T.ctx_ref()["H"])
    mm = np.memmap(p, np.uint8, "r", offset=off, shape=(nrows, W))
    xa, xb = math.radians(lon_min) * T.R_MARS, math.radians(lon_max) * T.R_MARS
    ya, yb = math.radians(lat_max) * T.R_MARS, math.radians(lat_min) * T.R_MARS
    c0 = max(0, int((xa - x0) / dx)); c1 = min(W, int(math.ceil((xb - x0) / dx)))
    r0 = max(0, int((ya - y0) / dy)); r1 = min(nrows, int(math.ceil((yb - y0) / dy)))
    if r1 <= r0 or c1 <= c0:
        return None
    a = np.asarray(mm[r0:r1, c0:c1], np.float32)
    a[a == 0] = np.nan
    return a, (x0 + (c0 + 0.5) * dx, y0 + (r0 + 0.5) * dy, dx, dy)


def sample_ctx(lat, lon, b):
    """Seamless CTX: one native-res buffer spanning both quads, then a single bicubic pass."""
    parts = [w for q in SITE["ctx_quads"] if (w := ctx_native(q, *b)) is not None]
    gx, gy, dx, dy = parts[0][1]
    assert all(abs(p[1][0] - gx) < 1e-3 * dx for p in parts), "quads not column-aligned"
    # quads are row-contiguous on the same eqc grid: stack north -> south
    parts.sort(key=lambda p: -p[1][1])
    rows = [parts[0][0]]
    for a, g in parts[1:]:
        expect = parts[0][1][1] + sum(r.shape[0] for r in rows) * dy
        assert abs(g[1] - expect) < 1e-3 * abs(dy), f"row gap between quads ({(g[1] - expect) / dy:.2f} px)"
        rows.append(a)
    buf = np.concatenate(rows, axis=0)
    seam_rows = np.cumsum([r.shape[0] for r in rows])[:-1]
    col = (np.radians(lon) * T.R_MARS - gx) / dx
    row = (np.radians(lat) * T.R_MARS - gy) / dy
    return bicubic(buf, row, col), buf, (gx, gy, dx, dy), seam_rows


def soft_stretch(g, lo_pct=0.5, hi_pct=99.5, lo_out=18.0, hi_out=237.0):
    """Linear stretch of [p_lo, p_hi] to [lo_out, hi_out]; tails roll off exponentially toward
    0 / 255 (C1-continuous at the knee), so nothing clips."""
    lo, hi = np.nanpercentile(g, [lo_pct, hi_pct])
    u = (g - lo) / (hi - lo) * (hi_out - lo_out) + lo_out
    top, bot = 255.0 - hi_out, lo_out
    u = np.where(u > hi_out, hi_out + top * (1 - np.exp(-(u - hi_out) / top)), u)
    u = np.where(u < lo_out, lo_out - bot * (1 - np.exp(-(lo_out - u) / bot)), u)
    return np.round(u).clip(0, 255).astype(np.uint8), [float(lo), float(hi)]


def write_webp(path, img, q=85):
    tmp = OD / ".diorama_tmp.png"
    Image.fromarray(img).save(tmp)
    try:
        subprocess.run(["cwebp", "-quiet", "-q", str(q), "-m", "6", str(tmp), "-o", str(path)], check=True)
    finally:
        tmp.unlink()


# --------------------------------------------------------------------------- build
def build():
    lat0, lon0 = centre()
    E = EXTENT_M
    OD.mkdir(parents=True, exist_ok=True)
    b = T.bounds(lat0, lon0, E, pad=0.002)
    print(f"centre {lat0:.5f} N {lon0:.5f} E, bounds lat {b[0]:.4f}..{b[1]:.4f} lon {b[2]:.4f}..{b[3]:.4f}")

    # ---- colour
    lat, lon = T.ortho_grid(lat0, lon0, E, N_COLOR)
    g, buf, cgeo, seams = sample_ctx(lat, lon, b)
    nan_frac = float(np.isnan(g).mean())
    assert nan_frac < 1e-3, f"CTX gaps: {nan_frac:.4%}"
    if nan_frac:
        g = np.where(np.isfinite(g), g, np.nanmedian(g))
    g8, (slo, shi) = soft_stretch(g)
    n_tail = float(((g < slo) | (g > shi)).mean())
    print(f"  colour: DN p0.5..p99.5 = {slo:.0f}..{shi:.0f}, min/max {np.nanmin(g):.0f}/{np.nanmax(g):.0f}, "
          f"out {g8.min()}..{g8.max()}, {n_tail:.2%} px in soft tails")
    write_webp(OD / "diorama-color.webp", g8)
    seam_info = []
    for s in seams:
        lat_s = math.degrees((cgeo[1] + (s - 0.5) * cgeo[3]) / T.R_MARS)
        y = (lat_s - lat0) * T.M_PER_DEG
        if abs(y) < E / 2:
            seam_info.append((lat_s, (0.5 - y / E) * N_COLOR))

    # ---- tint
    bc = T.bounds(LAT0, LON0, T.CONTEXT_KM * 1e3, pad=0.05)
    vik, vgeo = T.fetch_viking(f"{SID}-context", *bc)   # cached
    latt, lont = T.ortho_grid(lat0, lon0, E, N_TINT)
    tint = np.stack([T.sample_geo(vik[..., i].astype(np.float32), vgeo, latt, lont) for i in range(3)], -1)
    assert np.isfinite(tint).all()
    write_webp(OD / "diorama-tint.webp", np.clip(np.round(tint), 0, 255).astype(np.uint8))

    # ---- height
    dem, dgeo = T.fetch_dem(f"{SID}-patch", *T.bounds(LAT0, LON0, SITE["extent_km"] * 1e3, pad=0.02))  # cached
    demf = dem.astype(np.float32); demf[dem == -32768] = np.nan
    # crop a generous window (>= 8 DEM px margin) before smoothing
    lon_c0, lat_r0, d = dgeo
    r0 = int((lat_r0 - b[1]) / d) - 8; r1 = int((lat_r0 - b[0]) / d) + 9
    c0 = int((b[2] - lon_c0) / d) - 8; c1 = int((b[3] - lon_c0) / d) + 9
    win = demf[r0:r1, c0:c1].astype(np.float64)
    assert np.isfinite(win).all(), "DEM gaps"
    raw_std = float(np.std(win - gaussian(win, 2.0)))
    sm = gaussian(win, DEM_SIGMA_PX)
    wgeo = (lon_c0 + c0 * d, lat_r0 - r0 * d, d)
    lath, lonh = T.ortho_grid(lat0, lon0, E, N_HEIGHT)
    h = bicubic(sm, (wgeo[1] - lath) / d, (lonh - wgeo[0]) / d)
    h_raw = bicubic(win, (wgeo[1] - lath) / d, (lonh - wgeo[0]) / d)
    assert np.isfinite(h).all()
    hr = T.write_rg16(OD / "diorama-height.png", h)
    print(f"  height {hr} m (raw bicubic {h_raw.min():.1f}..{h_raw.max():.1f}, smoothed {h.min():.1f}..{h.max():.1f}); "
          f"DEM high-pass noise std {raw_std:.1f} m")

    lat_b = T.bounds(lat0, lon0, E)
    shift = SHIFT_KM != (0.0, 0.0)
    notes = [
        f"Diorama tile: {E / 1e3:.0f} km x {E / 1e3:.0f} km in the same orthographic tangent-plane frame as "
        "meta.json (centred on center, north up, +x = east, row 0 = north edge, pixel centres at "
        "((i+0.5)/n - 0.5)*extent).",
        f"diorama-color.webp: Murray Lab CTX mosaic V01 at native 5.0 m/px (quads {', '.join(SITE['ctx_quads'])} "
        f"joined into one buffer, single bicubic pass) resampled to {E / N_COLOR:.2f} m/px (slight upsampling, so "
        f"finest detail is ~10 m); greyscale; gentle stretch: DN {slo:.0f}-{shi:.0f} (0.5-99.5 pct) mapped "
        f"linearly to {18}-{237}, tails ({n_tail:.1%} of px) rolled off smoothly toward 0/255, no clipping.",
        "diorama-tint.webp: Viking MDIM 2.1 colour (Trek zoom 7, ~325 m/px), bilinear to "
        f"{E / N_TINT:.1f} m/px; a near-uniform muted red-brown over 4 km (RGB ~101-117, 84-96, 86-97); use as a low-frequency colour multiplier.",
        f"diorama-height.png: HRSC/MOLA blended DEM 200 m, Gaussian-smoothed (sigma {DEM_SIGMA_PX} px = "
        f"{DEM_SIGMA_PX * 200:.0f} m) on the DEM grid, then bicubic to {E / N_HEIGHT:.1f} m/px. Only ~20 DEM "
        "samples span the tile, so it is a gentle low-frequency surface; the small craters and ripples visible "
        "in CTX have no DEM expression (derive fine relief from diorama-color.webp if needed). Metres relative "
        "to the MOLA areoid; decode metres = lo + (R*256+G)/65535*(hi-lo). Not curvature-corrected "
        "(drop at the tile corner ~r^2/2R = 1.2 m).",
    ]
    if seam_info:
        notes.append("The CTX quad boundary (40.0 N) crosses the tile at colour row "
                     + ", ".join(f"~{r:.0f}" for _, r in seam_info)
                     + "; both quads are tiles of one continuous mosaic on the same grid and were stitched "
                       "before resampling, so there is no tonal or geometric seam.")
    if shift:
        notes.append(f"Centre shifted {SHIFT_KM[0]:+.2f} km east, {SHIFT_KM[1]:+.2f} km north from the AP-9 "
                     f"reference point ({LAT0} N, {LON0} E).")
    meta = dict(
        site=SITE["site"],
        extent_km=E / 1e3,
        center={"lat": round(lat0, 6), "lon": round(lon0, 6)},
        center_requested={"lat": LAT0, "lon": LON0},
        center_shift_km={"east": SHIFT_KM[0], "north": SHIFT_KM[1]},
        extent_deg={"lat": [round(lat_b[0], 5), round(lat_b[1], 5)], "lon": [round(lat_b[2], 5), round(lat_b[3], 5)]},
        height_range_m=hr,
        height_encoding="rg16",
        height_decode="v = R*256 + G (B = 0); metres = lo + v/65535*(hi-lo); relative to the MOLA areoid",
        files={"diorama-color.webp": [N_COLOR, N_COLOR], "diorama-tint.webp": [N_TINT, N_TINT],
               "diorama-height.png": [N_HEIGHT, N_HEIGHT]},
        pixel_m={"color": E / N_COLOR, "tint": E / N_TINT, "height": E / N_HEIGHT},
        sources=[T.SOURCES_COMMON[1], T.SOURCES_COMMON[2], T.SOURCES_COMMON[0]],
        notes=" ".join(notes),
    )
    (OD / "diorama.json").write_text(json.dumps(meta, indent=2) + "\n")
    print("  wrote", OD / "diorama.json")


def preview():
    Image.open(OD / "diorama-color.webp").convert("L").resize((512, 512), Image.LANCZOS).save(PREVIEW, optimize=True)
    print("  wrote", PREVIEW)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "all"
    if cmd in ("build", "all"):
        build()
    if cmd in ("preview", "all"):
        preview()
