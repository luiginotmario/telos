import * as THREE from "three";
import { latLonToDir } from "../Globe";

/**
 * A launch, start to orbit, on the globe: the ascent climbs from the real pad along the launch
 * azimuth that its inclination requires (sin az = cos i / cos lat), bends over into orbit, and
 * then (for Starlink) releases its stack, which drifts apart into the "string of pearls".
 * Time is compressed; the readout says by how much. Positions are in the Earth-fixed globe frame.
 */
export interface LaunchCfg {
  id: string; vehicle: string; pad: string;
  utc: string;            // lift-off
  lat: number; lon: number; incDeg: number; altKm: number;
  insertMin: number;      // minutes from lift-off to orbit
  downrangeKm: number;    // distance flown over the ground by insertion
  deploy: number;         // satellites released (1 = the payload itself)
  deployMin: number;      // minutes after lift-off
}

export const LAUNCHES: Record<string, LaunchCfg> = {
  // R-7 8K71PS from Baikonur Site 1; 65.1°, 215 × 939 km (mean ~577 km) — NASA NSSDCA 1957-001B
  sputnik: { id: "sputnik", vehicle: "R-7 · Sputnik 1", pad: "Baikonur, Site 1", utc: "1957-10-04T19:28:34Z", lat: 45.92, lon: 63.342, incDeg: 65.1, altKm: 577,
    insertMin: 5.2, downrangeKm: 1200, deploy: 1, deployMin: 5.3 },
  // Falcon 9 from SLC-40, 60 Starlink v0.9 released at ~440 km, 53° — SpaceX press kit, 24 May 2019
  starlink: { id: "starlink", vehicle: "Falcon 9 · Starlink v0.9", pad: "Cape Canaveral, SLC-40", utc: "2019-05-24T02:30:00Z", lat: 28.5618, lon: -80.5772, incDeg: 53, altKm: 440,
    insertMin: 8.8, downrangeKm: 1950, deploy: 60, deployMin: 62 },
};

const OMEGA_E = 7.2921159e-5;        // rad/s

export class Launch {
  readonly group = new THREE.Group();
  private trail: THREE.Line;
  private trailPos: Float32Array;
  private head: THREE.Points;
  private sats: THREE.Points;
  private satPos: Float32Array;
  private cfg: LaunchCfg | null = null;
  private t = 0;                       // simulated seconds since lift-off
  private u = { uScale: { value: 1 }, uA: { value: 0 } };
  /** readout for the caption: "T+ 04:12 · 128 km up" */
  status = "";

  constructor(parent: THREE.Object3D) {
    parent.add(this.group);
    this.group.visible = false;
    this.trailPos = new Float32Array(160 * 3);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute("position", new THREE.BufferAttribute(this.trailPos, 3));
    const fade = new Float32Array(160).map((_, i) => i / 159);
    tg.setAttribute("aF", new THREE.BufferAttribute(fade, 1));
    this.trail = new THREE.Line(tg, new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: `attribute float aF; varying float vF; void main(){ vF = aF; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying float vF; uniform float uA; void main(){ float a = pow(vF, 1.6) * uA; gl_FragColor = vec4(pow(vec3(1.0, 0.82, 0.55), vec3(2.2)) * a * 2.2, a); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.trail.frustumCulled = false;
    const dot = (size: number, col: string) => new THREE.ShaderMaterial({
      uniforms: { ...this.u, uSize: { value: size } },
      vertexShader: `uniform float uScale; uniform float uSize; void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_PointSize = uSize * uScale; }`,
      fragmentShader: `uniform float uA; void main(){ float d = length(gl_PointCoord*2.0-1.0); float a = smoothstep(1.0, 0.0, d) * uA; gl_FragColor = vec4(pow(${col}, vec3(2.2)) * a * 2.5, a); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const hg = new THREE.BufferGeometry();
    hg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
    this.head = new THREE.Points(hg, dot(9, "vec3(1.0, 0.86, 0.6)"));
    this.head.frustumCulled = false;
    this.satPos = new Float32Array(60 * 3);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.BufferAttribute(this.satPos, 3));
    this.sats = new THREE.Points(sg, dot(3.2, "vec3(0.86, 0.93, 1.0)"));
    this.sats.frustumCulled = false;
    this.group.add(this.trail, this.head, this.sats);
    this.group.renderOrder = 7;
  }

  /** Where the flight is now (globe frame), for the camera to follow. */
  readonly headPos = new THREE.Vector3();

  play(id: string) {
    this.cfg = LAUNCHES[id] ?? null;
    this.t = 0;
  }
  stop() { this.cfg = null; }
  /** past orbit insertion */
  /** The moment being shown (lift-off + flight time), for lighting the Earth as it was. */
  get nowMs() { return this.cfg ? Date.parse(this.cfg.utc) + this.t * 1000 : null; }
  get inOrbit() { return !!this.cfg && this.t >= this.cfg.insertMin * 60; }
  get playing() { return !!this.cfg; }

  /** Position (globe frame, Earth radii) after `s` seconds of flight. */
  private at(s: number, out: THREE.Vector3) {
    const c = this.cfg!;
    const lat = THREE.MathUtils.degToRad(c.lat);
    // azimuth for this inclination (north-east launch)
    const az = Math.asin(Math.min(1, Math.cos(THREE.MathUtils.degToRad(c.incDeg)) / Math.cos(lat)));
    const pad = latLonToDir(c.lat, c.lon);
    const north = new THREE.Vector3(0, 1, 0).addScaledVector(pad, -pad.y).normalize();
    const east = new THREE.Vector3().crossVectors(north, pad).normalize();
    const dir0 = north.clone().multiplyScalar(Math.cos(az)).addScaledVector(east, Math.sin(az)).normalize();
    const axis = new THREE.Vector3().crossVectors(pad, dir0).normalize();     // great circle of the ground track
    const T = c.insertMin * 60;
    let ang: number, h: number;
    if (s <= T) {
      const k = s / T;
      // pitch-over: altitude rises early, downrange accelerates late (a gravity turn's shape)
      ang = (c.downrangeKm / 6371) * k * k * (0.6 + 0.4 * k);
      h = c.altKm * (1 - Math.pow(1 - k, 2.2));
    } else {
      // in orbit: circular at altKm in the inertial plane, the Earth turning underneath
      const r = 6371 + c.altKm;
      const w = Math.sqrt(398600.4418 / (r * r * r));
      ang = c.downrangeKm / 6371 + w * (s - T);
      h = c.altKm;
    }
    out.copy(pad).applyAxisAngle(axis, ang).multiplyScalar(1 + h / 6371);
    // the ground turns east beneath the flight
    return out.applyAxisAngle(new THREE.Vector3(0, 1, 0), -OMEGA_E * s);
  }

  update(dt: number, fade: number) {
    const c = this.cfg;
    this.group.visible = !!c && fade > 0.01;
    this.u.uA.value = fade;
    this.u.uScale.value = Math.min(devicePixelRatio, 2);
    if (!c) { this.status = ""; return; }
    // compressed time: the ascent in ~7 s, the coast to deployment quickly, then the train drifts
    const T = c.insertMin * 60, D = c.deployMin * 60;
    const rate = this.t < T ? T / 7 : this.t < D ? (D - T) / 4 : 240;
    this.t += dt * rate;
    const v = new THREE.Vector3();
    // trail: the last stretch of the flight path
    const span = Math.min(this.t, T * 0.9);
    for (let i = 0; i < 160; i++) {
      this.at(Math.max(0, this.t - span * (1 - i / 159)), v);
      this.trailPos.set([v.x, v.y, v.z], i * 3);
    }
    this.trail.geometry.attributes.position.needsUpdate = true;
    this.at(this.t, v);
    this.headPos.copy(v);
    (this.head.geometry.attributes.position as THREE.BufferAttribute).setXYZ(0, v.x, v.y, v.z);
    this.head.geometry.attributes.position.needsUpdate = true;
    // deployment: the stack lets go, and small differences in speed spread it along the orbit
    const deployed = this.t >= D;
    this.head.visible = !deployed || c.deploy === 1;
    let n = 0;
    if (deployed && c.deploy > 1) {
      const since = this.t - D;
      for (let k = 0; k < c.deploy; k++) {
        this.at(this.t - (k - c.deploy / 2) * since * 0.0016, v);
        this.satPos.set([v.x, v.y, v.z], k * 3);
        n++;
      }
    }
    this.sats.geometry.setDrawRange(0, n);
    this.sats.geometry.attributes.position.needsUpdate = true;
    const mm = Math.floor(this.t / 60), ss = Math.floor(this.t % 60);
    const tt = `T+ ${mm >= 60 ? `${Math.floor(mm / 60)}:${String(mm % 60).padStart(2, "0")}` : String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
    const alt = Math.round(this.t < T ? c.altKm * (1 - Math.pow(1 - this.t / T, 2.2)) : c.altKm);
    this.status = `${c.vehicle} · ${tt} · ${alt} km up · ${this.t < T ? "ascent" : !deployed ? "coasting" : c.deploy > 1 ? `${c.deploy} satellites released` : "in orbit"} · time ×${Math.round(rate)}`;
  }
}
