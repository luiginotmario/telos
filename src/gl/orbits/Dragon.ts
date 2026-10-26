import * as THREE from "three";

/**
 * Crew / Cargo Dragon at true size, built along +X from the docking interface (x = 0):
 * nose docking ring, the capsule's 15° sidewall to a 3.7 m heat-shield base, then the trunk
 * (solar cells on one half, radiator on the other, four aft fins). Total ≈ 8.1 m × 4 m (SpaceX).
 *
 * `deorbit` builds the US Deorbit Vehicle the way NASA describes it: a Dragon with an enlarged
 * propulsive trunk. Its exact shape is unpublished, so its trunk here is illustrative.
 */
export type DragonKind = "crew" | "cargo" | "deorbit";

const white = new THREE.MeshPhysicalMaterial({ color: 0xf1f1ee, roughness: 0.42, metalness: 0.0, clearcoat: 0.35, clearcoatRoughness: 0.35 });
const black = new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.55, metalness: 0.2 });
const metal = new THREE.MeshStandardMaterial({ color: 0x9a9da3, roughness: 0.35, metalness: 0.9 });
const cells = new THREE.MeshPhysicalMaterial({ color: 0x101a33, roughness: 0.22, metalness: 0.4, clearcoat: 1, clearcoatRoughness: 0.08 });
const radiator = new THREE.MeshStandardMaterial({ color: 0xe9e9e4, roughness: 0.75, metalness: 0.0 });
const glass = new THREE.MeshPhysicalMaterial({ color: 0x0a0d12, roughness: 0.05, metalness: 0.0, clearcoat: 1 });

/** Lathe a profile given as [x along axis, radius] pairs into a mesh around +X. */
function lathe(profile: [number, number][], mat: THREE.Material, seg = 64, phiStart = 0, phiLen = Math.PI * 2) {
  const g = new THREE.LatheGeometry(profile.map(([x, r]) => new THREE.Vector2(r, x)), seg, phiStart, phiLen);
  g.rotateZ(-Math.PI / 2);          // lathe axis Y -> +X
  const m = new THREE.Mesh(g, mat);
  m.castShadow = m.receiveShadow = true;
  return m;
}

export function buildDragon(kind: DragonKind) {
  const g = new THREE.Group();
  g.name = `dragon-${kind}`;
  // docking adapter + nose
  g.add(lathe([[0, 0.62], [0.12, 0.66], [0.32, 0.72], [0.36, 0.8]], metal, 48));
  // capsule: 15° sidewall from ~1.6 m to 3.7 m diameter, then the heat-shield shoulder
  const capsule = lathe([[0.32, 0.82], [0.55, 0.9], [2.95, 1.78], [3.2, 1.86], [3.38, 1.85], [3.48, 1.7]], white);
  g.add(capsule);
  // the hinged nose cone, opened sideways off the docking axis
  const cone = lathe([[0, 0], [0.18, 0.55], [0.42, 0.78], [0.5, 0.8]], white, 40);
  cone.position.set(0.5, 1.0, 0);
  cone.rotation.z = THREE.MathUtils.degToRad(105);
  g.add(cone);
  if (kind === "crew" || kind === "deorbit") {
    // four SuperDraco pods (dark) around the sidewall, and the crew windows
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      const pod = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.18, 0.5), black);
      pod.position.set(2.2, Math.cos(a) * 1.5, Math.sin(a) * 1.5);
      pod.lookAt(new THREE.Vector3(2.2, Math.cos(a) * 3, Math.sin(a) * 3));
      pod.castShadow = true;
      g.add(pod);
    }
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2;
      const win = new THREE.Mesh(new THREE.CircleGeometry(0.17, 24), glass);
      const r = 1.33;
      win.position.set(1.75, Math.cos(a) * r, Math.sin(a) * r);
      win.lookAt(new THREE.Vector3(1.4, Math.cos(a) * r * 2, Math.sin(a) * r * 2));
      g.add(win);
    }
  }
  // trunk: half solar cells, half radiator; the deorbit vehicle's is far longer
  const trunkLen = kind === "deorbit" ? 7.6 : 3.6;
  const r = 1.83;
  const t0 = 3.48;
  const cellHalf = new THREE.Mesh(new THREE.CylinderGeometry(r, r, trunkLen, 48, 1, true, 0, Math.PI), cells);
  const radHalf = new THREE.Mesh(new THREE.CylinderGeometry(r, r, trunkLen, 48, 1, true, Math.PI, Math.PI), radiator);
  for (const m of [cellHalf, radHalf]) {
    m.geometry.rotateZ(-Math.PI / 2);
    m.position.x = t0 + trunkLen / 2;
    m.castShadow = m.receiveShadow = true;
    g.add(m);
  }
  const aft = new THREE.Mesh(new THREE.CircleGeometry(r, 48), black);
  aft.rotation.y = Math.PI / 2; aft.position.x = t0 + trunkLen;
  g.add(aft);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    const fin = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.06, 0.55), white);
    fin.position.set(t0 + trunkLen - 0.6, Math.cos(a) * (r + 0.25), Math.sin(a) * (r + 0.25));
    fin.rotation.x = -a;
    fin.castShadow = true;
    g.add(fin);
  }
  if (kind === "deorbit") {
    // thruster quads ringing the enlarged trunk (NASA: many Draco thrusters for the final burn)
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const q = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.35), metal);
      q.position.set(t0 + trunkLen - 0.2, Math.cos(a) * (r + 0.12), Math.sin(a) * (r + 0.12));
      g.add(q);
    }
  }
  g.userData.length = t0 + trunkLen;
  return g;
}
