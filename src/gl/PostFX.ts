import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { TexturePass } from "three/examples/jsm/postprocessing/TexturePass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

/**
 * The camera at the end of every frame. Each view renders true linear light (values above 1
 * where something is brighter than white: the Sun, sunlit ice and arrays, city lights) into a
 * half-float buffer; here it blooms the way a lens does and is tone-mapped with AgX (the
 * film-like curve Blender uses) before the sRGB encode. One look for the whole site.
 */
export class PostFX {
  /** views render into this */
  readonly hdr: THREE.WebGLRenderTarget;
  private composer: EffectComposer;
  private input: TexturePass;
  readonly bloom: UnrealBloomPass;

  constructor(private r: THREE.WebGLRenderer) {
    this.hdr = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    r.toneMapping = THREE.AgXToneMapping;
    r.toneMappingExposure = 1.0;
    this.composer = new EffectComposer(r, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }));
    this.input = new TexturePass(this.hdr.texture);
    this.composer.addPass(this.input);
    // only light brighter than white blooms; soft and wide, like scatter in a lens
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.32, 0.5, 1.0);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  setSize(w: number, h: number, pr: number) {
    this.hdr.setSize(Math.round(w * pr), Math.round(h * pr));
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    // bloom works at a fraction of the resolution anyway; keep it cheap on big screens
    this.bloom.setSize(Math.round(w * Math.min(pr, 1.5)), Math.round(h * Math.min(pr, 1.5)));
  }

  /** Point the next render at the HDR buffer. */
  begin() { this.r.setRenderTarget(this.hdr); }

  /** Bloom, tone-map and put on screen (from the HDR buffer, or another linear texture). */
  present(input: THREE.Texture = this.hdr.texture, exposure = 1) {
    this.input.map = input;
    this.r.toneMappingExposure = exposure;
    this.composer.render();
  }
}
