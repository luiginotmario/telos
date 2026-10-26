import * as THREE from "three";

/**
 * Earth's atmosphere seen from orbit: a thin shell (~80 km) whose glow grows with the length of
 * the sight line through it, so it is faint looking down and a bright band along the horizon.
 * Blue where the Sun is high, warming to orange across the terminator, nothing on the night side.
 * Only drawn in the ISS close-up (from afar the globe's own limb shader does this job).
 */
export class Limb {
  readonly mesh: THREE.Mesh;
  readonly u = { uSun: { value: new THREE.Vector3(1, 0, 0) }, uCam: { value: new THREE.Vector3() }, uA: { value: 0 } };

  constructor(parent: THREE.Object3D) {
    const R = 1 + 80 / 6371;
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(R, 256, 128), new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: /* glsl */ `
        varying vec3 vW; varying vec3 vN;
        void main(){
          vec4 w = modelMatrix * vec4(position, 1.0);
          vW = w.xyz; vN = normalize(mat3(modelMatrix) * position);
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vW; varying vec3 vN;
        uniform vec3 uSun; uniform vec3 uCam; uniform float uA;
        void main(){
          vec3 V = normalize(uCam - vW);
          float mu = abs(dot(vN, V));
          // path length through a thin shell ~ 1/mu, capped where the line grazes
          float path = min(1.0 / max(mu, 0.035), 22.0);
          float day = dot(vN, uSun);
          float lit = smoothstep(-0.18, 0.12, day);
          // Rayleigh blue overhead, reddened toward the terminator (longer path through air)
          vec3 sky = mix(vec3(1.0, 0.45, 0.18), vec3(0.32, 0.58, 1.0), smoothstep(-0.05, 0.35, day));
          // squared: looking down stays clear, only grazing lines along the horizon light up
          float glow = (1.0 - exp(-path * path * 0.0016)) * lit;
          float a = glow * uA;
          gl_FragColor = vec4(sky * a * 1.6, a);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.mesh.renderOrder = 6;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    parent.add(this.mesh);
  }

  update(sunWorld: THREE.Vector3, cam: THREE.Camera, amount: number) {
    this.u.uSun.value.copy(sunWorld).normalize();
    this.u.uCam.value.setFromMatrixPosition(cam.matrixWorld);
    this.u.uA.value = amount;
    this.mesh.visible = amount > 0.01;
  }
}
