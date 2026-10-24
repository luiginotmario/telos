declare module "n8ao" {
  import type { Camera, Color, Scene } from "three";
  import { Pass } from "three/examples/jsm/postprocessing/Pass.js";
  export class N8AOPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number);
    configuration: {
      aoRadius: number; distanceFalloff: number; intensity: number; screenSpaceRadius: boolean;
      halfRes: boolean; gammaCorrection: boolean; aoSamples: number; denoiseSamples: number; denoiseRadius: number;
      color: Color; [k: string]: unknown;
    };
    setSize(w: number, h: number): void;
  }
}
