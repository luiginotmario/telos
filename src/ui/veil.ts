import * as THREE from "three";
import { reducedMotion } from "../motion";

/**
 * The first moment: the Telos mark drawn as an orbit that closes as the worlds load.
 * Progress is real (three's loading manager); the veil lifts once the overview's textures
 * are in, or after a ceiling so a slow network never holds the page hostage.
 */
export function mountVeil(opts: { minMs?: number; maxMs?: number } = {}) {
  const minMs = opts.minMs ?? 900, maxMs = opts.maxMs ?? 5000;
  const R = 26, C = 2 * Math.PI * R;
  const el = document.createElement("div");
  el.className = "veil";
  el.setAttribute("role", "progressbar");
  el.setAttribute("aria-label", "Loading the solar system");
  el.innerHTML = `
    <div class="veil-mark">
      <svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
        <circle class="veil-track" cx="32" cy="32" r="${R}" />
        <circle class="veil-arc" cx="32" cy="32" r="${R}" stroke-dasharray="${C}" stroke-dashoffset="${C}" transform="rotate(-90 32 32)" />
        <circle class="veil-body" cx="32" cy="${32 - R}" r="3.2" />
      </svg>
      <p class="veil-word">Telos</p>
      <p class="veil-line">Computing positions for ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}</p>
    </div>`;
  document.body.appendChild(el);
  const arc = el.querySelector<SVGCircleElement>(".veil-arc")!;
  const body = el.querySelector<SVGCircleElement>(".veil-body")!;

  let target = 0, shown = 0, finished = false;
  const t0 = performance.now();
  let tl = t0;
  const mgr = THREE.DefaultLoadingManager;
  const prevProgress = mgr.onProgress;
  mgr.onProgress = (url, loaded, total) => {
    target = Math.max(target, total ? loaded / total : 0);
    prevProgress?.(url, loaded, total);
  };

  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));

  // the arc eases toward real progress; the dot rides its leading edge
  const step = () => {
    const now = performance.now(), age = now - t0;
    const dt = Math.min(0.25, (now - tl) / 1000); tl = now;
    const goal = finished ? 1 : Math.min(0.94, target);
    // time-based ease (not per-frame), so a throttled tab still closes the orbit on time
    shown += (goal - shown) * (1 - Math.exp(-dt * (finished ? 10 : 5)));
    if (finished && goal - shown < 0.01) shown = 1;
    arc.setAttribute("stroke-dashoffset", String(C * (1 - shown)));
    const a = shown * Math.PI * 2 - Math.PI / 2;
    body.setAttribute("cx", String(32 + Math.cos(a) * R));
    body.setAttribute("cy", String(32 + Math.sin(a) * R));
    el.setAttribute("aria-valuenow", String(Math.round(shown * 100)));
    if (!finished && age > minMs && (target >= 0.999 || age > maxMs)) finished = true;
    if (finished && shown > 0.995) { lift(); return; }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  // if frames never come (hidden or throttled tab) the page still opens
  const watchdog = setTimeout(() => lift(), maxMs + 2500);

  let lifted = false;
  function lift() {
    if (lifted) return;
    lifted = true;
    clearTimeout(watchdog);
    mgr.onProgress = prevProgress;
    el.dataset.state = "lift";
    resolve();
    setTimeout(() => el.remove(), reducedMotion() ? 200 : 1400);
  }

  /** Mark the overview ready early (e.g. everything came from cache). */
  const ready = () => { target = 1; };
  return { done, ready };
}
