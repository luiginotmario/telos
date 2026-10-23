import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * Procedural miniature kit for the Mars base. Units: metres, +Y up.
 * Real-world sizes where they exist (Optimus 1.73 m, Starship 9 m wide); the rest follow
 * published concepts (bermed habitats, greenhouse domes, ISRU tank farms) at plausible scale.
 * Look: matte, high-key studio miniature — white structures, clean grey roads, soft shadows.
 */

export const MAT = {
  steel: new THREE.MeshStandardMaterial({ color: 0xcfd2d6, metalness: 0.9, roughness: 0.3 }),
  white: new THREE.MeshStandardMaterial({ color: 0xf4f2ee, metalness: 0, roughness: 0.78 }),
  roof: new THREE.MeshStandardMaterial({ color: 0xe2ddd6, metalness: 0, roughness: 0.85 }),
  black: new THREE.MeshStandardMaterial({ color: 0x1a1b1f, metalness: 0.2, roughness: 0.5 }),
  pv: new THREE.MeshStandardMaterial({ color: 0x23304a, metalness: 0.5, roughness: 0.3 }),
  pvFrame: new THREE.MeshStandardMaterial({ color: 0xd6d8db, metalness: 0.3, roughness: 0.5 }),
  pad: new THREE.MeshStandardMaterial({ color: 0xd9d3cc, metalness: 0, roughness: 0.92 }),
  road: new THREE.MeshStandardMaterial({ color: 0xb7aea6, metalness: 0, roughness: 0.95, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  roadEdge: new THREE.MeshStandardMaterial({ color: 0xf6f3ef, metalness: 0, roughness: 0.9, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
  glass: new THREE.MeshStandardMaterial({ color: 0xeef5f6, metalness: 0.05, roughness: 0.12, transparent: true, opacity: 0.55, depthWrite: false }),
  green: new THREE.MeshStandardMaterial({ color: 0x8fb26f, metalness: 0, roughness: 0.85 }),
  berm: new THREE.MeshStandardMaterial({ color: 0xc19a7e, metalness: 0, roughness: 1 }),
  tank: new THREE.MeshStandardMaterial({ color: 0xf0eeea, metalness: 0.1, roughness: 0.6 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x6b6763, metalness: 0.2, roughness: 0.7 }),
  tyre: new THREE.MeshStandardMaterial({ color: 0x2a2a2c, metalness: 0.1, roughness: 0.9 }),
};

const WIRE = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.6, depthWrite: false });

const shadowed = (m: THREE.Object3D) => {
  m.traverse((o) => { const mm = o as THREE.Mesh; if (mm.isMesh) { mm.castShadow = true; mm.receiveShadow = true; } });
  return m;
};

// ── landing pad: sintered-regolith disc, 70 m across ───────────────
let padTex: THREE.Texture | null = null;
export function landingPad() {
  if (!padTex) {
    const c = document.createElement("canvas"); c.width = c.height = 256;
    const x = c.getContext("2d")!;
    x.fillStyle = "#dcd6cf"; x.fillRect(0, 0, 256, 256);
    x.strokeStyle = "rgba(150,140,132,0.8)"; x.lineWidth = 5;
    x.beginPath(); x.arc(128, 128, 96, 0, Math.PI * 2); x.stroke();
    x.lineWidth = 3; x.beginPath(); x.arc(128, 128, 30, 0, Math.PI * 2); x.stroke();
    for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + Math.PI / 4; x.beginPath(); x.moveTo(128 + Math.cos(a) * 40, 128 + Math.sin(a) * 40); x.lineTo(128 + Math.cos(a) * 86, 128 + Math.sin(a) * 86); x.stroke(); }
    padTex = new THREE.CanvasTexture(c); padTex.colorSpace = THREE.SRGBColorSpace; padTex.anisotropy = 8;
  }
  const top = new THREE.MeshStandardMaterial({ map: padTex, roughness: 0.92 });
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(35, 36.5, 1.2, 64), [MAT.pad, top, MAT.pad]);
  disc.position.y = 0.6;
  const g = new THREE.Group(); g.add(disc);
  return shadowed(g);
}

// ── solar field: rows of tilted panels (instanced) ─────────────────
export function solarField(rows: number, perRow: number, tiltDeg = 25) {
  const panel = new THREE.BoxGeometry(2, 0.08, 1);
  const count = rows * perRow;
  const pv = new THREE.InstancedMesh(panel, MAT.pv, count);
  const leg = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 1, 0.1), MAT.pvFrame, count);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
  q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(tiltDeg));
  let i = 0;
  for (let r = 0; r < rows; r++) for (let k = 0; k < perRow; k++) {
    p.set((k - perRow / 2) * 2.15, 1.05, (r - rows / 2) * 3.4);
    m.compose(p, q, s); pv.setMatrixAt(i, m);
    m.compose(p.clone().setY(0.5), new THREE.Quaternion(), s); leg.setMatrixAt(i, m);
    i++;
  }
  pv.castShadow = leg.castShadow = true; pv.receiveShadow = true;
  const g = new THREE.Group(); g.add(pv, leg);
  /** reveal 0..1 deploys row by row, panel by panel */
  g.userData.setDeploy = (k: number) => { const n = Math.round(count * THREE.MathUtils.clamp(k, 0, 1)); pv.count = n; leg.count = n; };
  g.userData.setDeploy(1);
  g.userData.footprint = Math.max(perRow * 2.15, rows * 3.4) * 0.6;
  return g;
}

// ── greenhouse dome: geodesic hemisphere over planted beds ─────────
export function dome(radius: number) {
  const g = new THREE.Group();
  const shell = new THREE.IcosahedronGeometry(radius, 3);
  const pos = shell.attributes.position;
  for (let i = 0; i < pos.count; i++) if (pos.getY(i) < 0) pos.setY(i, 0);
  shell.computeVertexNormals();
  const glass = new THREE.Mesh(shell, MAT.glass);
  glass.renderOrder = 2;
  glass.castShadow = true;
  const frame = new THREE.Mesh(shell, WIRE);
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.02, radius * 1.06, 1.4, 64), MAT.white);
  ring.position.y = 0.7;
  const beds = new THREE.Group();
  for (let i = -2; i <= 2; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(radius * 1.2 - Math.abs(i) * radius * 0.18, 0.8, radius * 0.16), MAT.green);
    b.position.set(0, 0.6, i * radius * 0.3);
    beds.add(b);
  }
  g.add(ring, beds, glass, frame);
  shadowed(ring); shadowed(beds);
  g.userData.footprint = radius;
  return g;
}

// ── habitat module, half-buried under a regolith berm (radiation shielding) ──
export function bermedHab(length = 22) {
  const g = new THREE.Group();
  const mound = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), MAT.berm);
  mound.scale.set(length * 0.55 + 5, 3.4, 8);
  const hatch = new THREE.Mesh(new THREE.BoxGeometry(4, 3.2, 4.5), MAT.white);
  hatch.position.set(length * 0.55 + 5.5, 1.6, 0);
  const vent = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 2.5, 12), MAT.white);
  vent.position.set(-length * 0.2, 3.6, 0);
  g.add(mound, hatch, vent);
  g.userData.footprint = length * 0.55 + 5;
  return shadowed(g);
}

// ── ISRU plant: Sabatier reactors + methane/oxygen tank farm ──────
export function isruPlant() {
  const g = new THREE.Group();
  const hall = new THREE.Mesh(new THREE.BoxGeometry(28, 7, 14), MAT.white);
  hall.position.y = 3.5;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(28.4, 0.6, 14.4), MAT.roof);
  roof.position.y = 7.3;
  g.add(hall, roof);
  for (let i = 0; i < 4; i++) {
    const r = new THREE.Mesh(new THREE.BoxGeometry(10, 0.25, 4), MAT.white);
    r.position.set(-12 + i * 8, 9.5, -12); r.rotation.x = -0.5;
    const s = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 3), MAT.dark);
    s.position.set(-12 + i * 8, 8, -11.2);
    g.add(r, s);
  }
  for (let i = 0; i < 3; i++) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(5, 32, 16), MAT.tank);
    s.position.set(-10 + i * 11, 5.5, 18);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.8, 1.2, 24), MAT.dark);
    leg.position.set(-10 + i * 11, 0.6, 18);
    g.add(s, leg);
  }
  for (let i = 0; i < 2; i++) {
    const c = new THREE.Mesh(new THREE.CapsuleGeometry(3.2, 10, 6, 24), MAT.tank);
    c.position.set(22, 8.2, -2 + i * 9);
    g.add(c);
  }
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 40), MAT.pvFrame);
  pipe.rotation.z = Math.PI / 2; pipe.position.set(4, 1.2, 12);
  g.add(pipe);
  g.userData.footprint = 30;
  return shadowed(g);
}

// ── ice mine: open pit + spoil heap (Arcadia's shallow ground ice) ──
export function iceMine() {
  const g = new THREE.Group();
  const rim = new THREE.Mesh(new THREE.TorusGeometry(24, 3, 12, 48), MAT.berm);
  rim.rotation.x = Math.PI / 2; rim.position.y = 0.6; rim.scale.z = 0.4;
  const floor = new THREE.Mesh(new THREE.CircleGeometry(22, 48), new THREE.MeshStandardMaterial({ color: 0xe8f0f3, roughness: 0.35 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = 0.25;
  const heap = new THREE.Mesh(new THREE.ConeGeometry(14, 7, 32), MAT.berm);
  heap.position.set(40, 3.5, 6);
  g.add(rim, floor, heap);
  g.userData.footprint = 30;
  return shadowed(g);
}

// ── rovers ────────────────────────────────────────────────────────
export function rover(pressurized: boolean) {
  const g = new THREE.Group();
  const L = pressurized ? 9 : 4.5, W = pressurized ? 3.6 : 2.4;
  const body = new THREE.Mesh(pressurized ? new THREE.CapsuleGeometry(1.5, L - 3, 6, 16) : new THREE.BoxGeometry(L, 0.6, W), MAT.white);
  if (pressurized) { body.rotation.z = Math.PI / 2; body.position.y = 2.3; body.scale.set(1, 1, W / 3); }
  else body.position.y = 1.2;
  g.add(body);
  if (pressurized) {
    const win = new THREE.Mesh(new THREE.SphereGeometry(1.3, 16, 8, 0, Math.PI), MAT.black);
    win.rotation.y = -Math.PI / 2; win.position.set(L / 2 - 0.8, 2.6, 0);
    g.add(win);
  } else {
    const pan = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.08, 2.0), MAT.pv);
    pan.position.set(-0.5, 1.9, 0);
    g.add(pan);
  }
  const wheel = new THREE.CylinderGeometry(0.55, 0.55, 0.45, 16);
  wheel.rotateX(Math.PI / 2);
  const n = pressurized ? 3 : 2;
  for (let i = 0; i < n; i++) for (const side of [-1, 1]) {
    const w = new THREE.Mesh(wheel, MAT.tyre);
    w.position.set((i / (n - 1) - 0.5) * (L - 1.6), 0.55, side * (W / 2 + 0.1));
    g.add(w);
  }
  g.userData.footprint = L * 0.6;
  return shadowed(g);
}

/** Unit block (1×1×1, base at 0) for instancing; scaled per building. */
export function blockUnit() {
  const g = new THREE.Group();
  const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), MAT.white);
  b.position.y = 0.5;
  const r = new THREE.Mesh(new THREE.BoxGeometry(0.94, 0.05, 0.94), MAT.roof);
  r.position.y = 1.02;
  g.add(b, r);
  return shadowed(g);
}

/** Low white work/hab blocks, the "town" grain between the big pieces. */
export function block(w: number, d: number, h: number) {
  const g = new THREE.Group();
  const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), MAT.white);
  b.position.y = h / 2;
  const r = new THREE.Mesh(new THREE.BoxGeometry(w * 0.96, 0.4, d * 0.96), MAT.roof);
  r.position.y = h + 0.2;
  g.add(b, r);
  if (w > 14) { const u = new THREE.Mesh(new THREE.BoxGeometry(3, 1.6, 3), MAT.white); u.position.set(w * 0.25, h + 1, 0); g.add(u); }
  g.userData.footprint = Math.max(w, d) * 0.6;
  return shadowed(g);
}

/** A road: grey surface with light edge lines, built from points already on the ground. */
export function road(points: THREE.Vector3[], width: number, up: (p: THREE.Vector3) => THREE.Vector3) {
  const curve = new THREE.CatmullRomCurve3(points);
  const N = Math.max(16, points.length * 24);
  const strip = (w0: number, w1: number) => {
    const pos: number[] = [], idx: number[] = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const p = curve.getPoint(t), d = curve.getTangent(t), n = up(p);
      const side = new THREE.Vector3().crossVectors(d, n).normalize();
      const a = p.clone().addScaledVector(side, w0), b = p.clone().addScaledVector(side, w1);
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      if (i < N) { const k = i * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx); g.computeVertexNormals();
    return g;
  };
  const grp = new THREE.Group();
  const surf = new THREE.Mesh(strip(-width / 2, width / 2), MAT.road);
  const e1 = new THREE.Mesh(strip(-width / 2, -width / 2 + width * 0.09), MAT.roadEdge);
  const e2 = new THREE.Mesh(strip(width / 2 - width * 0.09, width / 2), MAT.roadEdge);
  for (const m of [surf, e1, e2]) { m.receiveShadow = true; grp.add(m); }
  return grp;
}

// ── Optimus: instanced body parts, procedural walk cycle ──────────
// Tesla's published height: 5 ft 8 in (1.73 m).
export class OptimusCrowd {
  readonly group = new THREE.Group();
  private parts: { mesh: THREE.InstancedMesh; pivot: THREE.Vector3; local: THREE.Matrix4; swing: (ph: number) => number }[] = [];
  readonly max: number;
  private m = new THREE.Matrix4();

  constructor(max: number) {
    this.max = max;
    const h = 1.73;
    const torso = mergeGeometries([
      new THREE.CapsuleGeometry(0.17, 0.32, 4, 12),
      new THREE.BoxGeometry(0.42, 0.12, 0.22).translate(0, 0.2, 0),
    ])!;
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, pivot: THREE.Vector3, offset: THREE.Vector3, swing: (ph: number) => number) => {
      const mesh = new THREE.InstancedMesh(geo, mat, max);
      mesh.castShadow = true;
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.parts.push({ mesh, pivot, local: new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z), swing });
    };
    const hip = h * 0.53, shoulder = h * 0.8;
    add(torso, MAT.white, new THREE.Vector3(0, hip + 0.32, 0), new THREE.Vector3(), () => 0);
    add(new THREE.SphereGeometry(0.115, 16, 12).scale(1, 1.15, 1), MAT.black, new THREE.Vector3(0, shoulder + 0.18, 0), new THREE.Vector3(), () => 0);
    const thigh = new THREE.CapsuleGeometry(0.07, hip * 0.42, 4, 8);
    const shin = new THREE.CapsuleGeometry(0.06, hip * 0.42, 4, 8);
    const arm = new THREE.CapsuleGeometry(0.05, 0.5, 4, 8);
    for (const s of [-1, 1]) {
      add(thigh, MAT.black, new THREE.Vector3(s * 0.1, hip, 0), new THREE.Vector3(0, -hip * 0.26, 0), (ph) => Math.sin(ph + (s > 0 ? 0 : Math.PI)) * 0.45);
      add(shin, MAT.white, new THREE.Vector3(s * 0.1, hip * 0.5, 0), new THREE.Vector3(0, -hip * 0.24, 0), (ph) => Math.sin(ph + (s > 0 ? 0 : Math.PI)) * 0.45 - Math.max(0, Math.sin(ph + (s > 0 ? -0.9 : Math.PI - 0.9))) * 0.6);
      add(arm, MAT.white, new THREE.Vector3(s * 0.24, shoulder + 0.05, 0), new THREE.Vector3(0, -0.3, 0), (ph) => -Math.sin(ph + (s > 0 ? 0 : Math.PI)) * 0.35);
    }
  }

  /** Each agent: a base matrix (position, orientation, scale), gait phase and how much it walks. */
  update(agents: { base: THREE.Matrix4; phase: number; walking: number }[]) {
    const n = Math.min(this.max, agents.length);
    const qs = new THREE.Quaternion(), X = new THREE.Vector3(1, 0, 0);
    const piv = new THREE.Matrix4(), rot = new THREE.Matrix4(), base = new THREE.Matrix4(), bob = new THREE.Matrix4();
    for (const p of this.parts) p.mesh.count = n;
    for (let i = 0; i < n; i++) {
      const a = agents[i];
      base.copy(a.base).multiply(bob.makeTranslation(0, Math.abs(Math.sin(a.phase)) * 0.03 * a.walking, 0));
      for (const p of this.parts) {
        qs.setFromAxisAngle(X, p.swing(a.phase) * a.walking);
        piv.makeTranslation(p.pivot.x, p.pivot.y, p.pivot.z);
        rot.makeRotationFromQuaternion(qs);
        this.m.copy(base).multiply(piv).multiply(rot).multiply(p.local);
        p.mesh.setMatrixAt(i, this.m);
      }
    }
    for (const p of this.parts) p.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ── Moon pieces ──────────────────────────────────────────────────

/** Vertical solar array on a mast: at the lunar pole the Sun skims the horizon (NASA VSAT). */
export function solarTower() {
  const g = new THREE.Group();
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 32, 12), MAT.white);
  mast.position.y = 16;
  const panel = new THREE.Mesh(new THREE.BoxGeometry(7, 22, 0.25), MAT.pv);
  panel.position.set(0, 20, 0.6);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.8, 1.2, 16), MAT.white);
  base.position.y = 0.6;
  g.add(mast, panel, base);
  g.userData.footprint = 4;
  return shadowed(g);
}

/** Fission surface power unit with radiator fins (NASA FSP, ~40 kWe class). */
export function reactor() {
  const g = new THREE.Group();
  const core = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.6, 6, 24), MAT.white);
  core.position.y = 3;
  const cap = new THREE.Mesh(new THREE.ConeGeometry(2.2, 2, 24), MAT.roof);
  cap.position.y = 7;
  g.add(core, cap);
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(10, 5, 0.2), MAT.white);
    const a = (i / 4) * Math.PI * 2;
    fin.position.set(Math.cos(a) * 7, 4, Math.sin(a) * 7); fin.rotation.y = -a;
    g.add(fin);
  }
  g.userData.footprint = 12;
  return shadowed(g);
}

/** Electromagnetic mass driver: a long rail on piers, rising toward one end. */
export function massDriver(length = 420) {
  const g = new THREE.Group();
  const rail = new THREE.Mesh(new THREE.BoxGeometry(length, 2, 5), MAT.white);
  const slope = 0.035;
  rail.position.set(length / 2, 4 + (length / 2) * slope, 0);
  rail.rotation.z = slope;
  g.add(rail);
  for (let i = 0; i <= 18; i++) {
    const x = (i / 18) * length, h = 4 + x * slope;
    const pier = new THREE.Mesh(new THREE.BoxGeometry(1.6, h, 1.6), MAT.roof);
    pier.position.set(x, h / 2, 0);
    g.add(pier);
  }
  const hall = new THREE.Mesh(new THREE.BoxGeometry(40, 9, 22), MAT.white);
  hall.position.set(-20, 4.5, 0);
  g.add(hall);
  g.userData.footprint = 0;
  return shadowed(g);
}

/** One street segment (one grid cell long): compacted, dust-toned, reads quietly from the air. */
const STREET = new THREE.MeshStandardMaterial({ color: 0xc8b6a6, metalness: 0, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
export function street() {
  const g = new THREE.Group();
  const s = new THREE.Mesh(new THREE.BoxGeometry(1, 0.2, 9), STREET);
  s.position.y = 0.1;
  s.receiveShadow = true;
  g.add(s);
  return g;
}

/** Lunar Starship: no flaps, no heat shield (it never re-enters), white all over. */
export function toHLS(ship: THREE.Object3D) {
  const s = ship.clone();
  const white = new THREE.MeshStandardMaterial({ color: 0xeeeeea, metalness: 0.2, roughness: 0.55 });
  s.traverse((o) => {
    if (o.name.startsWith("flap_")) o.visible = false;
    const m = o as THREE.Mesh;
    if (m.isMesh && m.name === "heatshield") m.material = white;
  });
  return s;
}

/**
 * GRU Space's lunar hotel, modelled from the company's launch film (gru.space, 2026).
 * Stage 1 (2030–32, "Habitat Established"): a dark gored inflatable dome marked "GRU", inside a
 * ring of stacked regolith bricks. Stage 2 ("Hotel on the Moon"): a symmetric regolith-stone
 * palace — central domed rotunda with portico and flags, colonnaded wings with arched lit
 * windows, domed end pavilions, two rotundas behind. GRU gives no dimensions; ours are judged
 * from the film (the rotunda ~18 m across).
 */
const STONE = new THREE.MeshStandardMaterial({ color: 0x8e8a84, metalness: 0, roughness: 0.95 });
const STONE_D = new THREE.MeshStandardMaterial({ color: 0x77736e, metalness: 0, roughness: 0.95 });
const LIT = new THREE.MeshStandardMaterial({ color: 0xfff3dc, emissive: 0xffe9c4, emissiveIntensity: 1.25, roughness: 0.6 });
const GLOW = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2d8, emissiveIntensity: 1.6, roughness: 0.5 });
const DOOR = new THREE.MeshStandardMaterial({ color: 0x2a2724, roughness: 0.8 });

function archShape(w: number, h: number) {
  const s = new THREE.Shape();
  const r = w / 2;
  s.moveTo(-r, 0); s.lineTo(r, 0); s.lineTo(r, h - r);
  s.absarc(0, h - r, r, 0, Math.PI, false);
  s.lineTo(-r, 0);
  return new THREE.ShapeGeometry(s, 10);
}

/** Merge a list of (geometry, matrix) into one geometry. */
function bake(parts: [THREE.BufferGeometry, THREE.Matrix4][]) {
  const gs = parts.map(([g, m]) => { const c = g.index ? g.toNonIndexed() : g.clone(); c.applyMatrix4(m); c.deleteAttribute("uv"); return c; });
  return mergeGeometries(gs)!;
}
const M = (x: number, y: number, z: number, ry = 0, sx = 1, sy = 1, sz = 1) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)), new THREE.Vector3(sx, sy, sz));

function hotelDome() {
  const g = new THREE.Group();
  const R = 7;
  // gored inflatable: 10 bulging panels
  const shell = new THREE.SphereGeometry(R, 60, 24, 0, Math.PI * 2, 0, Math.PI / 2);
  const p = shell.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const a = Math.atan2(z, x), k = 1 + 0.035 * Math.abs(Math.sin(a * 5));
    p.setXYZ(i, x * k, y * 0.82, z * k);
  }
  shell.computeVertexNormals();
  const dark = new THREE.MeshStandardMaterial({ color: 0x1c1c1e, metalness: 0.15, roughness: 0.55 });
  g.add(new THREE.Mesh(shell, dark));
  // "GRU" stencil on the front panel
  const c = document.createElement("canvas"); c.width = 256; c.height = 96;
  const x = c.getContext("2d")!;
  x.fillStyle = "rgba(0,0,0,0)"; x.fillRect(0, 0, 256, 96);
  x.font = "700 72px Helvetica, Arial, sans-serif"; x.fillStyle = "#e9e6e0"; x.textAlign = "center"; x.textBaseline = "middle";
  x.fillText("GRU", 128, 52);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const labelMat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.7, depthWrite: false });
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const label = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 1.6), labelMat);
    label.position.set(Math.sin(a) * R * 0.96, 2.4, Math.cos(a) * R * 0.96);
    label.rotation.set(0, a, 0); label.rotateX(-0.34);
    g.add(label);
  }
  // gore seams: the welded/stitched lines between inflatable panels
  const seams: [THREE.BufferGeometry, THREE.Matrix4][] = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + Math.PI / 10;
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= 16; k++) { const t = (k / 16) * (Math.PI / 2); pts.push(new THREE.Vector3(Math.cos(a) * Math.cos(t) * R * 1.002, Math.sin(t) * R * 0.82, Math.sin(a) * Math.cos(t) * R * 1.002)); }
    seams.push([new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.07, 5), new THREE.Matrix4()]);
  }
  g.add(new THREE.Mesh(bake(seams), new THREE.MeshStandardMaterial({ color: 0x3a3a3d, roughness: 0.6 })));
  // ring of stacked regolith bricks, open at the front, the top course unfinished
  const brick = new THREE.BoxGeometry(1.1, 0.5, 0.6);
  const parts: [THREE.BufferGeometry, THREE.Matrix4][] = [];
  const ringR = R + 2.4;
  for (let course = 0; course < 5; course++) {
    const n = 52, off = course % 2 ? 0.5 : 0;
    for (let i = 0; i < n; i++) {
      const a = ((i + off) / n) * Math.PI * 2;
      if (Math.abs(Math.atan2(Math.sin(a - Math.PI / 2), Math.cos(a - Math.PI / 2))) < 0.32) continue; // doorway (front, +z)
      if (course === 4 && Math.sin(a * 3 + 1) < 0.1) continue;                                     // still being laid
      parts.push([brick, M(Math.cos(a) * ringR, 0.25 + course * 0.52, Math.sin(a) * ringR, -a + Math.PI / 2)]);
    }
  }
  const wall = new THREE.Mesh(bake(parts), new THREE.MeshStandardMaterial({ color: 0x9a948d, roughness: 1 }));
  g.add(wall);
  g.userData.footprint = ringR + 1;
  return shadowed(g);
}

function rotunda(r: number, h: number, rows: number, sides = 20) {
  const g = new THREE.Group();
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.02, h, sides), STONE);
  drum.position.y = h / 2;
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.06, r * 1.08, 0.8, sides), STONE_D);
  plinth.position.y = 0.4;
  const cornice = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.07, r * 1.07, 0.7, sides), STONE_D);
  cornice.position.y = h + 0.35;
  const glow = new THREE.Mesh(new THREE.TorusGeometry(r * 1.02, 0.12, 6, 48), GLOW);
  glow.rotation.x = Math.PI / 2; glow.position.y = h + 0.8;
  const step = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.96, r * 1.0, 0.9, sides), STONE);
  step.position.y = h + 1.15;
  const cap = new THREE.Mesh(new THREE.SphereGeometry(r * 0.94, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), STONE);
  cap.scale.y = 0.32; cap.position.y = h + 1.6;
  const lantern = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.22, r * 0.25, 0.8, 16), STONE_D);
  lantern.position.y = h + 1.6 + r * 0.3;
  g.add(drum, plinth, cornice, glow, step, cap, lantern);
  // pilasters + arched windows all the way round
  const pil: [THREE.BufferGeometry, THREE.Matrix4][] = [];
  const win: [THREE.BufferGeometry, THREE.Matrix4][] = [];
  const pg = new THREE.BoxGeometry(0.5, h - 1.2, 0.35);
  const wg = archShape(1.15, h / rows - 1.6);
  const n = 10;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pil.push([pg, M(Math.cos(a) * r, h / 2 + 0.2, Math.sin(a) * r, -a)]);
    const aw = a + Math.PI / n;
    for (let k = 0; k < rows; k++) win.push([wg, M(Math.cos(aw) * (r + 0.03), 1.4 + k * (h / rows), Math.sin(aw) * (r + 0.03), -aw + Math.PI / 2)]);
  }
  g.add(new THREE.Mesh(bake(pil), STONE_D), new THREE.Mesh(bake(win), LIT));
  return g;
}

function wing(len: number, depth: number, h: number) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(len, h, depth), STONE);
  body.position.y = h / 2;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(len + 0.6, 0.8, depth + 0.6), STONE_D);
  roof.position.y = h + 0.4;
  const edge = new THREE.Mesh(new THREE.BoxGeometry(len + 0.7, 0.14, 0.14), GLOW);
  edge.position.set(0, h + 0.9, depth / 2 + 0.3);
  g.add(body, roof, edge);
  const cols: [THREE.BufferGeometry, THREE.Matrix4][] = [];
  const win: [THREE.BufferGeometry, THREE.Matrix4][] = [];
  const cg = new THREE.CylinderGeometry(0.32, 0.36, h - 1, 10);
  const wg = archShape(1.3, h - 3.4);
  const bays = Math.max(3, Math.round(len / 3.4));
  for (let i = 0; i <= bays; i++) {
    const x = -len / 2 + (i / bays) * len;
    cols.push([cg, M(x, (h - 1) / 2 + 0.2, depth / 2 + 0.55)]);
    if (i < bays) {
      const xm = x + len / bays / 2;
      win.push([wg, M(xm, 1.4, depth / 2 + 0.02)]);
      win.push([wg, M(xm, 1.4, -depth / 2 - 0.02, Math.PI)]);
    }
  }
  g.add(new THREE.Mesh(bake(cols), STONE_D), new THREE.Mesh(bake(win), LIT));
  return g;
}

function flag(x: number, z: number) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 4.6, 6), MAT.white);
  pole.position.set(x, 2.3, z);
  const c = document.createElement("canvas"); c.width = 76; c.height = 40;
  const t = c.getContext("2d")!;
  for (let i = 0; i < 13; i++) { t.fillStyle = i % 2 ? "#ffffff" : "#b22234"; t.fillRect(0, i * (40 / 13), 76, 40 / 13 + 0.5); }
  t.fillStyle = "#3c3b6e"; t.fillRect(0, 0, 30, 21.5);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const cloth = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.8), new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.8 }));
  cloth.position.set(x + 0.78, 4.1, z); // held out by a top rod, as on the Moon
  g.add(pole, cloth);
  return g;
}

function hotelPalace() {
  const g = new THREE.Group();
  const center = rotunda(9, 12, 2, 24);
  g.add(center);
  // portico on the front of the rotunda
  const portico = new THREE.Mesh(new THREE.BoxGeometry(8, 8.5, 4), STONE);
  portico.position.set(0, 4.25, 9.6);
  const pcap = new THREE.Mesh(new THREE.BoxGeometry(8.8, 0.9, 4.8), STONE_D);
  pcap.position.set(0, 8.9, 9.6);
  const door = new THREE.Mesh(archShape(2.2, 4.2), DOOR);
  door.position.set(0, 0.8, 11.62);
  g.add(portico, pcap, door, flag(-2.8, 12), flag(2.2, 12));
  // wings and end pavilions, symmetric
  for (const sgn of [-1, 1]) {
    const w = wing(18, 8, 8);
    w.position.set(sgn * (9 + 9), 0, 1.5);
    const endR = rotunda(5.6, 10, 2, 18);
    endR.position.set(sgn * (9 + 18 + 4.2), 0, 1.5);
    const back = rotunda(4.4, 9, 1, 16);
    back.position.set(sgn * 11.5, 0, -7.5);
    const annex = wing(6, 6, 6);
    annex.position.set(sgn * (9 + 18 + 10.5), 0, 1.5);
    g.add(w, endR, back, annex);
  }
  g.userData.footprint = 40;
  return shadowed(g);
}

/**
 * The hotel item: shows the inflatable stage from its opening year and grows into the regolith
 * palace later (GRU's film shows the palace after 2032 without a date; see plans.ts).
 */
export function moonHotel(palaceYear: number) {
  const g = new THREE.Group();
  const domeStage = hotelDome();
  const palace = hotelPalace();
  domeStage.scale.setScalar(1.6);   // drawn ~1.6× like the other showpieces so it reads from the air
  palace.scale.setScalar(1.1);
  palace.visible = false;
  g.add(domeStage, palace);
  let k = 0;
  g.userData.onYear = (y: number, dt: number) => {
    const target = y >= palaceYear ? 1 : 0;
    k += (target - k) * (1 - Math.exp(-dt / 0.35));
    palace.visible = k > 0.01;
    domeStage.visible = k < 0.99;
    palace.scale.set(1.1, 1.1 * Math.max(0.001, k), 1.1);
    domeStage.scale.setScalar(1.6 * (1 - k * 0.9));
  };
  g.userData.footprint = 44;
  return g;
}
