import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { Spring, SPRING_RELEASE, clamp, reducedMotion } from "../../motion";
import { buildDragon, type DragonKind } from "./Dragon";

/**
 * The ISS close up, at true size (metres), in its orbital frame: +X along the velocity (forward),
 * +Y away from Earth (zenith), +Z completing the right-handed frame. PlanetView draws Earth and
 * the satellite swarm from the same viewpoint first, then this scene over it.
 *
 * Model: NASA JSC Visual Communications Lab, "ISS complete 2011" (NASA 3D Resources), converted
 * from LightWave. Updated where it matters here: Nauka (MLM) only from July 2021, and PMA-3 moved
 * from Tranquility to Harmony zenith (March 2017), where it carries IDA-3.
 */
export type StationScene = "2011" | "demo2" | "today" | "lowering" | "usdv" | "reentry";

// docking interfaces in the model frame (metres), from the converted module bounds
const IDA2 = { pos: new THREE.Vector3(16.1, -1.61, -0.03), axis: new THREE.Vector3(1, 0, 0) };   // Harmony forward (PMA-2)
const IDA3 = { pos: new THREE.Vector3(9.85, 3.85, -0.01), axis: new THREE.Vector3(0, 1, 0) };     // Harmony zenith (PMA-3, from 2017)
// PMA-3 as modelled (2011, on Tranquility port): its base and axis, and where it went in 2017
const PMA3_BASE_2011 = new THREE.Vector3(-4.435, -1.64, -8.82);
const HARMONY_ZENITH = new THREE.Vector3(9.85, 0.78, -0.01);

/** Approach: 400 m (waypoint 0) → 220 m hold → 20 m hold → contact at 8 cm/s (NASA / SpaceX). */
const DOCK = [
  // t (s on screen), range (m), time ×
  { t: 0, r: 400, x: 120 }, { t: 7, r: 220, x: 120 }, { t: 9, r: 220, x: 60 },
  { t: 17, r: 20, x: 100 }, { t: 19, r: 20, x: 60 }, { t: 25, r: 0, x: 42 },
];

const heatChunk = /* glsl */ `
#include <emissivemap_fragment>
{
  float facing = clamp(dot(normal, uHeatDir) * 0.5 + 0.5, 0.0, 1.0);
  totalEmissiveRadiance += vec3(1.0, 0.42, 0.12) * uHeat * (0.04 + 1.8 * pow(facing, 4.0));
}`;

export class StationView {
  readonly scene = new THREE.Scene();
  readonly cam = new THREE.PerspectiveCamera(36, 1, 0.1, 5000);
  readonly station = new THREE.Group();
  /** 0..1, how far into the close-up we are (springs) */
  readonly k = new Spring(0, SPRING_RELEASE);
  sceneName: StationScene = "today";
  active = false;
  // orbit camera (local frame): yaw/pitch around the station, distance in metres
  yaw = new Spring(0.9, SPRING_RELEASE); pitch = new Spring(0.32, SPRING_RELEASE); dist = new Spring(140, SPRING_RELEASE);
  /** local point the camera looks at */
  readonly look = new THREE.Vector3();
  private lookGoal = new THREE.Vector3();
  private sun = new THREE.DirectionalLight(0xfff6ec, 3.4);
  private earthshine = new THREE.HemisphereLight(0x0b0f18, 0x5f80a8, 1.1);
  private modules = new Map<string, THREE.Object3D>();
  private pma3?: { obj: THREE.Object3D; m2011: THREE.Matrix4; m2017: THREE.Matrix4 };
  /** port and starboard solar alpha rotary joints: the outboard truss turns to face the Sun */
  private alpha: THREE.Group[] = [];
  private vehicles = new Map<string, THREE.Group>();
  private heat = { uHeat: { value: 0 }, uHeatDir: { value: new THREE.Vector3(1, 0, 0) } };
  private plasma?: THREE.Mesh;
  private t = 0;               // seconds into the current scene
  private loaded: Promise<void> | null = null;
  private hud: HTMLElement;
  onExit: () => void = () => {};

  constructor() {
    this.scene.add(this.station, this.sun, this.sun.target, this.earthshine);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 1; sc.far = 400;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.hud = document.createElement("div");
    this.hud.className = "station-hud";
    this.hud.innerHTML = `<button class="sh-back" aria-label="Back to Earth"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>Earth</button><p class="sh-name"></p><p class="sh-line"></p><p class="sh-data"></p><p class="sh-credit">ISS model: NASA. Orbit: CelesTrak, real time</p>`;
    document.body.appendChild(this.hud);
    this.hud.querySelector(".sh-back")!.addEventListener("click", () => this.onExit());
  }

  load() {
    this.loaded ??= (async () => {
      const draco = new DRACOLoader().setDecoderPath("/draco/");
      const gltf = await new GLTFLoader().setDRACOLoader(draco).loadAsync("/models/iss.glb");
      const root = gltf.scene;
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.castShadow = m.receiveShadow = true;
        m.material = this.restyle(m.material as THREE.MeshStandardMaterial);
        const mod = (m.parent && m.parent !== root ? m.parent.name : m.name) || m.name;
        if (!this.modules.has(mod)) this.modules.set(mod, m.parent && m.parent !== root ? m.parent : m);
      });
      this.station.add(root);
      const pma = this.modules.get("pma3-ext");
      if (pma) {
        pma.updateMatrix();
        const m2011 = pma.matrix.clone();
        // move: base to origin, turn its axis (-Z) to +Y, then onto Harmony's zenith port
        const m2017 = new THREE.Matrix4().makeTranslation(HARMONY_ZENITH.x, HARMONY_ZENITH.y, HARMONY_ZENITH.z)
          .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
          .multiply(new THREE.Matrix4().makeTranslation(-PMA3_BASE_2011.x, -PMA3_BASE_2011.y, -PMA3_BASE_2011.z))
          .multiply(m2011);
        this.pma3 = { obj: pma, m2011, m2017 };
        pma.matrixAutoUpdate = false;
      }
      // SARJs sit on the truss (model z) inboard of P4/S4; everything outboard turns with them
      const axisY = 3.4;
      for (const [side, ids] of [[1, ["p4-ani", "P5", "p6-ani", "papi-ani_w_goldcells", "papo-ani_w_goldcells"]], [-1, ["s4-ani", "S5", "s6-ani", "pasi-ani_w_goldcells", "paso-ani_w_goldcells"]]] as const) {
        const pivot = new THREE.Group();
        pivot.name = side > 0 ? "port-sarj" : "stbd-sarj";
        pivot.position.set(0, axisY, 0);
        root.add(pivot);
        for (const id of ids) {
          const m = this.modules.get(id);
          if (!m) continue;
          pivot.attach(m);
        }
        this.alpha.push(pivot);
      }
      for (const m of this.modules.values()) m.userData.base = m.position.clone();
      this.buildPlasma();
      this.configure(this.sceneName);
    })();
    return this.loaded;
  }

  /** NASA's model ships flat material colours; give them the real surfaces. */
  private restyle(src: THREE.MeshStandardMaterial) {
    const name = (src.name || "").toLowerCase();
    const c = src.color?.clone() ?? new THREE.Color(0.8, 0.8, 0.8);
    let m: THREE.MeshStandardMaterial;
    if (/pan-cels|goldcells/.test(name)) {
      // US arrays: one two-sided blanket — amber photovoltaic cells on its face, pale Kapton behind
      m = new THREE.MeshPhysicalMaterial({ color: 0x5a3a12, roughness: 0.3, metalness: 0.55, clearcoat: 0.6, clearcoatRoughness: 0.2 });
      m.userData.twoTone = true;
    } else if (/pan-celback/.test(name)) {
      // NASA's model splits each blanket's triangles between "cells" and "back": same surface
      m = new THREE.MeshPhysicalMaterial({ color: 0x5a3a12, roughness: 0.3, metalness: 0.55, clearcoat: 0.6, clearcoatRoughness: 0.2 });
      m.userData.twoTone = true;
    } else if (/panel-back|panel-sides|centrstruct/.test(name)) {
      m = new THREE.MeshStandardMaterial({ color: 0xcfc8b8, roughness: 0.7, metalness: 0.05 });
    } else if (/solar_cells|fgb-pan|panel-cells/.test(name)) {
      // Russian arrays: deep blue silicon
      m = new THREE.MeshPhysicalMaterial({ color: 0x0d1d40, roughness: 0.22, metalness: 0.45, clearcoat: 1, clearcoatRoughness: 0.1 });
    } else if (/rad|shield/.test(name)) {
      m = new THREE.MeshStandardMaterial({ color: 0xedeee9, roughness: 0.62, metalness: 0.0 });
    } else if (/gold|foil|brass|thrust|rcs/.test(name)) {
      m = new THREE.MeshStandardMaterial({ color: 0xb8893a, roughness: 0.35, metalness: 0.9 });
    } else if (/glass|lens|window/.test(name)) {
      m = new THREE.MeshPhysicalMaterial({ color: 0x07090c, roughness: 0.05, metalness: 0.1, clearcoat: 1 });
    } else if (/truss|structure|keel|lca|side-zenith|sgant_boom/.test(name)) {
      m = new THREE.MeshStandardMaterial({ color: c.multiplyScalar(1.15), roughness: 0.5, metalness: 0.55 });
    } else {
      // module skins: white MMOD blankets and aluminium
      m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.58, metalness: 0.12 });
    }
    m.name = src.name;
    // array blankets are modelled as coincident front (cells) and back polygons: draw each one
    // only from its own side, or they z-fight; everything else is two-sided (mixed winding)
    m.side = THREE.DoubleSide;
    if (src.emissive && src.emissive.getHex()) m.emissive = src.emissive.clone();
    const twoTone = !!m.userData.twoTone;
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uHeat = this.heat.uHeat;
      sh.uniforms.uHeatDir = this.heat.uHeatDir;
      let f = "uniform float uHeat;\nuniform vec3 uHeatDir;\n" + sh.fragmentShader.replace("#include <emissivemap_fragment>", heatChunk);
      // arrays are flown cell-side to the Sun: the side you see that faces the Sun is the cells,
      // the other is the pale blanket backing (normal already faces the viewer here)
      if (twoTone) f = f.replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
  #if NUM_DIR_LIGHTS > 0
  if (dot(normal, directionalLights[0].direction) < 0.0) { diffuseColor.rgb = vec3(0.8, 0.77, 0.68); metalnessFactor = 0.0; roughnessFactor = 0.75; }
  #endif`);
      sh.fragmentShader = f;
    };
    if (twoTone) m.customProgramCacheKey = () => "iss-twotone";
    return m;
  }

  /**
   * Re-entry: incandescent streaks peeling off the structure and trailing back along the flight
   * path (as in ESA's ATV-1 break-up imagery), seeded from points on the station's own surfaces.
   */
  private buildPlasma() {
    const N = 2600;
    const pts: number[] = [];
    const meshes: THREE.Mesh[] = [];
    this.station.updateMatrixWorld(true);
    this.station.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && (m.geometry.attributes.position?.count ?? 0) > 30) meshes.push(m); });
    const v = new THREE.Vector3();
    for (let i = 0; i < N && meshes.length; i++) {
      const m = meshes[(i * 7919) % meshes.length];
      const pos = m.geometry.attributes.position;
      v.fromBufferAttribute(pos, Math.floor(Math.random() * pos.count)).applyMatrix4(m.matrixWorld);
      pts.push(v.x, v.y, v.z);
    }
    const n = pts.length / 3;
    const p0 = new Float32Array(n * 6), seed = new Float32Array(n * 2), tail = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const sd = Math.random();
      for (const k of [0, 1]) {
        p0.set([pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]], (i * 2 + k) * 3);
        seed[i * 2 + k] = sd;
        tail[i * 2 + k] = k;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(p0, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    g.setAttribute("aTail", new THREE.BufferAttribute(tail, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uT: { value: 0 }, uA: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute float aSeed; attribute float aTail;
        uniform float uT; uniform float uA;
        varying float vA; varying float vAge;
        void main(){
          float age = fract(uT * (0.35 + 0.5 * aSeed) + aSeed * 13.7);
          // shed from the surface and swept aft (-X) by the flow, spreading as it cools
          float back = age * age * (180.0 + 320.0 * aSeed);
          float len = 6.0 + 50.0 * age;
          vec3 p = position;
          p.x -= back + aTail * len;
          p.yz += (vec2(fract(aSeed * 91.3), fract(aSeed * 47.7)) - 0.5) * age * 40.0;
          vAge = age;
          vA = uA * (1.0 - age) * (1.0 - aTail * 0.85) * step(0.15, fract(aSeed * 5.3 + uT * 0.07));
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying float vA; varying float vAge;
        void main(){
          vec3 c = mix(vec3(1.0, 0.92, 0.75), vec3(1.0, 0.36, 0.08), smoothstep(0.0, 0.5, vAge));
          c = mix(c, vec3(0.6, 0.12, 0.04), smoothstep(0.5, 1.0, vAge));
          gl_FragColor = vec4(c * vA, vA);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.plasma = new THREE.LineSegments(g, mat) as unknown as THREE.Mesh;
    this.plasma.visible = false;
    this.plasma.frustumCulled = false;
    this.station.add(this.plasma);
    // the shock layer: a hot glow wrapped round the leading face
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const x = c.getContext("2d")!;
    const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, "rgba(255,240,215,1)"); gr.addColorStop(0.25, "rgba(255,170,90,0.55)"); gr.addColorStop(1, "rgba(255,80,20,0)");
    x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
    glow.scale.set(150, 150, 1);
    glow.position.set(24, 0, 0);
    this.glow = glow;
    this.station.add(glow);
  }
  private glow?: THREE.Sprite;

  private vehicle(id: string, kind: DragonKind) {
    let v = this.vehicles.get(id);
    if (!v) { v = buildDragon(kind); v.name = id; this.vehicles.set(id, v); this.station.add(v); }
    return v;
  }

  /** Lay out the station for a moment in its life. */
  private configure(name: StationScene) {
    const year = { "2011": 2011.5, demo2: 2020.4, today: 2026.8, lowering: 2028.4, usdv: 2029.5, reentry: 2030.95 }[name];
    const nauka = this.modules.get("MLM");
    if (nauka) nauka.visible = year >= 2021.55;          // Nauka docked July 2021
    if (this.pma3) {
      const p = this.pma3;
      p.obj.matrix.copy(year >= 2017.2 ? p.m2017 : p.m2011);  // PMA-3 relocated March 2017
      p.obj.matrixWorldNeedsUpdate = true;
    }
    for (const v of this.vehicles.values()) v.visible = false;
    const dock = (id: string, kind: DragonKind, port: typeof IDA2) => {
      const v = this.vehicle(id, kind);
      v.visible = true;
      v.position.copy(port.pos);
      v.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), port.axis);
      return v;
    };
    if (name === "demo2") dock("endeavour", "crew", IDA2);                 // approach animated in update
    if (name === "today") { dock("crew-13", "crew", IDA2); dock("crs-35", "cargo", IDA3); }
    if (name === "usdv" || name === "reentry") dock("usdv", "deorbit", IDA2);
    // the default viewpoint for each moment
    const view: Record<StationScene, [number, number, number, [number, number, number]]> = {
      "2011": [0.95, 0.3, 150, [0, 0, 0]],
      demo2: [1.3, 0.2, 120, [40, 0, 0]],
      today: [0.85, 0.28, 135, [4, 0, 0]],
      lowering: [2.4, 0.18, 170, [0, 0, 0]],
      usdv: [0.95, 0.24, 165, [14, 0, 0]],
      reentry: [2.2, 0.12, 240, [-20, 0, 0]],
    };
    const [yaw, pitch, dist, look] = view[name];
    this.yaw.target = yaw; this.pitch.target = pitch; this.dist.target = dist;
    this.lookGoal.set(...look);
    for (const m of this.modules.values()) {
      if (m === this.pma3?.obj) continue;
      const base = m.userData.base as THREE.Vector3 | undefined;
      if (base) m.position.copy(base);
      m.rotation.set(0, 0, 0);
    }
  }

  enter(name: StationScene) {
    this.sceneName = name;
    this.active = true;
    this.k.target = 1;
    this.t = 0;
    void this.load().then(() => { if (this.sceneName === name) this.configure(name); });
    this.hud.dataset.on = "";
  }

  exit() {
    this.active = false;
    this.k.target = 0;
    delete this.hud.dataset.on;
  }

  get visible() { return this.k.x > 0.001; }

  /**
   * @param sunLocal sun direction in the station frame
   * @param alt altitude (km) and speed (km/s) for the readout
   */
  /** Advance the enter/leave transition (runs even while hidden, so entering can start). */
  stepK(dt: number) {
    if (reducedMotion()) this.k.snap(this.k.target); else this.k.step(dt);
    if (this.k.target === 0 && this.k.x < 0.001) this.k.snap(0);
  }

  update(dt: number, sunLocal: THREE.Vector3, readout: { alt: number; speed: number }, sunlit = 1) {
    this.sun.intensity = 3.4 * sunlit;
    this.earthshine.intensity = 0.25 + 0.85 * sunlit;
    this.yaw.step(dt); this.pitch.step(dt); this.dist.step(dt);
    this.look.lerp(this.lookGoal, 1 - Math.exp(-dt * 3));
    this.t += dt;
    this.sun.position.copy(sunLocal).multiplyScalar(200);
    this.sun.target.position.set(0, 0, 0);
    // arrays face the Sun: the joints turn about the truss (z) toward its projection on x–y
    const alphaGoal = Math.atan2(-sunLocal.x, sunLocal.y) + Math.PI;   // cell side (model -Y) to the Sun
    for (const p of this.alpha) {
      let d = alphaGoal - p.rotation.z;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      p.rotation.z += d * (1 - Math.exp(-dt * 0.8));
    }
    const name = this.sceneName;
    const hud = this.hud;
    let data = `${Math.round(readout.alt)} km up · ${readout.speed.toFixed(2)} km/s`;
    let line = "";
    const title: Record<StationScene, string> = {
      "2011": "International Space Station, 2011", demo2: "Demo-2 docking, 31 May 2020", today: "The ISS today",
      lowering: "The ISS, 2028", usdv: "US Deorbit Vehicle attached", reentry: "Re-entry",
    };

    // Demo-2: Endeavour flies the real approach profile to IDA-2
    const endeavour = this.vehicles.get("endeavour");
    if (name === "demo2" && endeavour) {
      const t = this.t % 32;
      let i = 0;
      while (i < DOCK.length - 1 && t > DOCK[i + 1].t) i++;
      const a = DOCK[i], b = DOCK[Math.min(i + 1, DOCK.length - 1)];
      const u = b.t === a.t ? 1 : clamp((t - a.t) / (b.t - a.t), 0, 1);
      const s = u * u * (3 - 2 * u);
      const range = t > DOCK[DOCK.length - 1].t ? 0 : a.r + (b.r - a.r) * s;
      endeavour.position.copy(IDA2.pos).addScaledVector(IDA2.axis, range);
      const speed = Math.abs(b.r - a.r) / Math.max(1, (b.t - a.t) * b.x);
      data = range > 0.05
        ? `Range ${range < 20 ? range.toFixed(1) : Math.round(range)} m · closing ${(range === a.r || range === b.r ? 0 : speed).toFixed(2)} m/s · time ×${b.x}`
        : "Soft capture · hooks closing";
      line = range > 220 ? "Waypoint 0 → 1 along the docking axis" : range > 20 ? "Holding at 220 m, then on to 20 m" : range > 0.05 ? "Final approach at 8 cm/s" : "Docked to Harmony's forward port";
      // keep the station's forward end and Dragon both in frame
      this.lookGoal.set(clamp(IDA2.pos.x * 0.4 + range * 0.5, 4, 210), 0, 0);
      this.dist.target = clamp(90 + range * 1.15, 90, 520);
    } else if (name === "today") {
      line = "Crew-13 on Harmony forward · CRS-35 on Harmony zenith";
    } else if (name === "2011") {
      line = "Assembly complete: 109 m across, about 420 tonnes";
    } else if (name === "lowering") {
      line = "Drag and thruster burns start lowering the orbit (projected)";
    } else if (name === "usdv") {
      line = "A Dragon with an enlarged trunk, to push the station down (projected; shape illustrative)";
    }

    // re-entry: the station heats from its leading faces, arrays tear away, plasma streams behind
    const reentry = name === "reentry";
    const rt = reentry ? Math.min(this.t, 14) : 0;
    this.heat.uHeat.value = reentry ? clamp((rt - 1) / 5, 0, 1) * 1.6 : 0;
    this.heat.uHeatDir.value.set(1, 0, 0).transformDirection(this.cam.matrixWorldInverse);
    if (this.plasma) {
      this.plasma.visible = reentry;
      const m = this.plasma.material as THREE.ShaderMaterial;
      m.uniforms.uT.value = this.t;
      m.uniforms.uA.value = reentry ? clamp((rt - 2) / 5, 0, 1) * 1.2 : 0;
    }
    if (this.glow) {
      this.glow.visible = reentry;
      (this.glow.material as THREE.SpriteMaterial).opacity = reentry ? clamp((rt - 1.5) / 4, 0, 1) * (0.75 + 0.1 * Math.sin(this.t * 23)) : 0;
    }
    if (reentry) {
      line = "Final burn done: the station breaks up over the South Pacific (projected)";
      data = `${Math.round(clamp(110 - rt * 4, 60, 110))} km up · plasma at the leading edges`;
      const shed = clamp((rt - 6) / 8, 0, 1);
      for (const [id, mod] of this.modules) {
        if (!/pa(pi|po|si|so)|p6|s6|p4|s4/.test(id)) continue;
        const k = shed * (0.6 + 0.4 * ((id.length * 37) % 10) / 10);
        const base = mod.userData.base as THREE.Vector3;
        mod.position.set(base.x - k * k * 260, base.y + k * 8 * Math.sin(id.length), base.z + k * 14 * Math.cos(id.length));
        mod.rotation.set(k * 1.4, k * 0.6, k * 2.1);
      }
    }
    hud.querySelector(".sh-name")!.textContent = title[name];
    hud.querySelector(".sh-line")!.textContent = line;
    hud.querySelector(".sh-data")!.textContent = data;
  }

  /** Camera pose in the station frame (metres). */
  pose(out = new THREE.Vector3()) {
    // portrait screens are narrow: stand further back so the 109 m span still fits
    const y = this.yaw.x, p = this.pitch.x, d = this.dist.x * Math.max(1, 0.95 / this.cam.aspect);
    return out.set(Math.cos(p) * Math.cos(y), Math.sin(p), Math.cos(p) * Math.sin(y)).multiplyScalar(d).add(this.look);
  }

  /** Load and compile ahead of the first visit, off-screen, so flying in never stalls. */
  async warm(r: THREE.WebGLRenderer) {
    await this.load();
    const rt = new THREE.WebGLRenderTarget(64, 64);
    const tm = r.toneMapping;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    const hidden: THREE.Object3D[] = [];
    this.station.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
    for (const kind of ["crew", "cargo", "deorbit"] as const) this.vehicle(`warm-${kind}`, kind);
    this.cam.position.set(120, 60, 120); this.cam.lookAt(0, 0, 0); this.cam.updateMatrixWorld();
    const prev = r.getRenderTarget();
    r.setRenderTarget(rt);
    await r.compileAsync(this.scene, this.cam).catch(() => {});
    r.render(this.scene, this.cam);          // shadow-map programs too
    r.setRenderTarget(prev);
    r.toneMapping = tm;
    for (const o of hidden) o.visible = false;
    for (const kind of ["crew", "cargo", "deorbit"]) { const v = this.vehicles.get(`warm-${kind}`); if (v) v.visible = false; }
    rt.dispose();
  }

  render(r: THREE.WebGLRenderer) {
    const prevTM = r.toneMapping, prevExp = r.toneMappingExposure;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    const ac = r.autoClear;
    r.autoClear = false;
    r.clearDepth();
    r.render(this.scene, this.cam);
    r.autoClear = ac;
    r.toneMapping = prevTM; r.toneMappingExposure = prevExp;
  }
}
