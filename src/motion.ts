// House motion tokens (handcrafted-motion skill) as JS.
export const expoOut = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
export const quintOut = (t: number) => 1 - Math.pow(1 - t, 5);
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** First-order follow with time constant tau (s): frame-rate independent. */
export const follow = (cur: number, target: number, dt: number, tau: number) => cur + (target - cur) * (1 - Math.exp(-dt / tau));

export interface SpringCfg { stiffness: number; damping: number; mass?: number }
export const SPRING_RELEASE: SpringCfg = { stiffness: 324, damping: 37.5, mass: 1 };
export const SPRING_FOLLOW: SpringCfg = { stiffness: 850, damping: 65, mass: 0.2 };
/** Motion's { duration, bounce } → physical spring. */
export const springFrom = (duration: number, bounce: number): SpringCfg => {
  const k = Math.pow((2 * Math.PI) / duration, 2);
  return { stiffness: k, damping: 2 * (1 - bounce) * Math.sqrt(k), mass: 1 };
};
export const SPRING_REBOUND = springFrom(0.7, 0.55);

export class Spring {
  x: number; v = 0; target: number;
  constructor(x: number, public cfg: SpringCfg = SPRING_RELEASE) { this.x = x; this.target = x; }
  step(dt: number) {
    const m = this.cfg.mass ?? 1;
    // semi-implicit Euler in fixed sub-steps for stability
    let rem = Math.min(dt, 0.04);
    while (rem > 0) {
      const h = Math.min(rem, 1 / 240);
      const a = (-this.cfg.stiffness * (this.x - this.target) - this.cfg.damping * this.v) / m;
      this.v += a * h; this.x += this.v * h; rem -= h;
    }
    return this.x;
  }
  get settled() { return Math.abs(this.x - this.target) < 1e-4 && Math.abs(this.v) < 1e-3; }
  snap(x: number) { this.x = this.target = x; this.v = 0; }
}

/** Duration-based tween that can be retargeted mid-flight. */
export class Tween {
  from = 0; to = 0; t0 = 0; dur = 0; active = false;
  constructor(public ease = expoOut) {}
  start(from: number, to: number, dur: number, now: number) { this.from = from; this.to = to; this.t0 = now; this.dur = dur; this.active = true; }
  value(now: number) {
    if (!this.active) return this.to;
    const k = this.dur <= 0 ? 1 : clamp((now - this.t0) / this.dur, 0, 1);
    if (k >= 1) this.active = false;
    return lerp(this.from, this.to, this.ease(k));
  }
}

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
