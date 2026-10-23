"""Real Mars landing-site terrain for the Telos descent sequence.

Builds, per site, a 1024^2 height map + 2048^2 CTX greyscale image of a ~60 km
patch, a 256^2 colour tint, and a 512^2 / 1024^2 ~600 km context patch, all in
an orthographic (tangent-plane) frame centred on the site: x = east, y = north,
north up.

Usage (always `python -I`):
  python -I research/scripts/terrain.py fetch   # downloads into research/raw/terrain
  python -I research/scripts/terrain.py build   # writes public/terrain/mars/<site>/
  python -I research/scripts/terrain.py preview # research/terrain-preview-<site>.png

Light on CPU by design: one process, at most 4 concurrent HTTP streams, numpy
vectorised resampling, and everything downloaded is cached.

Sources
  DEM   USGS Astrogeology, Mars HRSC/MOLA Blended DEM Global 200 m v2 (uncompressed
        BigTIFF on planetarymaps.usgs.gov -> S3). Only the needed bytes of each row
        are fetched with HTTP Range requests (strip offsets are linear).
  DEM+  Jezero only: USGS Mars 2020 TRN CTX DTM, 20 m (Fergason et al. 2020).
  IMG   Murray Lab Global CTX Mosaic V01 (Dickson et al. 2024), 5 m/px, 4x4 degree
        quads. The zips are deflate-compressed, so the Mosaic.tif member is streamed
        and inflated only up to the last row needed.
  TINT  Viking MDIM 2.1 colour mosaic (USGS), via NASA Mars Trek WMTS, zoom 7.
"""
from __future__ import annotations

import http.client
import json
import math
import os
import ssl
import struct
import subprocess
import sys
import threading
import zlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "research" / "raw" / "terrain"
OUT = ROOT / "public" / "terrain" / "mars"
R_MARS = 3396190.0  # IAU Mars 2000 sphere, m (all sources use this radius)
M_PER_DEG = R_MARS * math.pi / 180.0
MAX_CONN = 4

SITES = {
    "arcadia-ap9": dict(
        site="AP-9, Arcadia Planitia (SpaceX Starship candidate landing site)",
        lat=40.02, lon=-156.65,
        # 58 km keeps the patch inside the CTX quad E-160 (the east edge would
        # otherwise cross -156 E by 0.01 deg, forcing two more 1.8 GB quads).
        extent_km=58.0,
        ctx_quads=["E-160_N40", "E-160_N36"],
        notes=["No HiRISE/CTX DTM is openly published for AP-9, so height is the 200 m HRSC/MOLA blend only. "
               "Over these very smooth plains (~300 m total relief) the HRSC strips show as rectangular "
               "patches of ~10-20 m stereo noise against smoother MOLA-only areas; low-relief features seen in "
               "CTX (e.g. the ~7 km bright-rimmed ghost crater near the north edge) have little or no DEM "
               "expression. Let CTX carry the fine detail (e.g. derive a normal map from color.webp).",
               "color.webp crosses the CTX quad seam at 40.0 N (row ~1064 of 2048); it is tone-continuous."],
    ),
    "jezero": dict(
        site="Jezero Crater (Mars 2020 Perseverance landing site)",
        lat=18.4457, lon=77.4508,
        extent_km=60.0,
        ctx_quads=["E076_N16"],
        ctx_dtm="https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/"
                "JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m_Eqc_latTs0_lon0.tif",
        notes=["The 1 m HiRISE DTM (1.8 GB, 77.22-77.58E 18.31-18.67N) exists but is ~60x finer than "
               "height.png's 58.6 m/px, so the 20 m CTX DTM was used instead; the visible rectangle in a "
               "hillshade is the CTX DTM footprint (sharper texture inside)."],
    ),
}
CONTEXT_KM = 600.0
N_HEIGHT, N_COLOR, N_TINT = 1024, 2048, 256
N_CTX_HEIGHT, N_CTX_COLOR = 512, 1024

DEM_URL = ("https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/HRSC_MOLA_Blend/"
           "Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif")
DEM_PAGE = "https://planetarymaps.usgs.gov/mosaic/Mars/HRSC_MOLA_Blend/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif"
DEM_W, DEM_H = 106694, 53347
DEM_RES = 0.003374120830641  # deg/px
DEM_OFF0, DEM_ROW = 854272, 213388  # verified: BLOCK_OFFSET_0_r = OFF0 + r*ROW
CTX_ZIP = "https://murray-lab.caltech.edu/CTX/V01/tiles/MurrayLab_GlobalCTXMosaic_V01_{q}.zip"
VIKING = ("https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/"
          "default/default028mm/{z}/{row}/{col}.jpg")
VIKING_Z, VIKING_TILE = 7, 256
VIKING_DEG_PX = 360.0 / (2 ** (VIKING_Z + 1) * VIKING_TILE)


# --------------------------------------------------------------------------- geometry
def ortho_grid(lat0: float, lon0: float, extent_m: float, n: int):
    """lat/lon (deg) of pixel centres of an n x n orthographic patch, north up."""
    c = (np.arange(n) + 0.5) / n * extent_m - extent_m / 2
    x, y = np.meshgrid(c, -c)  # row 0 = north
    rho = np.hypot(x, y)
    cc = np.arcsin(np.clip(rho / R_MARS, -1, 1))
    p0, l0 = math.radians(lat0), math.radians(lon0)
    with np.errstate(invalid="ignore", divide="ignore"):
        sin_c, cos_c = np.sin(cc), np.cos(cc)
        lat = np.arcsin(cos_c * math.sin(p0) + np.where(rho > 0, y * sin_c * math.cos(p0) / rho, 0))
        lon = l0 + np.arctan2(x * sin_c, rho * cos_c * math.cos(p0) - y * sin_c * math.sin(p0))
    return np.degrees(lat), np.degrees(lon)


def bounds(lat0, lon0, extent_m, pad=0.0):
    # 65 samples whose outermost pixel centres sit exactly on the patch edges
    lat, lon = ortho_grid(lat0, lon0, extent_m * 65 / 64, 65)
    return (float(lat.min()) - pad, float(lat.max()) + pad, float(lon.min()) - pad, float(lon.max()) + pad)


def bilinear(arr, row, col):
    """Bilinear sample arr (float, NaN = nodata) at fractional pixel-centre indices."""
    h, w = arr.shape
    r0 = np.clip(np.floor(row).astype(np.int64), 0, h - 2)
    c0 = np.clip(np.floor(col).astype(np.int64), 0, w - 2)
    fr = np.clip(row - r0, 0, 1)
    fc = np.clip(col - c0, 0, 1)
    a = arr[r0, c0]; b = arr[r0, c0 + 1]; c = arr[r0 + 1, c0]; d = arr[r0 + 1, c0 + 1]
    return (a * (1 - fc) + b * fc) * (1 - fr) + (c * (1 - fc) + d * fc) * fr


def block_mean(a, k):
    """k x k box average (NaN-aware) of a 2-D float array."""
    if k <= 1:
        return a
    h, w = (a.shape[0] // k) * k, (a.shape[1] // k) * k
    v = a[:h, :w].reshape(h // k, k, w // k, k)
    with np.errstate(invalid="ignore"):
        return np.nanmean(v, axis=(1, 3))


# --------------------------------------------------------------------------- http
_ctx = ssl.create_default_context(cafile=__import__("certifi").where())
_local = threading.local()


def _conn(host):
    pool = getattr(_local, "pool", None)
    if pool is None:
        pool = _local.pool = {}
    if host not in pool:
        pool[host] = http.client.HTTPSConnection(host, context=_ctx, timeout=60)
    return pool[host]


def http_get(url, start=None, end=None, tries=4):
    u = urlsplit(url)
    headers = {"User-Agent": "telos-terrain/1.0"}
    if start is not None:
        headers["Range"] = f"bytes={start}-{end}"
    for t in range(tries):
        try:
            c = _conn(u.netloc)
            c.request("GET", u.path + (("?" + u.query) if u.query else ""), headers=headers)
            r = c.getresponse()
            body = r.read()
            if r.status in (200, 206):
                return body
            if r.status == 404:
                return None
            raise IOError(f"HTTP {r.status} {url}")
        except (OSError, http.client.HTTPException):
            _local.pool.pop(u.netloc, None)
            if t == tries - 1:
                raise


# --------------------------------------------------------------------------- DEM
def fetch_dem(name, lat_min, lat_max, lon_min, lon_max):
    """Window of the HRSC/MOLA blend (int16 m) via per-row byte ranges. Cached."""
    path = RAW / "dem" / f"{name}.npz"
    if path.exists():
        z = np.load(path)
        return z["h"], tuple(z["geo"])
    r0 = max(0, int(math.floor((90 - lat_max) / DEM_RES)))
    r1 = min(DEM_H - 1, int(math.ceil((90 - lat_min) / DEM_RES)))
    c0 = max(0, int(math.floor((lon_min + 180) / DEM_RES)))
    c1 = min(DEM_W - 1, int(math.ceil((lon_max + 180) / DEM_RES)))
    rows = list(range(r0, r1 + 1))
    print(f"  DEM {name}: rows {r0}-{r1} cols {c0}-{c1} ({len(rows)} range requests)")

    def one(r):
        s = DEM_OFF0 + r * DEM_ROW + c0 * 2
        return np.frombuffer(http_get(DEM_URL, s, s + (c1 - c0 + 1) * 2 - 1), "<i2")

    with ThreadPoolExecutor(MAX_CONN) as ex:
        h = np.stack(list(ex.map(one, rows)))
    # geo: lon of col-0 centre, lat of row-0 centre, deg/px
    geo = (-180 + (c0 + 0.5) * DEM_RES, 90 - (r0 + 0.5) * DEM_RES, DEM_RES)
    np.savez_compressed(path, h=h, geo=np.array(geo))
    return h, geo


# --------------------------------------------------------------------------- CTX
def zip_member(url, suffix):
    """(data_start, comp_size, uncomp_size) of the member ending with suffix."""
    size = int(subprocess.run(["curl", "-skI", url], capture_output=True, text=True, check=True)
               .stdout.lower().split("content-length:")[1].split()[0])
    tail = subprocess.run(["curl", "-sk", "-r", f"{size - 65536}-{size - 1}", url],
                          capture_output=True, check=True).stdout
    j = tail.find(b"PK\x01\x02")
    while j >= 0:
        csz, usz = struct.unpack("<II", tail[j + 20:j + 28])
        fl, el, cl = struct.unpack("<HHH", tail[j + 28:j + 34])
        off, = struct.unpack("<I", tail[j + 42:j + 46])
        name = tail[j + 46:j + 46 + fl].decode()
        if name.endswith(suffix):
            head = subprocess.run(["curl", "-sk", "-r", f"{off}-{off + 29}", url],
                                  capture_output=True, check=True).stdout
            lfl, lel = struct.unpack("<HH", head[26:30])
            return off + 30 + lfl + lel, csz, usz
        j = tail.find(b"PK\x01\x02", j + 4)
    raise KeyError(suffix)


def stream_ctx(quad, need_bytes=None):
    """Inflate the quad's Mosaic.tif to RAW/ctx/<quad>.tif, stopping after need_bytes.

    murray-lab.caltech.edu serves an incomplete certificate chain, hence curl -k;
    the payload is image data only and is never executed.
    """
    out = RAW / "ctx" / f"{quad}_Mosaic.tif"
    url = CTX_ZIP.format(q=quad)
    start, csz, usz = zip_member(url, "_Mosaic.tif")
    want = usz if need_bytes is None else min(usz, need_bytes)
    if out.exists() and out.stat().st_size >= want:
        return out
    print(f"  CTX {quad}: inflating {want / 1e9:.2f} of {usz / 1e9:.2f} GB (zip member {csz / 1e9:.2f} GB)")
    p = subprocess.Popen(["curl", "-sk", "-r", f"{start}-{start + csz - 1}", url], stdout=subprocess.PIPE)
    d = zlib.decompressobj(-15)
    got = 0
    with open(out, "wb") as f:
        while got < want:
            chunk = p.stdout.read(1 << 20)
            if not chunk:
                break
            data = d.decompress(chunk)
            f.write(data)
            got += len(data)
    p.kill(); p.wait()
    print(f"  CTX {quad}: wrote {got / 1e9:.2f} GB")
    return out


# --------------------------------------------------------------------------- Viking
def fetch_viking(name, lat_min, lat_max, lon_min, lon_max):
    """Mosaic of Viking MDIM2.1 colour WMTS tiles. Returns rgb uint8 + geo."""
    path = RAW / "viking" / f"{name}.png"
    tdeg = VIKING_TILE * VIKING_DEG_PX
    tr0, tr1 = int((90 - lat_max) // tdeg), int((90 - lat_min) // tdeg)
    tc0, tc1 = int((lon_min + 180) // tdeg), int((lon_max + 180) // tdeg)
    geo = (-180 + tc0 * tdeg + VIKING_DEG_PX / 2, 90 - tr0 * tdeg - VIKING_DEG_PX / 2, VIKING_DEG_PX)
    if path.exists():
        return np.asarray(Image.open(path).convert("RGB")), geo
    jobs = [(r, c) for r in range(tr0, tr1 + 1) for c in range(tc0, tc1 + 1)]
    print(f"  Viking {name}: {len(jobs)} tiles")
    tiledir = RAW / "viking" / "tiles"
    tiledir.mkdir(parents=True, exist_ok=True)

    def one(rc):
        r, c = rc
        tp = tiledir / f"{VIKING_Z}_{r}_{c}.jpg"
        if not tp.exists():
            b = http_get(VIKING.format(z=VIKING_Z, row=r, col=c))
            tp.write_bytes(b)
        return rc, np.asarray(Image.open(tp).convert("RGB"))

    mos = np.zeros(((tr1 - tr0 + 1) * VIKING_TILE, (tc1 - tc0 + 1) * VIKING_TILE, 3), np.uint8)
    with ThreadPoolExecutor(MAX_CONN) as ex:
        for (r, c), im in ex.map(one, jobs):
            y, x = (r - tr0) * VIKING_TILE, (c - tc0) * VIKING_TILE
            mos[y:y + VIKING_TILE, x:x + VIKING_TILE] = im
    Image.fromarray(mos).save(path)
    return mos, geo


def ctx_bytes_needed(site, quad_top_lat, width_px):
    """Bytes of the quad TIFF (data from offset 8, 1 byte/px) down to the patch's south edge."""
    s = SITES[site]
    lat_min, *_ = bounds(s["lat"], s["lon"], s["extent_km"] * 1e3, pad=0.01)
    rows = math.ceil(math.radians(quad_top_lat - lat_min) * R_MARS / 5.0) + 16
    return 8 + rows * width_px


def cmd_fetch():
    for d in ("ctx", "dem", "viking"):
        (RAW / d).mkdir(parents=True, exist_ok=True)
    # CTX first (largest). E-160_N40 is needed almost to its end, so inflate it whole;
    # that also gives the definitive IFD (width, geotransform) for the partial quads.
    jobs = []
    with ThreadPoolExecutor(3) as ex:
        jobs.append(ex.submit(stream_ctx, "E-160_N40"))
        jobs.append(ex.submit(stream_ctx, "E-160_N36", ctx_bytes_needed("arcadia-ap9", 40.0, 47500)))
        jobs.append(ex.submit(stream_ctx, "E076_N16", ctx_bytes_needed("jezero", 20.0, 47500)))
        for j in jobs:
            j.result()
    for sid, s in SITES.items():
        lat0, lon0 = s["lat"], s["lon"]
        b = bounds(lat0, lon0, s["extent_km"] * 1e3, pad=0.02)
        fetch_dem(f"{sid}-patch", *b)
        bc = bounds(lat0, lon0, CONTEXT_KM * 1e3, pad=0.05)
        fetch_dem(f"{sid}-context", *bc)
        fetch_viking(f"{sid}-context", *bc)
        if "ctx_dtm" in s:
            p = RAW / "dem" / Path(s["ctx_dtm"]).name
            if not p.exists():
                subprocess.run(["curl", "-sL", "--fail", "-o", str(p), s["ctx_dtm"]], check=True)


# --------------------------------------------------------------------------- CTX read
def quad_ll(quad):
    m = __import__("re").match(r"E(-?\d+)_N(-?\d+)", quad)
    return int(m.group(1)), int(m.group(2))  # lon_min, lat_min


_REF = {}


def ctx_ref():
    """Georeferencing of the fully inflated reference quad E-160_N40 (IFD is at its end)."""
    if not _REF:
        import rasterio
        p = RAW / "ctx" / "E-160_N40_Mosaic.tif"
        with rasterio.open(p) as d:
            t = d.transform
            assert d.count == 1 and d.dtypes[0] == "uint8" and not d.profile.get("tiled")
            assert d.compression is None
            off0 = int(d.get_tag_item("BLOCK_OFFSET_0_0", "TIFF", bidx=1))
            bh = d.block_shapes[0][0]
            off1 = int(d.get_tag_item(f"BLOCK_OFFSET_0_{d.height // bh - 1}", "TIFF", bidx=1))
            assert off1 == off0 + (d.height // bh - 1) * bh * d.width, "strips not contiguous"
            _REF.update(W=d.width, H=d.height, off=off0, x0=t.c, y0=t.f, dx=t.a, dy=t.e,
                        lon_min=-160, lat_max=44)
            print(f"  CTX ref quad: {d.width}x{d.height}, data@{off0}, x0={t.c:.2f} y0={t.f:.2f} px={t.a}")
    return _REF


def ctx_quad_geo(quad):
    ref = ctx_ref()
    lon_min, lat_min = quad_ll(quad)
    x0 = ref["x0"] + math.radians(lon_min - ref["lon_min"]) * R_MARS
    y0 = ref["y0"] + math.radians(lat_min + 4 - ref["lat_max"]) * R_MARS
    return x0, y0, ref["dx"], ref["dy"], ref["W"], ref["off"]


def ctx_window(quad, lat_min, lat_max, lon_min, lon_max, k):
    """Block-averaged (k x k) float window of a quad, NaN = nodata/not inflated.

    Returns arr, (x of col-0 centre, y of row-0 centre, dx, dy) in eqc metres.
    """
    x0, y0, dx, dy, W, off = ctx_quad_geo(quad)
    p = RAW / "ctx" / f"{quad}_Mosaic.tif"
    nrows_avail = (p.stat().st_size - off) // W
    mm = np.memmap(p, np.uint8, "r", offset=off, shape=(nrows_avail, W))
    xa, xb = math.radians(lon_min) * R_MARS, math.radians(lon_max) * R_MARS
    ya, yb = math.radians(lat_max) * R_MARS, math.radians(lat_min) * R_MARS
    c0 = max(0, int((xa - x0) / dx)); c1 = min(W, int(math.ceil((xb - x0) / dx)))
    r0 = max(0, int((ya - y0) / dy)); r1 = min(nrows_avail, int(math.ceil((yb - y0) / dy)))
    if r1 <= r0 or c1 <= c0:
        return None
    r1 = r0 + ((r1 - r0) // k) * k; c1 = c0 + ((c1 - c0) // k) * k
    out = np.empty(((r1 - r0) // k, (c1 - c0) // k), np.float32)
    step = 100 * k
    for r in range(r0, r1, step):
        blk = np.asarray(mm[r:min(r + step, r1), c0:c1], np.float32)
        blk[blk == 0] = np.nan
        out[(r - r0) // k:(r - r0) // k + blk.shape[0] // k] = block_mean(blk, k)
    geo = (x0 + (c0 + (k - 1) / 2 + 0.5) * dx, y0 + (r0 + (k - 1) / 2 + 0.5) * dy, dx * k, dy * k)
    return out, geo


def sample_eqc(arr, geo, lat, lon):
    gx, gy, dx, dy = geo
    col = (np.radians(lon) * R_MARS - gx) / dx
    row = (np.radians(lat) * R_MARS - gy) / dy
    v = bilinear(arr, row, col)
    inside = (row >= 0) & (row <= arr.shape[0] - 1) & (col >= 0) & (col <= arr.shape[1] - 1)
    return np.where(inside, v, np.nan)


def sample_geo(arr, geo, lat, lon):
    """geo = (lon of col-0 centre, lat of row-0 centre, deg/px), north-up."""
    lon0, lat0, d = geo
    col = (lon - lon0) / d
    row = (lat0 - lat) / d
    v = bilinear(arr, row, col)
    inside = (row >= 0) & (row <= arr.shape[0] - 1) & (col >= 0) & (col <= arr.shape[1] - 1)
    return np.where(inside, v, np.nan)


def block_geo(geo, k):
    lon0, lat0, d = geo
    return (lon0 + (k - 1) / 2 * d, lat0 - (k - 1) / 2 * d, d * k)


def box_blur(a, r):
    """Separable box blur, radius r px (edge-clamped), via cumulative sums."""
    for ax in (0, 1):
        p = np.pad(a, [(r + 1, r) if i == ax else (0, 0) for i in range(2)], mode="edge")
        c = np.cumsum(p, axis=ax, dtype=np.float64)
        n = a.shape[ax]
        hi = np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=ax)
        lo = np.take(c, np.arange(0, n), axis=ax)
        a = ((hi - lo) / (2 * r + 1)).astype(np.float32)
    return a


# --------------------------------------------------------------------------- writers
def write_rg16(path, h):
    lo, hi = math.floor(float(np.nanmin(h))), math.ceil(float(np.nanmax(h)))
    v = np.round((h - lo) / (hi - lo) * 65535).astype(np.uint32)
    rgb = np.zeros(h.shape + (3,), np.uint8)
    rgb[..., 0] = v >> 8
    rgb[..., 1] = v & 255
    Image.fromarray(rgb, "RGB").save(path, optimize=True)
    return [lo, hi]


def write_webp(path, img):
    tmp = RAW / "work_tmp.png"
    Image.fromarray(img).save(tmp)
    subprocess.run(["cwebp", "-quiet", "-q", "82", "-m", "4", str(tmp), "-o", str(path)], check=True)
    tmp.unlink()


def stretch(g, lo_pct=0.5, hi_pct=99.5):
    lo, hi = np.nanpercentile(g, [lo_pct, hi_pct])
    return np.clip((g - lo) / (hi - lo) * 255, 0, 255).astype(np.uint8), [float(lo), float(hi)]


def fill_nan(a, guide):
    """Fill NaNs in a from guide, matched in mean/std over the valid area."""
    m = np.isfinite(a)
    if m.all():
        return a, 0.0
    g = guide.astype(np.float32)
    gm, gs = np.nanmean(g[m]), np.nanstd(g[m]) + 1e-6
    am, as_ = np.nanmean(a[m]), np.nanstd(a[m])
    out = np.where(m, a, (g - gm) / gs * as_ + am)
    return out, float(1 - m.mean())


# --------------------------------------------------------------------------- build
def build_site(sid):
    s = SITES[sid]
    lat0, lon0 = s["lat"], s["lon"]
    E = s["extent_km"] * 1e3
    od = OUT / sid
    od.mkdir(parents=True, exist_ok=True)
    notes = []
    print(f"[{sid}]")

    # ---- patch height
    dem, dgeo = fetch_dem(f"{sid}-patch", *bounds(lat0, lon0, E, pad=0.02))
    demf = dem.astype(np.float32); demf[dem == -32768] = np.nan
    lat, lon = ortho_grid(lat0, lon0, E, N_HEIGHT)
    h = sample_geo(demf, dgeo, lat, lon)
    dem_desc = "HRSC/MOLA blended DEM 200 m"
    if "ctx_dtm" in s:
        import rasterio
        p = RAW / "dem" / Path(s["ctx_dtm"]).name
        with rasterio.open(p) as d:
            t = d.transform
            z = d.read(1).astype(np.float32)
            nd = d.nodata
            if nd is not None:
                z[z == nd] = np.nan
            z[z < -1e4] = np.nan
            print(f"  CTX DTM: {d.width}x{d.height}, px={t.a:.2f} m, crs={d.crs.to_proj4()}")
        k = 2
        zb = block_mean(z, k)
        zgeo = (t.c + (k / 2) * t.a, t.f + (k / 2) * t.e, t.a * k, t.e * k)
        hc = sample_eqc(zb, zgeo, lat, lon)
        both = np.isfinite(hc) & np.isfinite(h)
        off = float(np.median(hc[both] - h[both]))
        cover = float(np.isfinite(hc).mean())
        m = np.isfinite(hc).astype(np.float32)
        r = 24  # ~1.4 km feather
        w = np.clip(box_blur(m, r) * 2 - 1, 0, 1) * m
        w = w * w * (3 - 2 * w)
        h = np.where(m > 0, w * (np.nan_to_num(hc) - off) + (1 - w) * h, h)
        dem_desc += f" + USGS CTX DTM 20 m blended over the central {cover * 100:.0f}% of the patch"
        notes.append(f"Jezero height: CTX DTM (20 m, resampled from 40 m blocks) covers {cover * 100:.0f}% of the "
                     f"patch (77.16-77.70E, 18.21-18.72N), shifted by {-off:+.1f} m (median offset to the "
                     f"HRSC/MOLA blend) and feathered over ~1.4 km into the 200 m HRSC/MOLA blend elsewhere.")
    assert np.isfinite(h).all(), "height has gaps"
    hr = write_rg16(od / "height.png", h)

    # ---- patch colour: Murray Lab CTX, 5 m -> 25 m blocks -> 2048 px
    latc, lonc = ortho_grid(lat0, lon0, E, N_COLOR)
    b = bounds(lat0, lon0, E, pad=0.01)
    g = np.full(latc.shape, np.nan, np.float32)
    for q in s["ctx_quads"]:
        w = ctx_window(q, *b, k=5)
        if w is None:
            continue
        v = sample_eqc(w[0], w[1], latc, lonc)
        g = np.where(np.isfinite(g), g, v)

    # ---- Viking colour (context mosaic also covers the patch)
    bc = bounds(lat0, lon0, CONTEXT_KM * 1e3, pad=0.05)
    vik, vgeo = fetch_viking(f"{sid}-context", *bc)
    vikf = vik.astype(np.float32)
    vlum = sample_geo(vikf.mean(axis=2), vgeo, latc, lonc)
    g, gap = fill_nan(g, vlum)
    if gap > 0:
        notes.append(f"CTX nodata ({gap * 100:.2f}% of color.webp) filled with Viking luminance.")
    g8, _ = stretch(g)
    write_webp(od / "color.webp", g8)

    latt, lont = ortho_grid(lat0, lon0, E, N_TINT)
    tint = np.stack([sample_geo(vikf[..., i], vgeo, latt, lont) for i in range(3)], -1)
    write_webp(od / "tint.webp", np.clip(tint, 0, 255).astype(np.uint8))

    # ---- context
    EC = CONTEXT_KM * 1e3
    cdem, cgeo = fetch_dem(f"{sid}-context", *bc)
    cf = cdem.astype(np.float32); cf[cdem == -32768] = np.nan
    k = 5  # 200 m -> 1 km blocks for a 1.17 km output grid
    cb = block_mean(cf, k)
    latx, lonx = ortho_grid(lat0, lon0, EC, N_CTX_HEIGHT)
    ch = sample_geo(cb, block_geo(cgeo, k), latx, lonx)
    assert np.isfinite(ch).all()
    chr_ = write_rg16(od / "context-height.png", ch)
    latx, lonx = ortho_grid(lat0, lon0, EC, N_CTX_COLOR)
    cc = np.stack([sample_geo(vikf[..., i], vgeo, latx, lonx) for i in range(3)], -1)
    write_webp(od / "context-color.webp", np.clip(cc, 0, 255).astype(np.uint8))

    lat_b = bounds(lat0, lon0, E)
    lat_cb = bounds(lat0, lon0, EC)
    meta = dict(
        site=s["site"], id=sid, lat=lat0, lon=lon0,
        extent_km=s["extent_km"],
        extent_deg={"lat": [round(lat_b[0], 5), round(lat_b[1], 5)], "lon": [round(lat_b[2], 5), round(lat_b[3], 5)]},
        height_range_m=hr,
        height_encoding="rg16",
        height_decode="v = R*256 + G (B = 0); metres = lo + v/65535*(hi-lo); metres are relative to the MOLA areoid",
        files={"height.png": [N_HEIGHT, N_HEIGHT], "color.webp": [N_COLOR, N_COLOR], "tint.webp": [N_TINT, N_TINT],
               "context-height.png": [N_CTX_HEIGHT, N_CTX_HEIGHT], "context-color.webp": [N_CTX_COLOR, N_CTX_COLOR]},
        projection=("orthographic (tangent plane) centred on (lat, lon) on the 3396.19 km Mars 2000 sphere; "
                    "image row 0 = north edge, +x = east, +y = north; pixel centres at ((i+0.5)/n - 0.5)*extent. "
                    "Heights are NOT curvature-corrected: the sphere falls away from the tangent plane by "
                    "r^2/(2R) (~66 m at 20 km, ~13.2 km at the 300 km context edge)."),
        pixel_m={"height": E / N_HEIGHT, "color": E / N_COLOR, "context_height": EC / N_CTX_HEIGHT,
                 "context_color": EC / N_CTX_COLOR},
        context={"extent_km": CONTEXT_KM, "height_range_m": chr_,
                 "extent_deg": {"lat": [round(lat_cb[0], 4), round(lat_cb[1], 4)],
                                "lon": [round(lat_cb[2], 4), round(lat_cb[3], 4)]},
                 "height_encoding": "rg16"},
        sources=SOURCES_COMMON + (SOURCES_JEZERO if sid == "jezero" else []),
        notes=" ".join([
            f"height.png: {dem_desc}, bilinear to {E / N_HEIGHT:.1f} m/px.",
            f"color.webp: Murray Lab global CTX mosaic V01 (5 m/px, quads {', '.join(s['ctx_quads'])}), "
            f"5x5 box-averaged then bilinear to {E / N_COLOR:.1f} m/px, greyscale, 0.5-99.5 percentile stretch.",
            "tint.webp and context-color.webp: Viking MDIM 2.1 colour mosaic (~232 m native, Trek zoom 7 ~325 m/px); "
            "use tint as a low-frequency colour multiplier for the greyscale CTX.",
            f"context-height.png: HRSC/MOLA blend, 1 km box-averaged, bilinear to {EC / N_CTX_HEIGHT:.0f} m/px.",
        ] + notes + s.get("notes", []) + ([f"Extent is {s['extent_km']:.0f} km (not 60) so the patch stays inside CTX quad E-160 "
                      "(lon < -156 E)."] if sid == "arcadia-ap9" else [])),
    )
    (od / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(f"  height {hr} m, context {chr_} m")
    return meta


SOURCES_COMMON = [
    dict(title="Mars HRSC MOLA Blended DEM Global 200m v2 (Fergason, Hare & Laura 2018), USGS Astrogeology",
         url="https://astrogeology.usgs.gov/search/map/mars_mgs_mola_mex_hrsc_blended_dem_global_200m",
         licence="Public domain (USGS); HRSC data ESA/DLR/FU Berlin, MOLA NASA/GSFC"),
    dict(title="Murray Lab Global CTX Mosaic of Mars V01 (Dickson et al. 2024, Earth and Space Science, "
               "doi:10.1029/2024EA003555)",
         url="https://murray-lab.caltech.edu/CTX/",
         licence="Free to use with citation (CTX images NASA/JPL-Caltech/MSSS; mosaic Caltech Murray Lab)"),
    dict(title="Viking MDIM 2.1 Colour Mosaic 232 m (USGS), via NASA Mars Trek WMTS",
         url="https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/WMTSCapabilities.xml",
         licence="Public domain (NASA/USGS)"),
]
SOURCES_JEZERO = [
    dict(title="Mars 2020 Terrain Relative Navigation CTX DTM, Jezero, 20 m (Fergason et al. 2020), USGS Astrogeology",
         url="https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/"
             "JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m_Eqc_latTs0_lon0.tif",
         licence="Public domain (USGS); CTX images NASA/JPL-Caltech/MSSS"),
]


def cmd_build():
    for sid in SITES:
        build_site(sid)


# --------------------------------------------------------------------------- preview
def decode_rg16(path, rng):
    a = np.asarray(Image.open(path).convert("RGB")).astype(np.float32)
    return rng[0] + (a[..., 0] * 256 + a[..., 1]) / 65535 * (rng[1] - rng[0])


def hillshade(h, px, az=315.0, alt=35.0, zf=1.0):
    gy, gx = np.gradient(h * zf, px)
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(gy, -gx)  # ESRI convention; gy is d/d(row) = d/d(south)
    azr, altr = math.radians(360 - az + 90), math.radians(alt)
    s = np.sin(altr) * np.cos(slope) + np.cos(altr) * np.sin(slope) * np.cos(azr - aspect)
    return np.clip(s * 255, 0, 255).astype(np.uint8)


def cmd_preview():
    for sid in SITES:
        od = OUT / sid
        m = json.loads((od / "meta.json").read_text())
        h = decode_rg16(od / "height.png", m["height_range_m"])
        hs = hillshade(h, m["pixel_m"]["height"], zf=3.0)
        ch = decode_rg16(od / "context-height.png", m["context"]["height_range_m"])
        chs = hillshade(ch, m["pixel_m"]["context_height"], zf=3.0)
        col = Image.open(od / "color.webp").convert("L").resize((512, 512), Image.LANCZOS)
        tint = Image.open(od / "tint.webp").convert("RGB").resize((512, 512), Image.BICUBIC)
        cc = Image.open(od / "context-color.webp").convert("RGB").resize((512, 512), Image.LANCZOS)
        sheet = Image.new("RGB", (512 * 3, 1024), (0, 0, 0))
        sheet.paste(Image.fromarray(hs).resize((512, 512), Image.LANCZOS).convert("RGB"), (0, 0))
        sheet.paste(col.convert("RGB"), (512, 0))
        tinted = (np.asarray(col, np.float32)[..., None] / 255 * np.asarray(tint, np.float32)
                  / np.maximum(np.asarray(tint, np.float32).mean(axis=2, keepdims=True), 1) * 160)
        sheet.paste(Image.fromarray(np.clip(tinted, 0, 255).astype(np.uint8)), (1024, 0))
        sheet.paste(Image.fromarray(chs).resize((512, 512), Image.LANCZOS).convert("RGB"), (0, 512))
        sheet.paste(cc, (512, 512))
        # context with the patch outline
        ov = np.asarray(Image.fromarray(chs).resize((512, 512)).convert("RGB")).copy()
        f = m["extent_km"] / m["context"]["extent_km"]
        a, b2 = int(256 - 256 * f), int(256 + 256 * f)
        ov[a:b2, [a, b2 - 1]] = (255, 80, 40); ov[[a, b2 - 1], a:b2] = (255, 80, 40)
        sheet.paste(Image.fromarray(ov), (1024, 512))
        p = ROOT / "research" / f"terrain-preview-{sid}.png"
        sheet.save(p, optimize=True)
        print("  wrote", p)

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "all"
    if cmd in ("fetch", "all"):
        cmd_fetch()
    if cmd in ("build", "all"):
        cmd_build()
    if cmd in ("preview", "all"):
        cmd_preview()
