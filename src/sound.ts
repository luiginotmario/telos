/**
 * UI sound + planet ambience, plain Web Audio.
 * Tick voice re-implemented from parameters measured on untitled.lorenzodossi.com
 * (research/LORENZO.md): triangle D4, 34 ms, 1.5 ms attack / 36 ms decay, filter sweep from
 * 690 Hz up 1.25 octaves, −23.8 dB, a −46.8 dB sine accent 5 ms later, 28 ms cooldown,
 * ±3 cents / ±0.6 dB jitter, small room send, master 0.35. Reduced motion halves volume and
 * doubles cooldowns.
 */

const KEY = "telos:sound";
const db = (d: number) => Math.pow(10, d / 20);

export class Sound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private bus!: AudioNode;
  private verbSend!: GainNode;
  private ambient!: GainNode;
  private last = new Map<string, number>();
  private reduce = matchMedia("(prefers-reduced-motion: reduce)");
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private current: { id: string; src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private wantAmbient: string | null = null;
  enabled: boolean;

  constructor() {
    let v: string | null = null;
    try { v = localStorage.getItem(KEY); } catch { /* private mode */ }
    this.enabled = v !== "off";
    const unlock = () => { this.ensure(); };
    addEventListener("pointerdown", unlock, { capture: true });
    addEventListener("keydown", unlock, { capture: true });
  }

  private ensure(): AudioContext | null {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return this.ctx;
    }
    if (!(navigator as any).userActivation?.isActive && (navigator as any).userActivation) return null;
    const ctx = new AudioContext({ latencyHint: "interactive" });
    this.ctx = ctx;
    // master chain: HP 110 → LP 9k → gentle EQ tilt → compressor → limiter → master
    const hp = new BiquadFilterNode(ctx, { type: "highpass", frequency: 110 });
    const lp = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 9000 });
    const low = new BiquadFilterNode(ctx, { type: "lowshelf", frequency: 400, gain: 0.8 });
    const mid = new BiquadFilterNode(ctx, { type: "peaking", frequency: 1800, Q: 0.7, gain: 0.5 });
    const high = new BiquadFilterNode(ctx, { type: "highshelf", frequency: 4000, gain: -0.7 });
    const comp = new DynamicsCompressorNode(ctx, { threshold: -26, ratio: 2.2, attack: 0.004, release: 0.18, knee: 6 });
    const lim = new DynamicsCompressorNode(ctx, { threshold: -1, ratio: 20, attack: 0.001, release: 0.05, knee: 0 });
    this.master = new GainNode(ctx, { gain: this.masterLevel() });
    hp.connect(lp).connect(low).connect(mid).connect(high).connect(comp).connect(lim).connect(this.master).connect(ctx.destination);
    this.bus = hp;
    // small room
    const verb = new ConvolverNode(ctx, { buffer: roomImpulse(ctx, 0.42, 3.2) });
    this.verbSend = new GainNode(ctx, { gain: 1 });
    this.verbSend.connect(verb).connect(this.bus);
    // ambience bypasses the UI compressor so it breathes
    this.ambient = new GainNode(ctx, { gain: this.enabled ? 1 : 0 });
    this.ambient.connect(ctx.destination);
    if (this.wantAmbient) this.playAmbient(this.wantAmbient);
    return ctx;
  }

  private masterLevel() { return this.enabled ? 0.35 * (this.reduce.matches ? 0.5 : 1) : 0; }

  setEnabled(on: boolean) {
    this.enabled = on;
    try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* ignore */ }
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    this.master.gain.setTargetAtTime(this.masterLevel(), t, 0.03);
    this.ambient.gain.setTargetAtTime(on ? 1 : 0, t, 0.25);
  }

  private gate(name: string, ms: number) {
    const now = performance.now();
    const cd = ms * (this.reduce.matches ? 2 : 1);
    if (now - (this.last.get(name) ?? -1e9) < cd) return false;
    this.last.set(name, now);
    return true;
  }

  /** The detent click. `strength` 0..1 lets fast scrubs sit back a little. */
  tick(strength = 1) {
    if (!this.enabled || !this.gate("tick", 28)) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime + 0.001;
    const cents = (Math.random() * 2 - 1) * 3;
    const lvl = db(-23.8 + (Math.random() * 2 - 1) * 0.6) * (0.55 + 0.45 * strength);

    const osc = new OscillatorNode(ctx, { type: "triangle", frequency: 293.66, detune: cents });
    const f = new BiquadFilterNode(ctx, { type: "lowpass", Q: 0.8, frequency: 690 * Math.pow(2, 1.25) });
    f.frequency.setValueAtTime(690 * Math.pow(2, 1.25), t);
    f.frequency.exponentialRampToValueAtTime(690, t + 0.036);
    const g = new GainNode(ctx, { gain: 0 });
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(lvl, t + 0.0015);
    g.gain.setTargetAtTime(0, t + 0.0015, 0.036 / 3);
    osc.connect(f).connect(g);
    g.connect(this.bus);
    const send = new GainNode(ctx, { gain: 0.07 });
    g.connect(send).connect(this.verbSend);
    osc.start(t); osc.stop(t + 0.034 + 0.06);

    // accent: unison sine 5 ms later, −23 dB under the body, wandering ±1.5 st (as shipped)
    const a = new OscillatorNode(ctx, { type: "sine", frequency: 293.66, detune: cents * 50 });
    const ag = new GainNode(ctx, { gain: 0 });
    ag.gain.setValueAtTime(0, t + 0.005);
    ag.gain.linearRampToValueAtTime(lvl * db(-23), t + 0.006);
    ag.gain.setTargetAtTime(0, t + 0.006, 0.0096 / 3);
    a.connect(ag).connect(this.bus);
    a.start(t + 0.005); a.stop(t + 0.005 + 0.08);

    if (strength > 0.6 && "vibrate" in navigator) try { navigator.vibrate(3); } catch { /* ignore */ }
  }

  /** Soft pink-noise swell for moving between worlds. */
  whoosh(dir: 1 | -1 = 1, dur = 0.9) {
    if (!this.enabled || !this.gate("whoosh", 220)) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime + 0.01;
    const src = new AudioBufferSourceNode(ctx, { buffer: pinkNoise(ctx, dur + 0.2) });
    const bp = new BiquadFilterNode(ctx, { type: "bandpass", Q: 0.9 });
    const f0 = dir > 0 ? 380 : 1600, f1 = dir > 0 ? 1600 : 380;
    bp.frequency.setValueAtTime(f0, t);
    bp.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = new GainNode(ctx, { gain: 0 });
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(db(-24), t + dur * 0.35);
    g.gain.setTargetAtTime(0, t + dur * 0.4, dur * 0.22);
    src.connect(bp).connect(g).connect(this.bus);
    const s = new GainNode(ctx, { gain: 0.22 });
    g.connect(s).connect(this.verbSend);
    src.start(t); src.stop(t + dur + 0.2);
  }

  private rumble: { g: GainNode; f: BiquadFilterNode } | null = null;
  /** Continuous low engine roar (0..1), e.g. Raptors during a landing burn. */
  setRumble(level: number) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    if (!this.rumble) {
      if (level < 0.01) return;
      const src = new AudioBufferSourceNode(ctx, { buffer: pinkNoise(ctx, 4), loop: true });
      const f = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 220, Q: 0.6 });
      const g = new GainNode(ctx, { gain: 0 });
      src.connect(f).connect(g).connect(this.bus);
      src.start();
      this.rumble = { g, f };
    }
    const t = ctx.currentTime;
    this.rumble.g.gain.setTargetAtTime(db(-14) * level, t, 0.08);
    this.rumble.f.frequency.setTargetAtTime(140 + 260 * level, t, 0.1);
  }

  // ── ambience (NASA recordings / sonifications) ─────────────────

  private loadBuffer(id: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(id);
    if (!p) {
      p = (async () => {
        const ctx = this.ctx!;
        for (const ext of ["m4a", "ogg", "mp3"]) {
          try {
            const r = await fetch(`/audio/${id}.${ext}`);
            if (!r.ok) continue;
            return await ctx.decodeAudioData(await r.arrayBuffer());
          } catch { /* next */ }
        }
        return null;
      })();
      this.buffers.set(id, p);
    }
    return p;
  }

  /** Cross-fade to a body's sound. `null` fades out. */
  async playAmbient(id: string | null, level = 0.32) {
    this.wantAmbient = id;
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.current?.id === id) return;
    const t = ctx.currentTime;
    if (this.current) {
      const old = this.current;
      old.gain.gain.cancelScheduledValues(t);
      old.gain.gain.setTargetAtTime(0, t, 0.5);
      old.src.stop(t + 3);
      this.current = null;
    }
    if (!id) return;
    const buf = await this.loadBuffer(id);
    if (!buf || this.wantAmbient !== id || this.current) return;
    const src = new AudioBufferSourceNode(ctx, { buffer: buf, loop: true });
    const g = new GainNode(ctx, { gain: 0 });
    src.connect(g).connect(this.ambient);
    const now = ctx.currentTime;
    g.gain.setValueAtTime(0, now);
    g.gain.setTargetAtTime(level, now + 0.15, 0.8);
    src.start(now, Math.random() * Math.max(0, buf.duration - 1));
    this.current = { id, src, gain: g };
  }
}

function pinkNoise(ctx: BaseAudioContext, seconds: number) {
  const len = Math.ceil(seconds * ctx.sampleRate);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return buf;
}

function roomImpulse(ctx: BaseAudioContext, seconds: number, decay: number) {
  const len = Math.ceil(seconds * ctx.sampleRate);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}
