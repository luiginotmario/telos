import "../style.css";

/** Builds the static DOM skeleton. Everything dynamic is filled by the views. */
export function mountShell() {
  const html = String.raw;
  document.body.dataset.mode = "system";
  document.body.insertAdjacentHTML(
    "afterbegin",
    html`
      <canvas id="gl" aria-hidden="true"></canvas>
      <div id="labels" aria-hidden="true"></div>

      <header class="chrome top">
        <button class="wordmark" id="home" aria-label="Telos, back to the solar system">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="1.75" r="1.75" fill="currentColor"/></svg>
          <span>Telos</span>
        </button>
        <nav class="worlds" id="worlds" aria-label="Worlds"></nav>
        <button class="sound" id="sound" aria-pressed="true" aria-label="Sound">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><g class="bars" fill="currentColor"><rect x="2" y="6" width="1.5" height="4" rx=".75"/><rect x="5.5" y="3.5" width="1.5" height="9" rx=".75"/><rect x="9" y="5" width="1.5" height="6" rx=".75"/><rect x="12.5" y="7" width="1.5" height="2" rx=".75"/></g></svg>
        </button>
      </header>

      <section class="system-ui" id="system-ui">
        <p class="hint">Select a world</p>
        <div class="caption sys-caption" id="sys-caption" aria-live="polite"></div>
        <div class="ruler sys-ruler" id="sys-ruler"></div>
        <p class="date" id="system-date"></p>
        <p class="note">Planet sizes enlarged. Positions, orbits, tilts and stars are true for this date.</p>
      </section>

      <main class="planet-ui" id="planet-ui" inert>
        <div class="shadow" id="shadow"></div>
        <aside class="story" id="story" aria-live="polite"></aside>
        <aside class="side" id="side"></aside>
        <div class="caption" id="caption" aria-live="polite"></div>
        <button class="info" id="info" aria-label="About this moment" aria-expanded="false"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="7.35" y="7" width="1.3" height="4.6" rx=".65" fill="currentColor"/><circle cx="8" cy="4.9" r=".85" fill="currentColor"/></svg></button>
        <div class="ruler" id="ruler"></div>
        <p class="scroll-hint" id="scroll-hint" aria-hidden="true"><svg viewBox="0 0 12 16" width="9" height="12"><rect x="1" y="1" width="10" height="14" rx="5" fill="none" stroke="currentColor" stroke-width="1.2"/><rect class="wheel" x="5.4" y="3.5" width="1.2" height="3" rx=".6" fill="currentColor"/></svg>Scroll to move through time</p>
        <p class="audio-credit" id="audio-credit"></p>
        <p class="aerial-note">Arcadia Planitia, SpaceX candidate site AP-9 · real location, illustrative layout and scale</p>
      </main>
    `,
  );

  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  return {
    canvas: $<HTMLCanvasElement>("gl"),
    labels: $("labels"),
    home: $<HTMLButtonElement>("home"),
    worlds: $("worlds"),
    sound: $<HTMLButtonElement>("sound"),
    systemDate: $("system-date"),
    sysCaption: $("sys-caption"),
    sysRuler: $("sys-ruler"),
    planetUi: $("planet-ui"),
    shadow: $("shadow"),
    story: $("story"),
    side: $("side"),
    caption: $("caption"),
    info: $<HTMLButtonElement>("info"),
    ruler: $("ruler"),
    audioCredit: $("audio-credit"),
  };
}

export type Shell = ReturnType<typeof mountShell>;
