"""
Headless Blender: ISS OBJ (inches) -> metres, merged per material, smooth-by-angle,
light decimation, Draco GLB + a preview render to check the assembly.

  Blender -b -P research/scripts/iss_blender.py -- <in.obj> <out.glb> <preview.png> [ratio]
"""
import math
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:]
src, out, preview = argv[0], argv[1], argv[2]
ratio = float(argv[3]) if len(argv) > 3 else 0.5

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.obj_import(filepath=src, forward_axis="NEGATIVE_Z", up_axis="Y")
import re
objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
# one mesh per station module (the OBJ splits a module per material: "lab-ext", "lab-ext.001", ...)
groups = {}
for o in objs:
    groups.setdefault(re.sub(r"\.\d+$", "", o.name), []).append(o)
modules = []
for name, parts in groups.items():
    bpy.ops.object.select_all(action="DESELECT")
    for o in parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    if len(parts) > 1:
        bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = ob.data.name = name
    modules.append(ob)

# whole station: inches -> metres, centred on its bounds (all modules share one transform)
bpy.ops.object.select_all(action="SELECT")
for ob in modules:
    ob.scale = (0.0254,) * 3
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
lo = [min(v.co[i] for ob in modules for v in ob.data.vertices) for i in range(3)]
hi = [max(v.co[i] for ob in modules for v in ob.data.vertices) for i in range(3)]
c = [(a + b) / 2 for a, b in zip(lo, hi)]
for ob in modules:
    for v in ob.data.vertices:
        v.co.x -= c[0]; v.co.y -= c[1]; v.co.z -= c[2]
print("centre offset m (blender xyz)", [round(x, 3) for x in c])
faces = 0
for ob in modules:
    bpy.ops.object.select_all(action="DESELECT")
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=0.002)
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.shade_auto_smooth(angle=math.radians(35))
    faces += len(ob.data.polygons)
print("modules", len(modules), "faces", faces)
print("dimensions m:", [round(b - a, 1) for a, b in zip(lo, hi)])
for ob in modules:
    xs = [v.co for v in ob.data.vertices]
    if not xs: continue
    mn = [min(v[i] for v in xs) for i in range(3)]; mx = [max(v[i] for v in xs) for i in range(3)]
    print("MOD", ob.name, [round(x, 2) for x in mn], [round(x, 2) for x in mx])

bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=False,
                          export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=7,
                          export_apply=True, export_yup=True)

# preview: three-quarter view, sunlit
scn = bpy.context.scene
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
scn.collection.objects.link(cam)
cam.location = (70, -90, 55)
cam.rotation_euler = (math.radians(62), 0, math.radians(38))
cam.data.lens = 28
scn.camera = cam
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
sun.data.energy = 4
sun.rotation_euler = (math.radians(40), math.radians(-30), math.radians(20))
scn.collection.objects.link(sun)
scn.world = bpy.data.worlds.new("w")
scn.world.color = (0.02, 0.02, 0.025)
scn.render.engine = "BLENDER_EEVEE"
scn.render.resolution_x, scn.render.resolution_y = 1200, 700
scn.render.filepath = preview
bpy.ops.render.render(write_still=True)

# second check: straight down the zenith axis, orthographic, so every module is visible
cam.data.type = "ORTHO"
cam.data.ortho_scale = 125
cam.location = (0, 0, 120)
cam.rotation_euler = (0, 0, 0)
scn.render.filepath = preview.replace(".png", "-top.png")
bpy.ops.render.render(write_still=True)
