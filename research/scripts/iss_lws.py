"""
NASA JSC's ISS 2011 LightWave scene (.lws + .lwo) -> one OBJ/MTL for Blender.

Blender ships no LightWave importer, so this reads the formats directly:
  * LWS: item hierarchy (ParentItem), pivots, and frame-0 transforms (9 channels: X Y Z H P B SX SY SZ)
  * LWO2: IFF chunks LAYR / PNTS / POLS / PTAG(SURF) / TAGS / SURF(COLR, DIFF, SPEC, LUMI, TRAN)
LightWave is left-handed (+Z away from viewer); we flip Z and polygon winding for glTF.

  python3 -I research/scripts/iss_lws.py <extracted dir> <out.obj>
"""
import math
import os
import re
import struct
import sys


# ── LWO2 ────────────────────────────────────────────────────────────────────

def read_s0(b, o):
    e = b.index(b"\0", o)
    s = b[o:e].decode("latin-1")
    n = e - o + 1
    if n % 2: n += 1
    return s, o + n


def read_vx(b, o):
    if b[o] == 0xFF:
        return struct.unpack(">I", b[o:o + 4])[0] & 0xFFFFFF, o + 4
    return struct.unpack(">H", b[o:o + 2])[0], o + 2


def parse_lwo(path):
    b = open(path, "rb").read()
    if b[:4] != b"FORM" or b[8:12] != b"LWO2":
        return None
    layers = {}          # layer number -> {pivot, pts, polys:[(idx..., surf)]}
    tags = []
    surfs = {}
    cur = None
    o = 12
    end = 8 + struct.unpack(">I", b[4:8])[0]
    while o + 8 <= end:
        cid = b[o:o + 4]
        size = struct.unpack(">I", b[o + 4:o + 8])[0]
        d = b[o + 8:o + 8 + size]
        o += 8 + size + (size & 1)
        if cid == b"TAGS":
            p = 0
            while p < len(d):
                s, p = read_s0(d, p)
                tags.append(s)
        elif cid == b"LAYR":
            num = struct.unpack(">H", d[0:2])[0]
            pivot = struct.unpack(">3f", d[4:16])
            # keyed by order of appearance: the scene's "LoadObjectLayer N" means the N-th layer
            cur = {"pivot": pivot, "pts": [], "polys": [], "base": 0, "num": num}
            layers[len(layers) + 1] = cur
        elif cid == b"PNTS":
            if cur is None:
                cur = layers.setdefault(1, {"pivot": (0, 0, 0), "pts": [], "polys": [], "base": 0})
            cur["base"] = len(cur["pts"])
            cur["pts"].extend(struct.iter_unpack(">3f", d[: len(d) // 12 * 12]))
        elif cid == b"POLS":
            kind = d[:4]
            p = 4
            polys = []
            while p < len(d):
                n = struct.unpack(">H", d[p:p + 2])[0] & 0x03FF
                p += 2
                idx = []
                for _ in range(n):
                    v, p = read_vx(d, p)
                    idx.append(v + cur["base"])
                polys.append(idx)
            cur["_pols"] = (kind, polys, len(cur["polys"]))
            if kind in (b"FACE", b"PTCH"):
                cur["polys"].extend([idx, None] for idx in polys)
        elif cid == b"PTAG":
            if d[:4] != b"SURF" or "_pols" not in cur:
                continue
            kind, polys, start = cur["_pols"]
            if kind not in (b"FACE", b"PTCH"):
                continue
            p = 4
            while p < len(d):
                pi, p = read_vx(d, p)
                t = struct.unpack(">H", d[p:p + 2])[0]
                p += 2
                if start + pi < len(cur["polys"]) and t < len(tags):
                    cur["polys"][start + pi][1] = tags[t]
        elif cid == b"SURF":
            name, p = read_s0(d, 0)
            _, p = read_s0(d, p)
            s = {"color": (0.8, 0.8, 0.8), "diff": 1.0, "spec": 0.0, "lumi": 0.0, "tran": 0.0, "image": False}
            while p + 6 <= len(d):
                sid = d[p:p + 4]
                ss = struct.unpack(">H", d[p + 4:p + 6])[0]
                sd = d[p + 6:p + 6 + ss]
                p += 6 + ss + (ss & 1)
                if sid == b"COLR": s["color"] = struct.unpack(">3f", sd[:12])
                elif sid == b"DIFF": s["diff"] = struct.unpack(">f", sd[:4])[0]
                elif sid == b"SPEC": s["spec"] = struct.unpack(">f", sd[:4])[0]
                elif sid == b"LUMI": s["lumi"] = struct.unpack(">f", sd[:4])[0]
                elif sid == b"TRAN": s["tran"] = struct.unpack(">f", sd[:4])[0]
                elif sid == b"BLOK": s["image"] = True
            surfs[name] = s
    return {"layers": layers, "surfs": surfs}


# ── LWS ─────────────────────────────────────────────────────────────────────

def parse_lws(path):
    lines = open(path, encoding="latin-1").read().splitlines()
    items = {}
    order = []
    cur = None
    chan = -1
    i = 0
    while i < len(lines):
        ln = lines[i].strip()
        m = re.match(r"LoadObjectLayer (\d+) ([0-9a-fA-F]+) (.+)$", ln)
        n = re.match(r"AddNullObject ([0-9a-fA-F]+) (.+)$", ln)
        if m or n:
            iid = (m or n).group(2 if m else 1)
            cur = {"id": iid, "file": m.group(3) if m else None, "layer": int(m.group(1)) if m else 0,
                   "name": n.group(2) if n else m.group(3), "chan": [0.0] * 6 + [1.0] * 3,
                   "pivot": (0.0, 0.0, 0.0), "parent": None}
            items[iid] = cur
            order.append(iid)
            chan = -1
        elif cur is not None:
            if ln.startswith("Channel "):
                chan = int(ln.split()[1])
            elif ln.startswith("Key ") and 0 <= chan < 9:
                # first key wins: frame-0 pose
                if not cur.get("_seen%d" % chan):
                    cur["chan"][chan] = float(ln.split()[1])
                    cur["_seen%d" % chan] = True
            elif ln.startswith("PivotPosition "):
                cur["pivot"] = tuple(map(float, ln.split()[1:4]))
            elif ln.startswith("ParentItem "):
                cur["parent"] = ln.split()[1]
            elif ln.startswith(("AddLight", "AddCamera", "LoadObject ")):
                cur = None
        i += 1
    return items, order


# ── tiny 4x4 matrix helpers (row-major, column vectors) ──────────────────────

def mul(a, b):
    return [[sum(a[r][k] * b[k][c] for k in range(4)) for c in range(4)] for r in range(4)]


def trs(item):
    x, y, z, h, p, bk, sx, sy, sz = item["chan"]
    px, py, pz = item["pivot"]
    ch, sh = math.cos(h), math.sin(h)
    cp, sp = math.cos(p), math.sin(p)
    cb, sb = math.cos(bk), math.sin(bk)
    ry = [[ch, 0, sh, 0], [0, 1, 0, 0], [-sh, 0, ch, 0], [0, 0, 0, 1]]
    rx = [[1, 0, 0, 0], [0, cp, -sp, 0], [0, sp, cp, 0], [0, 0, 0, 1]]
    rz = [[cb, -sb, 0, 0], [sb, cb, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
    # LightWave applies bank, then pitch, then heading (left-handed; heading turns +Z toward +X)
    r = mul(ry, mul(rx, rz))
    t = [[1, 0, 0, x], [0, 1, 0, y], [0, 0, 1, z], [0, 0, 0, 1]]
    s = [[sx, 0, 0, 0], [0, sy, 0, 0], [0, 0, sz, 0], [0, 0, 0, 1]]
    tp = [[1, 0, 0, -px], [0, 1, 0, -py], [0, 0, 1, -pz], [0, 0, 0, 1]]
    return mul(t, mul(r, mul(s, tp)))


def world(items, iid, memo):
    if iid in memo:
        return memo[iid]
    it = items[iid]
    m = trs(it)
    if it["parent"] and it["parent"] in items:
        m = mul(world(items, it["parent"], memo), m)
    memo[iid] = m
    return m


def apply(m, v):
    x, y, z = v
    return (m[0][0] * x + m[0][1] * y + m[0][2] * z + m[0][3],
            m[1][0] * x + m[1][1] * y + m[1][2] * z + m[1][3],
            m[2][0] * x + m[2][1] * y + m[2][2] * z + m[2][3])


def main(root, out):
    scene = [f for f in os.listdir(os.path.join(root, "Scenes")) if f.endswith(".lws")][0]
    items, order = parse_lws(os.path.join(root, "Scenes", scene))
    memo = {}
    cache = {}
    verts, faces, mats = [], [], {}
    skipped = []
    for iid in order:
        it = items[iid]
        if not it["file"]:
            continue
        path = os.path.join(root, it["file"].replace("\\", "/"))
        if path not in cache:
            cache[path] = parse_lwo(path) if os.path.exists(path) else None
        lwo = cache[path]
        if not lwo:
            skipped.append(it["file"]); continue
        layer = lwo["layers"].get(it["layer"])
        if not layer:
            skipped.append(f'{it["file"]}#{it["layer"]}'); continue
        m = world(items, iid, memo)
        base = len(verts)
        for v in layer["pts"]:
            x, y, z = apply(m, v)
            verts.append((x, y, -z))          # left- to right-handed
        group = os.path.splitext(os.path.basename(it["file"]))[0]
        for idx, surf in layer["polys"]:
            if len(idx) < 3:
                continue
            name = surf or "default"
            mats.setdefault(name, lwo["surfs"].get(name, {"color": (0.8, 0.8, 0.8), "diff": 1, "spec": 0, "lumi": 0, "tran": 0, "image": False}))
            faces.append((group, name, [base + k for k in reversed(idx)]))

    # metres: the scene is authored in metres already (truss ~94 m) — report the extent to check
    xs = [v[0] for v in verts]; ys = [v[1] for v in verts]; zs = [v[2] for v in verts]
    print(f"verts {len(verts)}  faces {len(faces)}  materials {len(mats)}")
    print(f"extent x {min(xs):.1f}..{max(xs):.1f}  y {min(ys):.1f}..{max(ys):.1f}  z {min(zs):.1f}..{max(zs):.1f}")
    if skipped:
        print("skipped:", ", ".join(skipped))

    mtl = os.path.splitext(out)[0] + ".mtl"
    with open(mtl, "w") as f:
        for name, s in mats.items():
            r, g, b = (c * max(s["diff"], 0.05) for c in s["color"])
            f.write(f"newmtl {safe(name)}\nKd {r:.4f} {g:.4f} {b:.4f}\nKs {s['spec']:.3f} {s['spec']:.3f} {s['spec']:.3f}\n")
            if s["lumi"] > 0.05:
                f.write(f"Ke {s['color'][0]*s['lumi']:.4f} {s['color'][1]*s['lumi']:.4f} {s['color'][2]*s['lumi']:.4f}\n")
            f.write(f"d {1 - s['tran']:.3f}\n\n")
    with open(out, "w") as f:
        f.write(f"mtllib {os.path.basename(mtl)}\n")
        for v in verts:
            f.write(f"v {v[0]:.4f} {v[1]:.4f} {v[2]:.4f}\n")
        last = (None, None)
        for group, name, idx in faces:
            if (group, name) != last:
                f.write(f"o {group}\nusemtl {safe(name)}\n")
                last = (group, name)
            f.write("f " + " ".join(str(k + 1) for k in idx) + "\n")


def safe(s):
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", s)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
