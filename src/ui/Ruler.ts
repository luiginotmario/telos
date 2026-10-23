import { SPRING_REBOUND, SPRING_RELEASE, Spring, Tween, clamp, expoOut, follow, reducedMotion } from "../motion";
import type { Sound } from "../sound";

export interface RulerStop { future: boolean }

const TARGET_TICKS = 64;
const BASE_H = 0.30;    // resting tick height (fraction of 24px)
const NEAR_H = 0.78;    // tallest neighbour next to the thumb
const HOVER_H = 0.62;   // magnification under the cursor
const RADIUS = 26;      // px, gaussian falloff of the magnification

/**
 * Tick ruler: evenly spaced stops, magnifying ticks (Dock-style), magnetic drag,
 * spring settle, rubber-band over-drag, a detent click per stop crossed.
 */
export class Ruler {
  private el: HTMLElement;
  private ticksEl!: HTMLElement;
  private thumb!: HTMLElement;
  private endL!: HTMLSpanElement;
  private endR!: HTMLSpanElement;
  private ticks: { el: HTMLElement; pos: number; stop: number; h: number }[] = [];
  private n = 0;
  private width = 0;

  /** displayed position in stop units (fractional) */
  pos = 0;
  private target = 0;
  private spring = new Spring(0, SPRING_RELEASE);
  private tween = new Tween(expoOut);
  private mode: "idle" | "drag" | "tween" | "spring" = "idle";
  private dragRaw = 0;
  private hoverX: number | null = null;
  private lastStop = -1;
  private stretch = new Spring(1, SPRING_REBOUND);
  private stretchOrigin = "left";
  private lastPos = 0;
  private speed = 0;
  private pointerId: number | null = null;
  private moved = 0;
  private downX = 0;

  onChange: (pos: number) => void = () => {};
  onSettle: (stop: number) => void = () => {};

  constructor(el: HTMLElement, private sound: Sound) {
    this.el = el;
    el.setAttribute("role", "slider");
    el.tabIndex = 0;
    el.innerHTML = `<div class="ticks"></div><div class="ends"><span></span><span></span></div>`;
    this.ticksEl = el.querySelector(".ticks")!;
    const [l, r] = el.querySelectorAll<HTMLSpanElement>(".ends span");
    this.endL = l; this.endR = r;
    this.thumb = document.createElement("div");
    this.thumb.className = "thumb";
    this.ticksEl.appendChild(this.thumb);
    new ResizeObserver(() => this.layout()).observe(el);
    this.bind();
  }

  setStops(stops: RulerStop[], labels: [string, string], at: number, ariaLabel: string, animate = false) {
    if (animate && !reducedMotion()) {
      this.ticksEl.animate([{ opacity: 0.15, filter: "blur(2px)" }, { opacity: 1, filter: "blur(0px)" }], { duration: 420, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
    }
    this.n = stops.length;
    this.el.setAttribute("aria-label", ariaLabel);
    this.el.setAttribute("aria-valuemin", "0");
    this.el.setAttribute("aria-valuemax", String(this.n - 1));
    for (const t of this.ticks) t.el.remove();
    this.ticks = [];
    const gaps = Math.max(0, this.n - 1);
    const fill = gaps ? Math.max(0, Math.floor((TARGET_TICKS - this.n) / gaps)) : 0;
    for (let i = 0; i < this.n; i++) {
      this.addTick(i, i, stops[i].future);
      if (i < this.n - 1) for (let k = 1; k <= fill; k++) this.addTick(i + k / (fill + 1), -1, stops[i + 1].future && stops[i].future);
    }
    this.endL.textContent = labels[0];
    this.endR.textContent = labels[1];
    this.pos = this.target = at;
    this.spring.snap(at);
    this.lastStop = Math.round(at);
    this.mode = "idle";
    this.layout();
    this.render(0);
  }

  private addTick(pos: number, stop: number, future: boolean) {
    const el = document.createElement("div");
    el.className = "tick";
    if (stop >= 0) el.dataset.stop = "";
    if (future) el.dataset.future = "";
    this.ticksEl.insertBefore(el, this.thumb);
    this.ticks.push({ el, pos, stop, h: BASE_H });
  }

  private layout() { this.width = this.el.clientWidth; }
  private xOf(pos: number) { return this.n <= 1 ? this.width / 2 : (pos / (this.n - 1)) * this.width; }
  private posOf(x: number) { return this.n <= 1 ? 0 : (x / this.width) * (this.n - 1); }

  /** Animate to a stop (click, keyboard, programmatic). */
  goTo(stop: number, fromKeyboard = false) {
    stop = clamp(Math.round(stop), 0, this.n - 1);
    this.target = stop;
    const dist = Math.abs(stop - this.pos);
    const dur = reducedMotion() ? 0 : Math.min(1.1, (fromKeyboard ? 0.45 : 0.6) + dist * 0.012);
    this.tween.start(this.pos, stop, dur, performance.now() / 1000);
    this.mode = "tween";
  }

  get stop() { return Math.round(this.target); }
  get count() { return this.n; }

  /** Instant jump (deep links, debugging). */
  jump(stop: number) {
    stop = clamp(Math.round(stop), 0, this.n - 1);
    this.pos = this.target = stop;
    this.spring.snap(stop);
    this.mode = "idle";
    this.lastStop = stop;
    this.onChange(stop);
    this.render(0);
  }

  private bind() {
    const el = this.el;
    el.addEventListener("pointerdown", (e) => {
      if (this.pointerId !== null || e.button !== 0) return;
      this.pointerId = e.pointerId;
      el.setPointerCapture(e.pointerId);
      this.moved = 0;
      this.downX = e.clientX;
      this.dragRaw = this.posOf(e.clientX - el.getBoundingClientRect().left);
      this.mode = "drag";
      this.sound.tick(0.8);
    });
    el.addEventListener("pointermove", (e) => {
      const r = el.getBoundingClientRect();
      if (e.pointerType !== "touch") this.hoverX = e.clientX - r.left;
      if (e.pointerId !== this.pointerId) return;
      this.moved = Math.max(this.moved, Math.abs(e.clientX - this.downX));
      this.dragRaw = this.posOf(e.clientX - r.left);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.pointerId) return;
      this.pointerId = null;
      const stop = clamp(Math.round(this.dragRaw), 0, this.n - 1);
      if (this.moved < 4) {
        this.goTo(stop);
      } else {
        this.target = stop;
        this.spring.x = this.pos; this.spring.v = this.speed * 0.6; this.spring.target = stop;
        this.mode = reducedMotion() ? "idle" : "spring";
        if (this.mode === "idle") { this.pos = stop; this.onSettle(stop); }
      }
      // release the rubber band
      this.stretch.target = 1;
      this.sound.tick(0.6);
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("pointerleave", () => { this.hoverX = null; });
    el.addEventListener("keydown", (e) => {
      const cur = this.stop;
      let next = cur;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") next = e.metaKey ? this.n - 1 : cur + 1;
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = e.metaKey ? 0 : cur - 1;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = this.n - 1;
      else if (e.key === "Escape") { el.blur(); return; }
      else return;
      e.preventDefault();
      e.stopPropagation();
      next = clamp(next, 0, this.n - 1);
      if (next !== cur) this.goTo(next, true);
    });
  }

  update(dt: number, now: number) {
    if (!this.n) return;
    const prev = this.pos;
    if (this.mode === "drag") {
      const raw = this.dragRaw;
      const c = clamp(raw, 0, this.n - 1);
      const near = Math.round(c);
      const d = Math.abs(c - near);
      const s = Math.pow(1 - Math.min(1, d * 2), 2);
      const magnet = c * (1 - s) + near * s;
      this.pos = follow(this.pos, magnet, dt, reducedMotion() ? 0.001 : 0.045);
      this.target = near;
      // rubber band past the ends
      const over = raw < 0 ? -raw : raw > this.n - 1 ? raw - (this.n - 1) : 0;
      const overPx = (over / Math.max(1, this.n - 1)) * this.width;
      this.stretchOrigin = raw < 0 ? "right" : "left";
      this.stretch.target = 1 + 0.05 * Math.log10(1 + 2 * (overPx / 24));
      this.stretch.x = follow(this.stretch.x, this.stretch.target, dt, 0.06);
      this.stretch.v = 0;
    } else {
      if (this.mode === "tween") {
        this.pos = this.tween.value(now);
        if (!this.tween.active) { this.mode = "idle"; this.onSettle(this.stop); }
      } else if (this.mode === "spring") {
        this.pos = this.spring.step(dt);
        // never overshoot past the ends
        this.pos = clamp(this.pos, 0, this.n - 1);
        if (this.spring.settled) { this.pos = this.spring.target; this.mode = "idle"; this.onSettle(this.stop); }
      }
      this.stretch.step(dt);
    }
    this.speed = dt > 0 ? (this.pos - prev) / dt : 0;

    // detent: click each time we cross a stop
    const cur = Math.round(this.pos);
    if (cur !== this.lastStop) {
      const v = Math.abs(this.speed);
      this.sound.tick(clamp(1.1 - v / 60, 0.35, 1));
      this.lastStop = cur;
      this.el.setAttribute("aria-valuenow", String(cur));
    }
    if (Math.abs(this.pos - this.lastPos) > 1e-5) this.onChange(this.pos);
    this.lastPos = this.pos;
    this.render(dt);
  }

  private render(dt: number) {
    const thumbX = this.xOf(this.pos);
    const hx = this.hoverX;
    for (const t of this.ticks) {
      const x = this.xOf(t.pos);
      const dThumb = (x - thumbX) / RADIUS;
      let h = BASE_H + (NEAR_H - BASE_H) * Math.exp(-dThumb * dThumb);
      if (hx !== null) {
        const dh = (x - hx) / RADIUS;
        h = Math.max(h, BASE_H + (HOVER_H - BASE_H) * Math.exp(-dh * dh));
      }
      if (t.stop < 0) h *= 0.82;
      t.h = dt ? follow(t.h, h, dt, 0.055) : h;
      t.el.style.transform = `translateX(${x.toFixed(2)}px) scaleY(${t.h.toFixed(4)})`;
    }
    this.thumb.style.transform = `translateX(${thumbX.toFixed(2)}px)`;
    const s = this.stretch.x;
    this.ticksEl.style.transformOrigin = `${this.stretchOrigin} center`;
    this.ticksEl.style.transform = Math.abs(s - 1) > 1e-4 ? `scale(${s.toFixed(4)}, ${(1 - 0.015 * (s - 1) * 20).toFixed(4)})` : "";
    const atStart = this.pos < 0.5, atEnd = this.pos > this.n - 1.5;
    this.endL.toggleAttribute("data-on", atStart);
    this.endR.toggleAttribute("data-on", atEnd);
  }
}
