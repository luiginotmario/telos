import json, os, subprocess, sys
import numpy as np
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
RAW, OUT = sys.argv[1], sys.argv[2]   # research/raw, public/textures
WORK = os.path.join(RAW, 'work'); os.makedirs(WORK, exist_ok=True)
only = set(sys.argv[3:])
TIERS = {'2k': (2048, 1024), '4k': (4096, 2048)}
meta = {}
def p(*a): return os.path.join(RAW, *a)

def webp(img, body, mapname, tier, lossless=False, q=82, alpha=False):
    d = os.path.join(OUT, body); os.makedirs(d, exist_ok=True)
    tmp = os.path.join(WORK, f'{body}_{mapname}_{tier}.png'); img.save(tmp)
    dst = os.path.join(d, f'{mapname}-{tier}.webp')
    cmd = ['cwebp', '-quiet', '-metadata', 'none', '-m', '6']
    cmd += ['-lossless', '-z', '9'] if lossless else ['-q', str(q), '-sharp_yuv']
    if alpha: cmd += ['-alpha_q', '100', '-exact']
    subprocess.run(cmd + [tmp, '-o', dst], check=True)
    meta.setdefault(body, {}).setdefault(mapname, {})[tier] = {
        'file': f'textures/{body}/{mapname}-{tier}.webp', 'width': img.size[0], 'height': img.size[1],
        'bytes': os.path.getsize(dst)}

def color_tiers(body, mapname, img, tiers=('2k', '4k'), mode='RGB', **kw):
    img = img.convert(mode)
    for t in tiers:
        w, h = TIERS[t]
        if img.size[0] < w: raise SystemExit(f'{body}/{mapname}: source {img.size} smaller than {t}')
        webp(img.resize((w, h), Image.LANCZOS), body, mapname, t, **kw)

def resize_f(a, w, h):
    return np.array(Image.fromarray(a.astype(np.float32), 'F').resize((w, h), Image.BOX if a.shape[1] >= 2 * w else Image.BILINEAR))

def elevation_tiers(body, h_m, lo, hi, sea=None, radius=None, normal=True):
    for t, (w, hgt) in TIERS.items():
        a = resize_f(h_m, w, hgt)
        g = np.clip((a - lo) / (hi - lo) * 255 + 0.5, 0, 255).astype(np.uint8)
        webp(Image.fromarray(g, 'L'), body, 'elevation', t, q=90)
        if normal and radius:
            # tangent-space normal (three.js / OpenGL convention): R=+east (u), G=+north (v up), B=out
            lat = (0.5 - (np.arange(hgt) + 0.5) / hgt) * np.pi
            dx = radius * np.maximum(np.cos(lat), 0.15)[:, None] * (2 * np.pi / w)
            fade = np.clip((88.0 - np.degrees(np.abs(lat))) / 6.0, 0, 1)[:, None]  # flatten toward poles (>82 deg)
            dy = radius * np.pi / hgt
            ex = EXAG.get(body, 1.0)
            gx = (np.roll(a, -1, 1) - np.roll(a, 1, 1)) / (2 * dx) * ex
            an = np.vstack([a[:1], a, a[-1:]])
            gy = (an[:-2] - an[2:]) / (2 * dy) * ex   # north minus south
            n = np.dstack([-gx * fade, -gy * fade, np.ones_like(a)]); n /= np.linalg.norm(n, axis=2, keepdims=True)
            rgb = np.clip((n * 0.5 + 0.5) * 255 + 0.5, 0, 255).astype(np.uint8)
            webp(Image.fromarray(rgb, 'RGB'), body, 'normal', t, q=82)
            meta[body]['normal'][t]['derivedFrom'] = 'elevation'; meta[body]['normal'][t]['exaggeration'] = ex; meta[body]['normal'][t]['poleFade'] = 'slopes faded to flat between 82 and 88 deg latitude'
    e = meta[body]['elevation']
    e['range_m'] = [lo, hi]; e['encoding'] = 'greyscale 8-bit lossy WebP (q90); metres = lo + v/255*(hi-lo)'
    if sea is not None: e['seaLevel_m'] = 0; e['seaLevelValue'] = round((0 - lo) / (hi - lo) * 255, 2)

EXAG = {'moon': 3.0, 'mars': 3.0}

def want(b): return not only or b in only

if want('sun'):     color_tiers('sun', 'color', Image.open(p('sss/8k_sun.jpg')))
if want('mercury'): color_tiers('mercury', 'color', Image.open(p('sss/8k_mercury.jpg')))
if want('venus'):
    color_tiers('venus', 'color', Image.open(p('sss/8k_venus_surface.jpg')))
    color_tiers('venus', 'atmosphere', Image.open(p('sss/4k_venus_atmosphere.jpg')))
if want('earth'):
    color_tiers('earth', 'color', Image.open(p('nasa/world.200406.3x5400x2700.jpg')))
    bm = Image.open(p('nasa/BlackMarble_2016_3km.jpg')).convert('RGB').resize((4096, 2048), Image.LANCZOS)
    a = np.array(bm).astype(np.float32); R, B = a[..., 0], a[..., 2]
    # Black Marble colour composite includes moonlit blue land/ice (R ~= 0.55*B); city light is warm (R >= B).
    k = np.clip((R - 0.6 * B) / np.maximum(0.4 * R, 1.0), 0, 1)
    color_tiers('earth', 'night', Image.fromarray((a * k[..., None] + 0.5).astype(np.uint8), 'RGB'))
    color_tiers('earth', 'clouds', Image.open(p('nasa/cloud_combined_8192.tif')), mode='L')
    color_tiers('earth', 'specular', Image.open(p('sss/8k_earth_specular_map.tif')), mode='L')
    color_tiers('earth', 'normal', Image.open(p('sss/8k_earth_normal_map.tif')), q=90)
    e = np.array(Image.open(p('nasa/gebco_08_rev_elev_5400x2700.tif'))).astype(np.float32)
    b = np.array(Image.open(p('nasa/gebco_08_rev_bath_5400x2700.tif'))).astype(np.float32)
    h = np.where(e > 0, e / 255 * 6400, -(255 - b) / 255 * 8000)
    elevation_tiers('earth', h, -8000.0, 6400.0, sea=0, normal=False)
if want('moon'):
    color_tiers('moon', 'color', Image.open(p('work/moon_color_4k.png')))
    u = np.array(Image.open(p('moon/ldem_16_uint.tif'))).astype(np.float32)
    h = u / 2 - 10000.0
    elevation_tiers('moon', h, float(np.floor(h.min())), float(np.ceil(h.max())), radius=1737400.0)
if want('mars'):
    color_tiers('mars', 'color', Image.open(p('sss/8k_mars.jpg')))
    h = np.fromfile(p('mars/megt90n000eb.img'), dtype='>i2').reshape(2880, 5760).astype(np.float32)
    h = np.roll(h, 2880, axis=1)   # MEGDR starts at 0E; shift so left edge = 180W like the color map
    elevation_tiers('mars', h, float(np.floor(h.min())), float(np.ceil(h.max())), radius=3396000.0)
if want('jupiter'): color_tiers('jupiter', 'color', Image.open(p('sss/8k_jupiter.jpg')))
if want('saturn'):
    color_tiers('saturn', 'color', Image.open(p('sss/8k_saturn.jpg')))
    r = Image.open(p('sss/8k_saturn_ring_alpha.png')).convert('RGBA')
    for t, w in (('2k', 2048), ('4k', 4096)):
        webp(r.resize((w, round(r.size[1] * w / r.size[0])), Image.LANCZOS), 'saturn', 'ring', t, alpha=True)
if want('uranus'):  color_tiers('uranus', 'color', Image.open(p('sss/2k_uranus.jpg')), tiers=('2k',))
if want('neptune'): color_tiers('neptune', 'color', Image.open(p('sss/2k_neptune.jpg')), tiers=('2k',))
if want('milkyway'):
    r = np.fromfile(p('work/milkyway.f32'), dtype=np.float32).reshape(3, 2048, 4096)
    rgb = np.dstack([r[2], r[0], r[1]])  # gbrp planar -> RGB
    rgb = np.clip(rgb, 0, 1)
    s = np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * np.power(rgb, 1 / 2.4) - 0.055)
    img = Image.fromarray((s * 255 + 0.5).astype(np.uint8), 'RGB')
    d = os.path.join(OUT); tmp = os.path.join(WORK, 'milkyway-4k.png'); img.save(tmp)
    for t, (w, hh) in TIERS.items():
        tmp = os.path.join(WORK, f'milkyway-{t}.png'); img.resize((w, hh), Image.LANCZOS).save(tmp)
        dst = os.path.join(OUT, f'milkyway-{t}.webp')
        subprocess.run(['cwebp', '-quiet', '-metadata', 'none', '-m', '6', '-q', '82', '-sharp_yuv', tmp, '-o', dst], check=True)
        meta.setdefault('_sky', {}).setdefault('milkyway', {})[t] = {'file': f'textures/milkyway-{t}.webp', 'width': w, 'height': hh, 'bytes': os.path.getsize(dst)}

json.dump(meta, open(os.path.join(WORK, 'texmeta_' + ('_'.join(sorted(only)) or 'all') + '.json'), 'w'), indent=1)
print(json.dumps(meta, indent=1))
