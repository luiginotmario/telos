import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { BodyId } from "../../bodies";
import type { Globe } from "../Globe";
import { latLonToDir } from "../Globe";
import { createDust, createPlume } from "./effects";
import { FACADE, LOT, MAT, OptimusCrowd, STREET, carGeometry, crane, bermedHab, blockUnit, dome, iceMine, isruPlant, landingPad, massDriver, moonHotel, reactor, road, rover, solarField, solarTower, street, toHLS } from "./kit";
import { type Item, buildMarsPlan, buildMoonPlan, moonRobotsAt, robotsAt } from "./plans";
import { Spring, clamp, follow } from "../../motion";
import type { Sound } from "../../sound";

/**
 * A surface base built on a globe at its true location. Miniature styling: the layout spans
 * ~±0.07 rad per 900 m of plan and structures are enlarged ×OBJ_K so they read from the air —
 * toy-planet scale, labelled as such. Everything repeated is GPU-instanced (one draw per part).
 */
const S_POS = 0.07 / 900;
const OBJ_K = 2.6;
const BOT_K = 3;
const S_OBJ = S_POS * OBJ_K;

export interface SiteDef {
  body: BodyId; id: string; name: string; note: string;
  lat: number; lon: number; firstYear: number;
  plan: () => Item[]; robots: (y: number) => number;
  lunar: boolean;
  sunElev: number;        // radians above the local horizon
  /** event id → plan point the camera frames when that event is on the ruler */
  focus: Record<string, { x: number; z: number; zoom: number }>;
}

export const SITES: SiteDef[] = [
  {
    body: "mars", id: "arcadia-ap9", name: "Arcadia Planitia", note: "SpaceX candidate site AP-9",
    lat: 40.02, lon: -156.65, firstYear: 2031, plan: buildMarsPlan, robots: robotsAt, lunar: false, sunElev: 0.44,
    focus: {
      "spacex-mars-city-start": { x: -200, z: 80, zoom: 13 },     // first ships, robots, first solar field
      "nasa-humans-to-mars": { x: -500, z: 0, zoom: 10 },         // pads and the plant
    },
  },
  {
    // NASA Artemis candidate region (2024); at the pole the Sun stays within ~1.5° of the horizon
    body: "moon", id: "de-gerlache-rim-2", name: "de Gerlache Rim 2", note: "NASA Artemis candidate region",
    lat: -88.5, lon: -87.1, firstYear: 2027.9, plan: buildMoonPlan, robots: moonRobotsAt, lunar: true, sunElev: 0.1,
    focus: {
      "starship-uncrewed": { x: -120, z: 60, zoom: 13 },
      "artemis-4": { x: 60, z: -40, zoom: 13 },
      "china-crewed": { x: 300, z: -200, zoom: 11 },              // (shown: NASA's solar towers going up)
      "gru-moon-hotel": { x: -230, z: -40, zoom: 40 },             // GRU Space's inflatable hotel, close up
      "nasa-moon-base": { x: -60, z: 60, zoom: 11 },
      "musk-moon-city": { x: -500, z: 500, zoom: 9 },
    },
  },
];

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const WHITE = new THREE.Color(1, 1, 1);
// building palette: off-whites with a little warmth and coolness, like painted render and panels
const PALETTE = [0xf5f2ec, 0xf0ebe3, 0xebe7e1, 0xf7f5f1, 0xe6e2dc, 0xefe6da, 0xe9ecee].map((c) => new THREE.Color(c));

/** One template → one InstancedMesh per part. */
class Pool {
  parts: { mesh: THREE.InstancedMesh; local: THREE.Matrix4; tint: boolean }[] = [];
  private n = 0;
  private m = new THREE.Matrix4();
  constructor(template: THREE.Object3D, readonly cap: number, parent: THREE.Object3D, renderOrder = 0) {
    template.updateMatrixWorld(true);
    template.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || (o as THREE.InstancedMesh).isInstancedMesh || !visibleInTree(o)) return;
      const im = new THREE.InstancedMesh(mesh.geometry, mesh.material, cap);
      im.castShadow = mesh.castShadow; im.receiveShadow = mesh.receiveShadow;
      im.count = 0; im.frustumCulled = false; im.renderOrder = mesh.renderOrder || renderOrder;
      for (let i = 0; i < cap; i++) im.setMatrixAt(i, ZERO);
      const tint = !!mesh.userData.tint;
      if (tint) for (let i = 0; i < cap; i++) im.setColorAt(i, WHITE);
      parent.add(im);
      this.parts.push({ mesh: im, local: mesh.matrixWorld.clone(), tint });
    });
  }
  alloc() { return this.n++; }
  tint(i: number, c: THREE.Color) {
    for (const p of this.parts) if (p.tint) { p.mesh.setColorAt(i, c); p.mesh.instanceColor!.needsUpdate = true; }
  }
  set(i: number, m: THREE.Matrix4 | null) {
    for (const p of this.parts) { p.mesh.setMatrixAt(i, m ? this.m.multiplyMatrices(m, p.local) : ZERO); p.mesh.instanceMatrix.needsUpdate = true; }
  }
  /** visible instances are a prefix (items are allocated in year order) */
  setCount(c: number) { for (const p of this.parts) p.mesh.count = c; }
}
function visibleInTree(o: THREE.Object3D) { for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false; return true; }

interface Live {
  item: Item; shown: Spring; on: boolean; dirty: boolean;
  pool?: Pool; idx: number; aoIdx: number;
  obj?: THREE.Object3D;
  path?: THREE.CatmullRomCurve3; pathLen?: number;
}
interface Agent { x: number; z: number; heading: number; phase: number; walking: number; tx: number; tz: number; wait: number; speed: number; base: THREE.Matrix4 }

export class BaseLayer {
  readonly group = new THREE.Group();
  private up: THREE.Vector3; private east: THREE.Vector3; private north: THREE.Vector3;
  private lives: Live[] = [];
  private pools = new Map<string, Pool>();
  private ao: Pool | null = null;
  private crowd = new OptimusCrowd(140);
  private agents: Agent[] = [];
  private plume = createPlume();
  private dust = createDust(1200);
  private landing: { live: Live; t: number } | null = null;
  // traffic: instanced vehicles on built roads and district streets
  private routes: { pts: [number, number][]; lens: number[]; total: number; year: number }[] = [];
  private cars: { route: number; u: number; dir: 1 | -1; speed: number; lane: number }[] = [];
  private carBody: THREE.InstancedMesh | null = null;
  private carGlass: THREE.InstancedMesh | null = null;
  private carTyres: THREE.InstancedMesh | null = null;
  private cranes: Pool | null = null;
  private blockLives: Live[] = [];
  private year = 2020;
  private lastYear = 2020;
  ready: Promise<void>;

  constructor(private globe: Globe, readonly site: SiteDef, private sound: Sound) {
    FACADE.sObj.value = S_OBJ;
    this.up = latLonToDir(site.lat, site.lon);
    this.east = latLonToDir(site.lat, site.lon + 0.5).sub(latLonToDir(site.lat, site.lon - 0.5)).normalize();
    this.north = new THREE.Vector3().crossVectors(this.up, this.east).normalize();
    globe.spin.add(this.group);
    this.group.add(this.crowd.group);
    this.plume.mesh.renderOrder = 6;
    this.plume.mesh.matrixAutoUpdate = false;
    this.dust.pts.matrixAutoUpdate = false;
    this.group.add(this.plume.mesh, this.dust.pts);
    this.group.visible = false;
    this.ready = this.build();
  }

  get lat() { return this.site.lat; }
  get lon() { return this.site.lon; }

  toSphere(x: number, z: number, lift = 0, out = new THREE.Vector3()) {
    out.copy(this.up).addScaledVector(this.east, x * S_POS).addScaledVector(this.north, -z * S_POS).normalize();
    return out.multiplyScalar(1.0006 + lift);
  }

  /** +Y = local up, +X = east, +Z = south, then heading; optional non-uniform scale. */
  frameAt(x: number, z: number, heading: number, scale: number | THREE.Vector3, out = new THREE.Matrix4(), lift = 0) {
    const p = this.toSphere(x, z, lift);
    const n = p.clone().normalize();
    const e = this.east.clone().addScaledVector(n, -this.east.dot(n)).normalize();
    const s = new THREE.Vector3().crossVectors(e, n).normalize();
    out.makeBasis(e, n, s).multiply(tmpR.makeRotationY(heading));
    out.scale(typeof scale === "number" ? tmpV.setScalar(scale) : scale);
    return out.setPosition(p);
  }

  private async build() {
    let ship: THREE.Object3D;
    try {
      const gltf = await new GLTFLoader().loadAsync("/models/starship.glb");
      ship = gltf.scene;
      ship.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
    } catch { ship = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 4.5, 50), MAT.steel); }
    if (this.site.lunar) ship = toHLS(ship);
    this.ground();
    const plan = this.site.plan();
    const count = (k: string) => plan.filter((i) => i.kind === k).length;
    const pooled: Record<string, () => THREE.Object3D> = {
      ship: () => ship, pad: landingPad, dome: () => dome(1), block: () => this.localise(blockUnit()), hab: () => this.localise(bermedHab(22)),
      street: () => this.localise(street()), tower: solarTower, reactor,
    };
    for (const [k, make] of Object.entries(pooled)) if (count(k)) this.pools.set(k, new Pool(make(), count(k), this.group));
    const aoMat = new THREE.MeshBasicMaterial({ map: aoTexture(this.site.lunar), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 });
    const aoT = new THREE.Mesh(new THREE.CircleGeometry(1, 32).rotateX(-Math.PI / 2), aoMat);
    this.ao = new Pool(aoT, plan.length, this.group, 2);
    for (const item of plan) this.realise(item);
    this.buildTraffic(plan);
    this.cranes = new Pool(crane(), 28, this.group);
    this.blockLives = this.lives.filter((l) => l.item.kind === "block");
  }

  private buildTraffic(plan: Item[]) {
    const add = (pts: [number, number][], year: number) => {
      if (pts.length < 2) return;
      const lens = [0];
      for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      if (lens[lens.length - 1] > 60) this.routes.push({ pts, lens, total: lens[lens.length - 1], year });
    };
    for (const r of plan) if (r.kind === "road" && r.path) add(r.path, r.year);
    // district streets → straight runs along each grid line, split where the street breaks
    const lines = new Map<string, Item[]>();
    for (const st of plan) if (st.kind === "street") {
      const along = Math.abs(Math.sin(st.rot)) > 0.5 ? "z" : "x";
      const k = along === "x" ? `x:${Math.round(st.z)}` : `z:${Math.round(st.x)}`;
      (lines.get(k) ?? lines.set(k, []).get(k)!).push(st);
    }
    for (const [k, list] of lines) {
      const alongX = k.startsWith("x");
      list.sort((a, b) => (alongX ? a.x - b.x : a.z - b.z));
      let run: Item[] = [];
      const flush = () => {
        if (run.length >= 4) {
          const a = run[0], b = run[run.length - 1];
          const ys = run.map((r) => r.year).sort((p, q) => p - q);
          add(alongX ? [[a.x, a.z], [b.x, b.z]] : [[a.x, a.z], [b.x, b.z]], ys[Math.floor(ys.length * 0.6)]);
        }
        run = [];
      };
      for (const st of list) {
        const prev = run[run.length - 1];
        if (prev && Math.hypot(st.x - prev.x, st.z - prev.z) > (st.w ?? 44) * 1.6) flush();
        run.push(st);
      }
      flush();
    }
    if (!this.routes.length) return;
    const CAP = 180;
    const g = carGeometry();
    this.carBody = new THREE.InstancedMesh(g.shell, MAT.white, CAP);
    this.carGlass = new THREE.InstancedMesh(g.glass, MAT.black, CAP);
    this.carTyres = new THREE.InstancedMesh(g.tyres, MAT.tyre, CAP);
    for (const m of [this.carBody, this.carGlass, this.carTyres]) { m.count = 0; m.castShadow = true; m.frustumCulled = false; this.group.add(m); }
  }

  /** Cranes stand over the newest buildings (raised in the last ~8 months of the timeline). */
  private updateCranes(t: number) {
    const pool = this.cranes;
    if (!pool) return;
    const y = this.year;
    let n = 0;
    const m = new THREE.Matrix4();
    for (let i = this.blockLives.length - 1; i >= 0 && n < pool.cap; i--) {
      const L = this.blockLives[i];
      if (L.item.year > y) continue;
      if (L.item.year < y - 0.7) break;
      const it = L.item;
      const slew = Math.sin(t * 0.25 + i) * 0.9 + i;      // jibs slowly slewing
      this.frameAt(it.x + 9, it.z - 7, slew, S_OBJ * 0.9, m);
      pool.set(n++, m);
    }
    pool.setCount(n);
  }

  private updateTraffic(dt: number) {
    if (!this.carBody || !this.carGlass) return;
    const open = this.routes.map((r, i) => (r.year <= this.year ? i : -1)).filter((i) => i >= 0);
    const want = open.length ? Math.min(180, Math.round(6 + (this.year - this.site.firstYear) * 9 + open.length * 0.6)) : 0;
    while (this.cars.length < want) {
      const route = open[Math.floor(Math.random() * open.length)];
      this.cars.push({ route, u: Math.random() * this.routes[route].total, dir: Math.random() < 0.5 ? 1 : -1, speed: 32 + Math.random() * 22, lane: 3.2 });
    }
    if (this.cars.length > want) this.cars.length = want;
    const m = new THREE.Matrix4();
    let n = 0;
    for (const c of this.cars) {
      const r = this.routes[c.route];
      if (r.year > this.year) continue;
      c.u += c.dir * c.speed * dt;
      if (c.u > r.total) { c.u = r.total; c.dir = -1; }
      if (c.u < 0) { c.u = 0; c.dir = 1; }
      let i = 1; while (i < r.lens.length - 1 && r.lens[i] < c.u) i++;
      const t = (c.u - r.lens[i - 1]) / Math.max(1e-6, r.lens[i] - r.lens[i - 1]);
      const [ax, az] = r.pts[i - 1], [bx, bz] = r.pts[i];
      const dx = (bx - ax) * c.dir, dz = (bz - az) * c.dir;
      const len = Math.hypot(dx, dz) || 1;
      // keep right: offset across the direction of travel
      const ox = (-dz / len) * c.lane, oz = (dx / len) * c.lane;
      const x = ax + (bx - ax) * t + ox, z = az + (bz - az) * t + oz;
      this.frameAt(x, z, Math.atan2(-dz, dx), S_OBJ * 1.6, m, 0.000002);
      this.carBody.setMatrixAt(n, m); this.carGlass.setMatrixAt(n, m); this.carTyres!.setMatrixAt(n, m);
      n++;
    }
    for (const mm of [this.carBody, this.carGlass, this.carTyres!]) { mm.count = n; mm.instanceMatrix.needsUpdate = true; }
  }

  /** Shadow catcher + close-range grain over the real globe surface. */
  private ground() {
    const half = 0.24, N = 112;
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      const u = i / N, v = j / N;
      const p = this.up.clone().addScaledVector(this.east, (u - 0.5) * 2 * half).addScaledVector(this.north, (v - 0.5) * 2 * half).normalize().multiplyScalar(1.0003);
      pos.push(p.x, p.y, p.z); uv.push(u, v);
      if (i < N && j < N) { const a = j * (N + 1) + i; idx.push(a, a + 1, a + N + 1, a + 1, a + N + 2, a + N + 1); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals();
    const cap = new THREE.Mesh(g, new THREE.ShadowMaterial({ color: this.site.lunar ? 0x0a0a0c : 0x2a170c, opacity: this.site.lunar ? 0.55 : 0.42, transparent: true, depthWrite: false }));
    cap.receiveShadow = true; cap.renderOrder = 1;
    // close-range ground: rocks, small craters and wind streaks laid over the real globe colour
    // with a mod-2× blend (0.5 = unchanged), so detail can brighten as well as darken
    const grain = new THREE.Mesh(g, new THREE.ShaderMaterial({
      uniforms: { tD: { value: grainTexture() }, tS: { value: streakTexture() } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying vec2 vUv; uniform sampler2D tD; uniform sampler2D tS;
        void main(){
          float f = 1.0 - smoothstep(0.3, 0.98, length((vUv - 0.5) * 2.0));
          float fine = texture2D(tD, vUv * 90.0).r;
          float mid = texture2D(tD, vUv * 21.0 + 0.37).r;
          float streak = texture2D(tS, vUv * vec2(5.0, 9.0)).r;
          float v = 0.5 + ((fine - 0.5) * 0.55 + (mid - 0.5) * 0.45 + (streak - 0.5) * 0.35) * f;
          gl_FragColor = vec4(vec3(v), 1.0);
        }`,
      transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.DstColorFactor, blendDst: THREE.SrcColorFactor, blendEquation: THREE.AddEquation,
    }));
    this.group.add(grain, cap);
  }

  private realise(item: Item) {
    if (item.kind === "ship") item = { ...item, rot: ((item.rot * 7.31) % 0.7) - 0.35 };
    const live: Live = { item, shown: new Spring(0, { stiffness: 120, damping: 18 }), on: false, dirty: true, idx: -1, aoIdx: -1 };
    const pool = this.pools.get(item.kind);
    if (pool) {
      live.pool = pool; live.idx = pool.alloc();
      if (item.kind === "block") pool.tint(live.idx, PALETTE[Math.abs(Math.round(item.x * 7.13 + item.z * 3.71)) % PALETTE.length]);
    }
    else {
      let obj: THREE.Object3D | null = null;
      switch (item.kind) {
        case "solar": obj = solarField(item.size ?? 12, 36); break;
        case "isru": obj = isruPlant(); break;
        case "mine": obj = iceMine(); break;
        case "rover": obj = rover(!!item.pressurized); break;
        case "driver": obj = massDriver(); break;
        case "hotel": obj = moonHotel(item.until ?? 2038); break;
        case "road": obj = road((item.path ?? []).map(([px, pz]) => this.toSphere(px, pz, 0.00002)), 10 * S_OBJ, (q) => q.clone().normalize()); break;
      }
      if (obj) {
        this.localise(obj);
        if (item.kind !== "road") { obj.matrixAutoUpdate = false; setM(obj, this.frameAt(item.x, item.z, item.rot, S_OBJ)); }
        obj.visible = false;
        this.group.add(obj);
        live.obj = obj;
      }
    }
    if (footprintOf(item) && this.ao) live.aoIdx = this.ao.alloc();
    if (item.path && item.kind === "rover") {
      live.path = new THREE.CatmullRomCurve3(item.path.map(([px, pz]) => new THREE.Vector3(px, 0, pz)), true);
      live.pathLen = live.path.getLength();
    }
    this.lives.push(live);
  }

  /** Regolith-coloured parts take the local soil: butterscotch on Mars, grey on the Moon. */
  private lunar = {
    soil: (() => { const m = MAT.berm.clone(); m.color.set(0x9a9894); return m; })(),
    street: (() => { const m = STREET.clone(); m.color.set(0xb4b3b0); return m; })(),
    lot: (() => { const m = LOT.clone(); m.color.set(0xd6d5d2); return m; })(),
  };
  private localise<T extends THREE.Object3D>(o: T): T {
    if (!this.site.lunar) return o;
    o.traverse((c) => {
      const m = c as THREE.Mesh;
      if (!m.isMesh) return;
      if (m.material === MAT.berm) m.material = this.lunar.soil;
      else if (m.material === STREET) m.material = this.lunar.street;
      else if (m.material === LOT) m.material = this.lunar.lot;
    });
    return o;
  }

  setYear(y: number) { this.year = y; }
  get hasActivity() { return this.year >= this.site.firstYear - 0.05; }

  /** How much of the plan is standing (0..1), for the city soundscape. */
  built = 0;

  update(dt: number, t: number, cam: THREE.Camera, active: boolean) {
    const want = active && this.hasActivity;
    this.group.visible = want;
    if (!want || !this.lives.length || !this.ao) { this.sound.setRumble(0); this.built = 0; this.lastYear = this.year; return; }
    const y = this.year;
    const forward = y > this.lastYear;
    const slow = Math.abs(y - this.lastYear) / Math.max(dt, 1e-3) < 2.5;
    const counts = new Map<Pool, number>();
    let aoCount = 0;
    const m = new THREE.Matrix4();
    for (const L of this.lives) {
      const on = y >= L.item.year;
      if (on !== L.on) {
        L.on = on; L.dirty = true;
        L.shown.target = on ? 1 : 0;
        if (on && forward && slow && L.item.kind === "ship" && !this.landing) { this.landing = { live: L, t: 0 }; L.shown.snap(1); }
      }
      const before = L.shown.x;
      L.shown.step(dt);
      const moving = Math.abs(L.shown.x - before) > 1e-5;
      const k = clamp(L.shown.x, 0, 1.15);
      const vis = k > 0.01;
      if (vis) {
        if (L.pool) counts.set(L.pool, Math.max(counts.get(L.pool) ?? 0, L.idx + 1));
        if (L.aoIdx >= 0) aoCount = Math.max(aoCount, L.aoIdx + 1);
      }
      if (L.obj?.userData.onYear && vis) (L.obj.userData.onYear as (y: number, dt: number) => void)(y, dt);
      const animated = L.item.kind === "rover" || this.landing?.live === L;
      if (!moving && !L.dirty && !animated) continue;
      L.dirty = false;
      if (L.obj) L.obj.visible = vis;
      if (!vis) {
        if (L.pool) L.pool.set(L.idx, null);
        if (L.aoIdx >= 0) this.ao.set(L.aoIdx, null);
        continue;
      }
      const it = L.item;
      const grow = clamp(k, 0.001, 1.12);
      switch (it.kind) {
        case "ship":
          if (this.landing?.live === L) break;
          L.pool!.set(L.idx, this.frameAt(it.x, it.z, it.rot, S_OBJ, m, (1 - clamp(k, 0, 1)) * 0.004));
          break;
        case "solar": {
          const span = (it.until ?? it.year + 1) - it.year;
          (L.obj!.userData.setDeploy as (v: number) => void)(clamp((y - it.year) / span, 0.02, 1));
          break;
        }
        case "rover": {
          if (!L.path) break;
          const u = ((t * 8) / (L.pathLen ?? 1) + it.year) % 1;
          const p = L.path.getPointAt(u), d = L.path.getTangentAt(u);
          setM(L.obj!, this.frameAt(p.x, p.z, Math.atan2(-d.z, d.x), S_OBJ * clamp(k, 0, 1)));
          break;
        }
        case "road": break;
        case "block": L.pool!.set(L.idx, this.frameAt(it.x, it.z, it.rot, new THREE.Vector3((it.w ?? 12) * S_OBJ, (it.h ?? 4) * S_OBJ * grow, (it.d ?? 10) * S_OBJ), m)); break;
        case "street": L.pool!.set(L.idx, this.frameAt(it.x, it.z, it.rot, new THREE.Vector3((it.w ?? 44) * S_POS, S_OBJ * clamp(k, 0.001, 1), S_OBJ * 0.5), m)); break;
        case "dome": L.pool!.set(L.idx, this.frameAt(it.x, it.z, it.rot, new THREE.Vector3(1, grow, 1).multiplyScalar((it.size ?? 18) * S_OBJ), m)); break;
        case "hab": L.pool!.set(L.idx, this.frameAt(it.x, it.z, it.rot, new THREE.Vector3(((it.size ?? 22) / 22) * S_OBJ, S_OBJ * grow, S_OBJ), m)); break;
        default:
          if (L.pool) L.pool.set(L.idx, this.frameAt(it.x, it.z, it.rot, new THREE.Vector3(S_OBJ, S_OBJ * grow, S_OBJ), m));
          else if (L.obj) setM(L.obj, this.frameAt(it.x, it.z, it.rot, S_OBJ, m).multiply(tmpR.makeScale(1, grow, 1)));
      }
      if (L.aoIdx >= 0) this.ao.set(L.aoIdx, this.frameAt(it.x, it.z, 0, footprintOf(it) * S_OBJ * 1.6 * clamp(k, 0, 1), m, 0.000004));
    }
    for (const pool of this.pools.values()) pool.setCount(counts.get(pool) ?? 0);
    this.ao.setCount(aoCount);
    let standing = 0;
    for (const L of this.lives) if (L.on) standing++;
    this.built = standing / this.lives.length;
    this.updateLanding(dt, t, cam);
    this.updateRobots(dt);
    this.updateTraffic(dt);
    this.updateCranes(t);
    this.lastYear = y;
  }

  private updateLanding(dt: number, t: number, cam: THREE.Camera) {
    const L = this.landing;
    this.plume.mesh.visible = false;
    if (!L) { this.sound.setRumble(0); this.dust.u.uT.value = -100; return; }
    L.t += dt;
    const T = 5;
    const u = clamp(L.t / T, 0, 1);
    const h = 900 * (1 - u) * (1 - u);
    const lift = h * S_OBJ;
    const it = L.live.item;
    L.live.pool?.set(L.live.idx, this.frameAt(it.x, it.z, it.rot, S_OBJ, new THREE.Matrix4(), lift));
    const thr = u < 1 ? 1 - 0.3 * u : Math.max(0, 1 - (L.t - T) / 0.4);
    this.plume.mesh.visible = thr > 0.01;
    const reach = clamp((h + 4) / 60, 0.08, 1), fan = 1 + (1 - reach) * 1.6;
    setM(this.plume.mesh, this.frameAt(it.x, it.z, 0, S_OBJ * 1000, new THREE.Matrix4(), lift + 0.4 * S_OBJ).multiply(tmpR.makeScale(fan, (0.7 + 0.5 * thr) * reach, fan)));
    this.plume.u.uThrottle.value = thr; this.plume.u.uT.value = t;
    this.plume.u.uCam.value.copy(cam.position);
    setM(this.dust.pts, this.frameAt(it.x, it.z, 0, S_OBJ * 1000).multiply(tmpR.makeRotationX(-Math.PI / 2)));
    // no air on the Moon: ejecta flies fast and doesn't hang
    this.dust.u.uT.value = h < 120 ? (L.t - T * 0.62) * (this.site.lunar ? 1.8 : 1) : -100;
    this.sound.setRumble(this.site.lunar ? 0 : thr * 0.7); // and no engine roar in a vacuum
    if (L.t > T + 9) this.landing = null;
  }

  private updateRobots(dt: number) {
    const want = this.site.robots(this.year);
    const anchors = this.lives.filter((l) => l.on && ["ship", "solar", "hab", "isru", "dome", "tower", "reactor", "hotel"].includes(l.item.kind));
    while (this.agents.length < want && anchors.length) {
      const a = anchors[Math.floor(Math.random() * anchors.length)].item;
      this.agents.push({ x: a.x + (Math.random() - 0.5) * 40, z: a.z + (Math.random() - 0.5) * 40, heading: Math.random() * 6.28, phase: Math.random() * 6.28, walking: 0, tx: a.x, tz: a.z, wait: Math.random() * 3, speed: 1.2 + Math.random() * 0.4, base: new THREE.Matrix4() });
    }
    if (this.agents.length > want) this.agents.length = want;
    const pace = 9;
    for (const ag of this.agents) {
      const dx = ag.tx - ag.x, dz = ag.tz - ag.z, dd = Math.hypot(dx, dz);
      if (ag.wait > 0) {
        ag.wait -= dt;
        ag.walking = follow(ag.walking, 0, dt, 0.15);
        if (ag.wait <= 0 && anchors.length) {
          const a = anchors[Math.floor(Math.random() * anchors.length)].item;
          const r = (a.kind === "dome" ? (a.size ?? 18) : 18) * OBJ_K * 0.6;
          const ang = Math.random() * Math.PI * 2;
          ag.tx = a.x + Math.cos(ang) * r; ag.tz = a.z + Math.sin(ang) * r;
          if (Math.hypot(ag.tx - ag.x, ag.tz - ag.z) > 220) { ag.tx = ag.x + Math.cos(ang) * 50; ag.tz = ag.z + Math.sin(ang) * 50; }
        }
      } else if (dd < 2) {
        ag.wait = 1.5 + Math.random() * 4;
      } else {
        ag.walking = follow(ag.walking, 1, dt, 0.2);
        let dh = Math.atan2(dx, dz) - ag.heading; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        ag.heading += dh * Math.min(1, dt * 4);
        ag.x += Math.sin(ag.heading) * ag.speed * pace * dt * ag.walking;
        ag.z += Math.cos(ag.heading) * ag.speed * pace * dt * ag.walking;
        ag.phase += dt * ag.speed * 6 * ag.walking;
      }
      this.frameAt(ag.x, ag.z, ag.heading, S_OBJ * BOT_K, ag.base);
    }
    this.crowd.update(this.agents);
  }

  /** World-space point of a plan location. */
  pointWorld(x: number, z: number, out = new THREE.Vector3()) {
    this.group.updateWorldMatrix(true, false);
    return this.toSphere(x, z, 0, out).applyMatrix4(this.group.matrixWorld);
  }

  /** World-space point of the site. */
  siteWorld(out = new THREE.Vector3()) { return out.copy(this.up).applyMatrix4(this.globe.mesh.matrixWorld); }

  /** How far the built area reaches at `year`, in radians of globe (for framing). */
  extentAt(year: number) {
    let r = 350;
    for (const L of this.lives) if (L.item.year <= year && L.item.kind !== "road") r = Math.max(r, Math.hypot(L.item.x, L.item.z));
    return r * S_POS;
  }
}

const tmpR = new THREE.Matrix4(), tmpV = new THREE.Vector3();
function setM(o: THREE.Object3D, m: THREE.Matrix4) { o.matrix.copy(m); o.matrixWorldNeedsUpdate = true; }

function footprintOf(i: Item) {
  switch (i.kind) {
    case "ship": return 7; case "pad": return 36; case "dome": return i.size ?? 18; case "hab": return 22;
    case "block": return Math.max(i.w ?? 12, i.d ?? 10) * 0.6; case "isru": return 30; case "mine": return 30;
    case "tower": return 4; case "reactor": return 12; case "solar": return (i.size ?? 12) * 3; case "hotel": return 44;
    default: return 0;
  }
}

function aoTexture(lunar: boolean) {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(64, 64, 4, 64, 64, 64);
  const col = lunar ? "10,10,12" : "40,25,15";
  g.addColorStop(0, `rgba(${col},0.5)`); g.addColorStop(0.45, `rgba(${col},0.24)`); g.addColorStop(1, `rgba(${col},0)`);
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function grainTexture() {
  const N = 512;
  const c = document.createElement("canvas"); c.width = c.height = N;
  const x = c.getContext("2d")!;
  x.fillStyle = "rgb(128,128,128)"; x.fillRect(0, 0, N, N);
  const wrap = (f: (dx: number, dy: number) => void) => { for (const dx of [-N, 0, N]) for (const dy of [-N, 0, N]) f(dx, dy); };
  // small craters: dark floor, bright rim on the sun side, soft ejecta
  for (let i = 0; i < 40; i++) {
    const px = Math.random() * N, py = Math.random() * N, r = 4 + Math.random() ** 2.5 * 26;
    wrap((dx, dy) => {
      const g = x.createRadialGradient(px + dx, py + dy, r * 0.1, px + dx, py + dy, r * 1.6);
      g.addColorStop(0, "rgba(70,70,70,0.55)"); g.addColorStop(0.55, "rgba(105,105,105,0.35)"); g.addColorStop(0.7, "rgba(190,190,190,0.35)"); g.addColorStop(1, "rgba(128,128,128,0)");
      x.fillStyle = g; x.beginPath(); x.arc(px + dx, py + dy, r * 1.6, 0, 7); x.fill();
    });
  }
  // rocks with a lit top-left and a shadow bottom-right
  for (let i = 0; i < 3200; i++) {
    const px = Math.random() * N, py = Math.random() * N, r = Math.random() ** 3.5 * 3.2 + 0.4;
    x.fillStyle = "rgba(55,55,55,0.55)"; x.beginPath(); x.arc(px + r * 0.5, py + r * 0.5, r, 0, 7); x.fill();
    x.fillStyle = "rgba(205,205,205,0.6)"; x.beginPath(); x.arc(px - r * 0.15, py - r * 0.15, r * 0.75, 0, 7); x.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** Wind streaks and ripple fields (soft, directional). */
function streakTexture() {
  const N = 256;
  const c = document.createElement("canvas"); c.width = c.height = N;
  const x = c.getContext("2d")!;
  x.fillStyle = "rgb(128,128,128)"; x.fillRect(0, 0, N, N);
  x.filter = "blur(3px)";
  for (let i = 0; i < 90; i++) {
    const y = Math.random() * N, x0 = Math.random() * N, len = 30 + Math.random() * 120;
    x.strokeStyle = `rgba(${Math.random() < 0.5 ? "170,170,170" : "95,95,95"},0.35)`;
    x.lineWidth = 2 + Math.random() * 6;
    x.beginPath(); x.moveTo(x0, y); x.lineTo(x0 + len, y + (Math.random() - 0.5) * 6); x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.NoColorSpace;
  return t;
}
