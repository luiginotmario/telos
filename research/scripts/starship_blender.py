"""Procedural Starship upper stage ("Ship", Block 2) for the Telos descent scene.

Pure bpy + bmesh, deterministic (no randomness). Writes a glTF binary that the
site loads from /models/starship.glb (src/gl/descent/starship.ts scales it by
0.001 into km).

Usage (headless, light on the machine):
  blender -b --factory-startup -t 2 --python research/scripts/starship_blender.py
  ... -- --preview   # also writes research/starship-preview.png (Workbench, 512 px)

Frame
  Authored in Blender Z-up; the exporter converts to glTF +Y up, so glTF
  (x, y, z) = Blender (x, z, -y). Hence the glTF windward belly (-Z) is Blender
  +Y and the glTF leeward (+Z) is Blender -Y. Units are metres. The bottom of
  the landing-leg pads sits at y = 0 and the ship is centred on the Y axis.

Public figures used (SpaceX): Ship diameter 9 m, Ship height ~52 m (Block 2),
six Raptors (3 sea-level, 3 vacuum), four flaps, black hexagonal heat-shield
tiles on the windward half. Everything else is an assumption, marked "ASSUME".
"""
from __future__ import annotations

import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT_GLB = os.path.join(ROOT, "public", "models", "starship.glb")
OUT_PNG = os.path.join(ROOT, "research", "starship-preview.png")
PREVIEW = "--preview" in sys.argv
# dev aid: `-- --preview --belly /path.png` renders from below the windward side instead
BELLY = sys.argv[sys.argv.index("--belly") + 1] if "--belly" in sys.argv else None

# ── dimensions (metres, Blender Z up) ───────────────────────────────────────
R = 4.5                 # barrel radius (9 m diameter, public)
Z_RIM = 1.6             # ASSUME: skirt rim height = leg stroke below the skirt
Z_STEEL0 = 1.65         # steel exterior starts 5 cm above the rim (rim lip covers the gap)
Z_TILE0 = 1.62          # heat shield starts 2 cm above the rim (no z-fight with the rim)
Z_NOSE = 34.0           # barrel / nosecone joint: nose occupies the top 18 m
Z_TOP = 52.0            # tile tip; overall height incl. legs = 52 m (spec)
TILE_T = 0.025          # heat shield stands 2.5 cm proud of the steel
SEAM_PITCH = 1.8        # ASSUME: 1.8 m stainless ring height (SpaceX ring stacks)
SEAM_W, SEAM_D = 0.025, 0.012   # half-width / depth of a weld groove
NOSE_RN = 1.2           # ASSUME: blunt-tip sphere radius
Z_WRAP0 = 47.0          # ASSUME: above this the tile line wraps over the leeward tip
N_HALF = 48             # segments per half circumference (96 around)

# ── materials (Principled BSDF, glTF-exportable, no textures) ───────────────
MATS = {
    "steel":        dict(base=0.75, metallic=1.0, rough=0.28),
    "tiles":        dict(base=0.03, metallic=0.0, rough=0.75),
    "engine":       dict(base=0.18, metallic=0.8, rough=0.45),
    "engine_inner": dict(base=0.05, metallic=0.0, rough=0.60),  # ASSUME metallic 0
}


def make_materials() -> dict[str, bpy.types.Material]:
    out = {}
    for name, p in MATS.items():
        m = bpy.data.materials.new(name)
        try:
            m.use_nodes = True
        except Exception:
            pass
        nt = m.node_tree
        bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if bsdf is None:
            bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
            outn = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"), None) or nt.nodes.new("ShaderNodeOutputMaterial")
            nt.links.new(bsdf.outputs[0], outn.inputs[0])
        b = p["base"]
        bsdf.inputs["Base Color"].default_value = (b, b, b, 1.0)
        bsdf.inputs["Metallic"].default_value = p["metallic"]
        bsdf.inputs["Roughness"].default_value = p["rough"]
        # viewport / Workbench colour
        m.diffuse_color = (b, b, b, 1.0)
        m.metallic = p["metallic"]
        m.roughness = p["rough"]
        out[name] = m
    return out


# ── nose profile: spherically blunted tangent ogive ─────────────────────────
def _blunt(Ls: float):
    rho = (R * R + Ls * Ls) / (2 * R)
    x0 = Ls - math.sqrt((rho - NOSE_RN) ** 2 - (rho - R) ** 2)   # sphere centre, from sharp tip
    yt = NOSE_RN * (rho - R) / (rho - NOSE_RN)
    xt = x0 - math.sqrt(NOSE_RN ** 2 - yt ** 2)                   # tangent point, from sharp tip
    xa = x0 - NOSE_RN                                             # blunt apex, from sharp tip
    return rho, x0, xt, yt, xa


# Steel apex sits TILE_T below the tile tip; solve the sharp-ogive length so the
# blunted nose is exactly that long.
NOSE_LEN = (Z_TOP - TILE_T) - Z_NOSE
_lo, _hi = NOSE_LEN, NOSE_LEN + 6.0
for _ in range(60):
    _mid = 0.5 * (_lo + _hi)
    if _mid - _blunt(_mid)[4] < NOSE_LEN:
        _lo = _mid
    else:
        _hi = _mid
LS = 0.5 * (_lo + _hi)
RHO, X0, XT, YT, XA = _blunt(LS)
Z_SHARP = Z_NOSE + LS                   # where the sharp ogive would end
Z_CAPC = Z_SHARP - X0                   # sphere centre
Z_TAN = Z_SHARP - XT                    # ogive/sphere tangent point
Z_APEX = Z_SHARP - XA                   # = Z_TOP - TILE_T
R_C = R - RHO                           # ogive circle centre radius (negative)


def base_point(z: float):
    """Outer mould line at height z -> (r, nr, nz) with (nr, nz) the outward unit normal."""
    if z <= Z_NOSE:
        return R, 1.0, 0.0
    if z <= Z_TAN:
        r = math.sqrt(max(RHO * RHO - (z - Z_NOSE) ** 2, 0.0)) + R_C
        return r, (r - R_C) / RHO, (z - Z_NOSE) / RHO
    dz = min(z - Z_CAPC, NOSE_RN)
    r = math.sqrt(max(NOSE_RN * NOSE_RN - dz * dz, 0.0))
    return r, r / NOSE_RN, dz / NOSE_RN


def nose_samples() -> list[float]:
    zs = []
    phi_t = math.asin((Z_TAN - Z_NOSE) / RHO)
    for i in range(15):                                  # ogive, uniform in tangent angle
        zs.append(Z_NOSE + RHO * math.sin(phi_t * i / 14))
    psi_t = math.atan2(base_point(Z_TAN)[0], Z_TAN - Z_CAPC)
    for k in range(9, -1, -1):                           # spherical cap down to the apex
        if k == 9:
            continue                                     # = tangent point, already sampled
        zs.append(Z_CAPC + NOSE_RN * math.cos(psi_t * k / 9))
    return zs


NOSE_Z = nose_samples()
# ASSUME: the tile line wraps fully around the leeward tip at the cap sample nearest 51.35 m
Z_FULL = min(NOSE_Z, key=lambda z: abs(z - 51.35))


def half_span(z: float) -> float:
    """Half-angle (radians) of the tiled region, centred on Blender +Y (glTF -Z, windward)."""
    if z <= Z_WRAP0:
        return math.pi / 2
    if z >= Z_FULL:
        return math.pi
    t = (z - Z_WRAP0) / (Z_FULL - Z_WRAP0)
    s = t * t * (3 - 2 * t)
    return math.pi / 2 * (1 + s)


# ── mesh helpers ────────────────────────────────────────────────────────────
def grid(bm, rings, wrap=False, mat=0):
    """Skin consecutive rings of points. A ring of length 1 is an apex. `mat` is an
    int or f(ring_index) -> int. Face normals follow (ring dir) x (profile dir)."""
    vr = [[bm.verts.new(p) for p in ring] for ring in rings]
    for i in range(len(vr) - 1):
        a, b = vr[i], vr[i + 1]
        n = max(len(a), len(b))
        idx = (lambda ring, j: ring[0] if len(ring) == 1 else ring[j % len(ring)])
        for j in range(n if wrap else n - 1):
            quad = [idx(a, j), idx(a, j + 1), idx(b, j + 1), idx(b, j)]
            f = []
            for v in quad:
                if v not in f:
                    f.append(v)
            if len(f) < 3:
                continue
            try:
                face = bm.faces.new(f)
            except ValueError:
                continue
            face.material_index = mat(i) if callable(mat) else mat
    return vr


def lathe(bm, profile, seg, mats, center=(0.0, 0.0, 0.0)):
    """Full revolution of a (r, z) profile; mats[i] is the material of segment i."""
    cx, cy, cz = center
    rings = []
    for r, z in profile:
        if r < 1e-6:
            rings.append([Vector((cx, cy, cz + z))])
        else:
            rings.append([Vector((cx + r * math.cos(2 * math.pi * j / seg),
                                  cy + r * math.sin(2 * math.pi * j / seg), cz + z)) for j in range(seg)])
    grid(bm, rings, wrap=True, mat=lambda i: mats[i])


def new_object(name, bm, mats, parent=None):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    if parent is not None:
        ob.parent = parent
    return ob


def clean(bm, dist=1e-4):
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=dist)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=1e-6)
    bm.normal_update()


def finish(ob, sharp_deg, bevel=None):
    """Smooth + sharp-by-angle + (optional bevel) + weighted normals, then bake
    the modifiers into the mesh so the export is exactly what we see."""
    me = ob.data
    me.shade_smooth()
    me.set_sharp_from_angle(angle=math.radians(sharp_deg))
    if bevel:
        bv = ob.modifiers.new("bevel", "BEVEL")
        bv.width = bevel
        bv.segments = 2
        bv.limit_method = "ANGLE"
        bv.angle_limit = math.radians(30)
        bv.harden_normals = False
    wn = ob.modifiers.new("wn", "WEIGHTED_NORMAL")
    wn.keep_sharp = True
    wn.weight = 50
    wn.mode = "FACE_AREA"
    dg = bpy.context.evaluated_depsgraph_get()
    baked = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    ob.modifiers.clear()
    old = ob.data
    ob.data = baked
    bpy.data.meshes.remove(old)
    baked.name = ob.name


# ── hull (stainless) ────────────────────────────────────────────────────────
def build_hull(mats, parent):
    bm = bmesh.new()
    # Seams: every 1.8 m up the barrel (incl. the nose joint) and on into the nose
    # until the tile line starts to wrap. Each is a shallow V groove whose flanks
    # get split normals (sharp at 20 deg) so it reads as a faint line in the steel.
    seams = []
    z = Z_RIM + SEAM_PITCH
    while z < Z_WRAP0 - 0.3:
        seams.append(round(z, 4))
        z += SEAM_PITCH
    rings = [(Z_STEEL0, 0.0)]
    for s in seams:
        rings += [(s - SEAM_W, 0.0), (s, SEAM_D), (s + SEAM_W, 0.0)]
    for zn in NOSE_Z:
        if Z_NOSE < zn <= Z_FULL and all(abs(zn - s) > SEAM_W + 0.03 for s in seams):
            rings.append((zn, 0.0))
    rings.sort()
    pts = []
    for zr, d in rings:
        r, nr, nz = base_point(zr)
        rr, zz = r - d * nr, zr - d * nz
        h = half_span(zr)
        a0, span = math.pi / 2 + h, 2 * math.pi - 2 * h   # leeward complement of the tiles
        pts.append([Vector((rr * math.cos(a0 + span * j / N_HALF), rr * math.sin(a0 + span * j / N_HALF), zz))
                    for j in range(N_HALF + 1)])
    grid(bm, pts, wrap=False, mat=0)

    # Skirt rim, inner skirt wall, aft dome and thrust puck (full revolution).
    # ASSUME: aft dome bulges down to 5.55 m at the centre; RSL thrust puck r = 1.9 m.
    r_in, z_dome_edge, z_dome_c, r_puck, z_puck = 4.42, 6.9, 5.55, 1.9, 4.95
    dome = lambda r: z_dome_c + (z_dome_edge - z_dome_c) * (r / r_in) ** 2
    prof = [(0.0, z_puck), (r_puck, z_puck), (r_puck, dome(r_puck))]
    for k in range(1, 9):
        rr = r_puck + (r_in - r_puck) * k / 8
        prof.append((rr, dome(rr)))
    prof += [(r_in, Z_RIM), (R, Z_RIM), (R, Z_STEEL0)]
    lathe(bm, prof, 2 * N_HALF, [0] * len(prof))
    clean(bm)
    ob = new_object("hull", bm, [mats["steel"]], parent)
    finish(ob, 20)
    return ob


# ── heat shield (black tiles) ───────────────────────────────────────────────
def build_tiles(mats, parent, fairings):
    bm = bmesh.new()
    zs = [Z_TILE0, Z_NOSE] + [z for z in NOSE_Z if z > Z_NOSE]
    pts = []
    for zr in zs:
        r, nr, nz = base_point(zr)
        rr, zz = r + TILE_T * nr, zr + TILE_T * nz
        if rr < 1e-5:
            pts.append([Vector((0.0, 0.0, zz))])
            continue
        h = half_span(zr)
        a0 = math.pi / 2 - h
        pts.append([Vector((rr * math.cos(a0 + 2 * h * j / N_HALF), rr * math.sin(a0 + 2 * h * j / N_HALF), zz))
                    for j in range(N_HALF + 1)])
    grid(bm, pts, wrap=False, mat=0)
    clean(bm)
    # Edge walls: extrude the shell's boundary loop inward (past the steel) so
    # the shield reads as a 2.5 cm slab, not a decal.
    boundary = [e for e in bm.edges if e.is_boundary]
    wv = {}
    for e in boundary:
        for v in e.verts:
            if v not in wv:
                wv[v] = bm.verts.new(v.co - v.normal * (TILE_T + 0.02))
    for e in boundary:
        lp = e.link_loops[0]
        a, b = lp.vert, lp.link_loop_next.vert
        try:
            bm.faces.new([b, a, wv[a], wv[b]])
        except ValueError:
            pass
    # Hinge fairings (static, tiled) between the body and each flap root.
    for mw, length in fairings:
        geom = bmesh.ops.create_cube(bm, size=1.0)
        hv = [v for v in geom["verts"]]
        m = mw @ Matrix.Translation((-0.24, 0.0, 0.0)) @ Matrix.Diagonal((0.36, 0.48, length * 0.94, 1.0))
        bmesh.ops.transform(bm, matrix=m, verts=hv)
        # the L side is mirrored (negative determinant): re-orient the box outward
        bmesh.ops.recalc_face_normals(bm, faces=list({f for v in hv for f in v.link_faces}))
    bm.normal_update()
    ob = new_object("heatshield", bm, [mats["tiles"]], parent)
    finish(ob, 30)
    return ob


# ── flaps ───────────────────────────────────────────────────────────────────
def fillet(poly, radii, steps=4):
    out = []
    n = len(poly)
    for i, (p, rad) in enumerate(zip(poly, radii)):
        P = Vector(p)
        if rad <= 0:
            out.append(P)
            continue
        A, B = Vector(poly[i - 1]), Vector(poly[(i + 1) % n])
        d1, d2 = (A - P).normalized(), (B - P).normalized()
        phi = math.acos(max(-1.0, min(1.0, d1.dot(d2))))
        t = rad / math.tan(phi / 2)
        C = P + (d1 + d2).normalized() * (rad / math.sin(phi / 2))
        T1, T2 = P + d1 * t, P + d2 * t
        a1 = math.atan2(T1.y - C.y, T1.x - C.x)
        a2 = math.atan2(T2.y - C.y, T2.x - C.x)
        da = (a2 - a1 + math.pi) % (2 * math.pi) - math.pi
        for k in range(steps + 1):
            a = a1 + da * k / steps
            out.append(Vector((C.x + rad * math.cos(a), C.y + rad * math.sin(a))))
    return out


def build_flap(name, mats, parent, side, hinge_mid, tilt, root, span, tip_lo, tip_hi, t_root, t_tip):
    """Flap in its own frame: origin on the hinge line, local Z = hinge axis
    (glTF local +Y), local X = outward (sign = side). Windward face = local +Y
    (glTF -Z) carries tiles, leeward face is steel. Planform swept like the real
    ones: long root on the hinge, shorter tip chord, leading (upper) edge raked down."""
    h = root / 2
    poly = [(0.0, -h), (span, tip_lo), (span, tip_hi), (0.0, h)]
    outline = fillet(poly, [0.0, 0.45, 0.6, 0.0])
    bm = bmesh.new()
    top, bot = [], []
    for p in outline:
        t = t_root + (t_tip - t_root) * (p.x / span)
        top.append(bm.verts.new((side * p.x, t / 2, p.y)))
        bot.append(bm.verts.new((side * p.x, -t / 2, p.y)))
    bm.faces.new(top)
    bm.faces.new(list(reversed(bot)))
    n = len(outline)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new([top[j], top[i], bot[i], bot[j]])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = new_object(name, bm, [mats["tiles"], mats["steel"]], parent)
    ob.location = hinge_mid
    ob.rotation_euler = (0.0, tilt, 0.0)
    finish(ob, 30, bevel=0.05)
    for f in ob.data.polygons:
        f.material_index = 1 if f.normal.y < -0.7 else 0
    return ob


def flap_set(mats, parent):
    flaps, fairings = [], []
    hinge_off = TILE_T + 0.35
    # Aft flaps: hinge parallel to the axis. ASSUME root 11 m, span 3.8 m, tip chord 6 m.
    for side, nm in ((1, "R"), (-1, "L")):
        mid = Vector((side * (R + hinge_off), 0.0, 8.6))
        ob = build_flap(f"flap_aft_{nm}", mats, parent, side, mid, 0.0,
                        root=11.0, span=3.8, tip_lo=-5.3, tip_hi=0.5, t_root=0.5, t_tip=0.22)
        flaps.append(ob)
        fairings.append((Matrix.Translation(mid) @ Matrix.Diagonal((side, 1, 1, 1)), 11.0))
    # Forward flaps: hinge laid along the ogive between 39.6 m and 46.2 m.
    # ASSUME root ~6.7 m, span 2.5 m (Block 2 forward flaps are smaller and sit high).
    z0, z1 = 39.6, 46.2
    r0, r1 = base_point(z0)[0] + hinge_off, base_point(z1)[0] + hinge_off
    length = math.hypot(r0 - r1, z1 - z0)
    a = math.atan2(r0 - r1, z1 - z0)
    for side, nm in ((1, "R"), (-1, "L")):
        mid = Vector((side * 0.5 * (r0 + r1), 0.0, 0.5 * (z0 + z1)))
        tilt = -side * a
        h = length / 2
        ob = build_flap(f"flap_fwd_{nm}", mats, parent, side, mid, tilt,
                        root=length, span=2.5, tip_lo=-h + 0.3, tip_hi=-0.5, t_root=0.38, t_tip=0.16)
        flaps.append(ob)
        fairings.append((Matrix.Translation(mid) @ Matrix.Rotation(tilt, 4, "Y") @ Matrix.Diagonal((side, 1, 1, 1)), length))
    return flaps, fairings


# ── engines ─────────────────────────────────────────────────────────────────
def bell_profile(r_e, r_t, Lb, chamber_r, head_r, total, wall=0.03, n=9):
    """(r, z) from the throat cap down the inside, round the exit lip, up the
    outside, over the chamber and powerhead. z = 0 at the nozzle exit."""
    def r_of(u):  # u = 0 throat -> 1 exit; fast expansion, ~10 deg exit angle
        return r_t + (r_e - r_t) * (0.15 * u + 0.85 * (1 - (1 - u) ** 2.4))
    us = [(i / n) ** 1.5 for i in range(n + 1)]
    inner = [(r_of(u) - wall, Lb * (1 - u)) for u in us]           # throat -> exit
    outer = [(r_of(u), Lb * (1 - u)) for u in reversed(us)]          # exit -> throat
    prof = [(0.0, Lb)] + inner + outer
    mats = ["engine_inner"] * (1 + len(inner) - 1)                     # cap + inner bell
    mats += ["engine"]                                                # exit lip
    mats += ["engine"] * (len(outer) - 1)
    head = [(chamber_r, Lb + 0.25), (chamber_r, Lb + 0.7), (head_r, Lb + 0.85),
            (head_r, total - 0.1), (head_r - 0.1, total), (0.0, total)]
    prof += head
    mats += ["engine"] * len(head)
    return prof, mats


def build_engines(mats, parent):
    bm = bmesh.new()
    order = ["engine", "engine_inner"]
    # Raptor 2 sea level: exit ~1.3 m, ~3.1 m long. ASSUME 3.0 m incl. powerhead,
    # clustered on r = 1.05 m under the thrust puck, exit 0.35 m above the rim.
    sl, slm = bell_profile(0.65, 0.2, 1.55, 0.32, 0.5, 3.0)
    # Raptor Vacuum: exit ~2.3 m. ASSUME 4.4 m long, on r = 3.1 m, exit 0.25 m
    # above the rim (recessed inside the skirt), clocked 60 deg from the RSLs.
    vac, vacm = bell_profile(1.15, 0.2, 3.0, 0.34, 0.55, 4.4)
    for k in range(3):
        a = math.radians(30 + 120 * k)
        lathe(bm, sl, 24, [order.index(m) for m in slm], (1.05 * math.cos(a), 1.05 * math.sin(a), 1.95))
        a = math.radians(90 + 120 * k)
        lathe(bm, vac, 32, [order.index(m) for m in vacm], (3.1 * math.cos(a), 3.1 * math.sin(a), 1.85))
    clean(bm)
    ob = new_object("engines", bm, [mats["engine"], mats["engine_inner"]], parent)
    finish(ob, 35)
    return ob


# ── landing legs (speculative) ──────────────────────────────────────────────
def build_legs(mats, parent):
    """SPECULATIVE: SpaceX has not published Mars-landing legs for Ship. Six short
    A-frame legs stowed against the aft skirt, deployed: a shallow pod on the
    skirt, a main strut and a brace to a small pad. Clocked at 30 + 60k deg so
    they clear the aft flaps on +-X. Pad bottoms define y = 0."""
    bm = bmesh.new()

    def strut(p0, p1, rad, seg=8):
        d = p1 - p0
        m = Matrix.Translation((p0 + p1) / 2) @ Vector((0, 0, 1)).rotation_difference(d.normalized()).to_matrix().to_4x4()
        g = bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg,
                                  radius1=rad, radius2=rad, depth=d.length, matrix=m)
        for f in {f for v in g["verts"] for f in v.link_faces}:
            f.material_index = 0

    for k in range(6):
        a = math.radians(30 + 60 * k)
        rot = Matrix.Rotation(a, 4, "Z")
        radial = lambda r, z: (rot @ Vector((r, 0.0, z)))
        g = bmesh.ops.create_cube(bm, size=1.0, matrix=rot @ Matrix.Translation((4.57, 0, 3.25)) @ Matrix.Diagonal((0.18, 0.62, 3.0, 1)))
        strut(radial(4.64, 4.45), radial(5.7, 0.2), 0.2)
        strut(radial(4.64, 2.0), radial(5.55, 0.22), 0.13)
        pad = bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=12, radius1=0.65, radius2=0.5,
                                    depth=0.2, matrix=Matrix.Translation(radial(5.7, 0.1)))
        for f in {f for v in pad["verts"] for f in v.link_faces}:
            f.material_index = 1
    bm.normal_update()
    ob = new_object("legs", bm, [mats["steel"], mats["engine"]], parent)
    finish(ob, 35)
    return ob


# ── preview (Workbench, 512 px, one frame) ──────────────────────────────────
def render_preview():
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_WORKBENCH"
    sc.render.resolution_x = sc.render.resolution_y = 512
    sc.render.resolution_percentage = 100
    sc.display.render_aa = "8"
    sh = sc.display.shading
    sh.light = "STUDIO"
    sh.color_type = "MATERIAL"
    sh.show_specular_highlight = True
    sh.show_cavity = False  # judge the grooves by their normals alone, as three.js will
    sc.view_settings.view_transform = "Standard"
    if sc.world is None:
        sc.world = bpy.data.worlds.new("w")
    sc.world.color = (0.05, 0.05, 0.055)
    cam_d = bpy.data.cameras.new("cam")
    cam_d.lens = 50
    cam_d.clip_end = 1000
    cam = bpy.data.objects.new("cam", cam_d)
    sc.collection.objects.link(cam)
    # three-quarter view from the leeward (steel) side, +X flaps toward the viewer
    cam.location, target = Vector((52.0, -76.0, 22.0)), Vector((0.0, 0.0, 25.5))
    if BELLY:
        cam.location, target = Vector((9.0, 15.0, -24.0)), Vector((0.0, 0.0, 4.0))
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    sc.camera = cam
    sc.render.filepath = BELLY or OUT_PNG
    sc.render.image_settings.file_format = "PNG"
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)


def export_glb():
    os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)
    want = dict(filepath=OUT_GLB, export_format="GLB", use_selection=False, export_apply=True,
                export_yup=True, export_normals=True, export_texcoords=False, export_tangents=False,
                export_materials="EXPORT", export_cameras=False, export_lights=False,
                export_animations=False, export_draco_mesh_compression_enable=False,
                export_extras=False)
    props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    bpy.ops.export_scene.gltf(**{k: v for k, v in want.items() if k in props})


def main():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob)
    mats = make_materials()
    root = bpy.data.objects.new("starship", None)
    bpy.context.scene.collection.objects.link(root)
    flaps, fairings = flap_set(mats, root)
    build_hull(mats, root)
    build_tiles(mats, root, fairings)
    build_engines(mats, root)
    build_legs(mats, root)
    bpy.context.view_layer.update()

    tris, lo, hi = 0, Vector((1e9,) * 3), Vector((-1e9,) * 3)
    print("── starship ──")
    for ob in bpy.data.objects:
        if ob.type != "MESH":
            continue
        me = ob.data
        me.calc_loop_triangles()
        t = len(me.loop_triangles)
        tris += t
        for v in me.vertices:
            w = ob.matrix_world @ v.co
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
        print(f"  {ob.name:14s} {t:6d} tris  origin {tuple(round(c, 3) for c in ob.matrix_world.translation)}")
    print(f"  total {tris} tris; bbox z {lo.z:.4f}..{hi.z:.4f}  x {lo.x:.3f}..{hi.x:.3f}  y {lo.y:.3f}..{hi.y:.3f}")
    print(f"  nose: sharp-ogive L={LS:.3f} rho={RHO:.3f}  tangent z={Z_TAN:.3f}  tile wrap full z={Z_FULL:.3f}")

    export_glb()
    print(f"  wrote {OUT_GLB} ({os.path.getsize(OUT_GLB) / 1024:.0f} KiB)")
    if PREVIEW:
        render_preview()
        print(f"  wrote {BELLY or OUT_PNG}")


main()
