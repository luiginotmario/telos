import { esc } from "./swap";

/** data/hominins.json, written from Smithsonian / NHM / peer-reviewed measurements. */
export interface Hominin {
  key: string; name: string; alias?: string[]; alias_eras?: Record<string, number[]>; years: string;
  height_m: { mean?: number | null; male: number | null; female: number | null; range?: [number, number] | null; unreviewed_proxy?: { value: [number, number]; source: string } } | null;
  mass_kg?: { male: number | null; female: number | null; range?: [number, number] | null } | null;
  cranial_cc?: { mean: number | null; range?: [number, number] | null } | null;
  proportions?: { arm_to_leg?: number; torso?: string; build?: string };
  posture?: string; known_from?: string; confidence?: string; note?: string;
  sources?: { title: string; url: string }[];
}
export interface HomininData { modern: Hominin; species: Hominin[]; modern_aliases?: string[]; modern_alias_eras?: Record<string, number[]>; unmapped_aliases?: string[] | Record<string, unknown> }

const files = import.meta.glob<HomininData>("../../data/hominins.json", { import: "default" });
const avg = (h: Hominin["height_m"]) => {
  if (!h) return null;
  if (typeof h.mean === "number") return h.mean;
  const v = [h.male, h.female].filter((x): x is number => typeof x === "number");
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : h.range ? (h.range[0] + h.range[1]) / 2 : null;
};

/**
 * Side panel: the species beside a modern human, both photoreal reconstructions cut out and
 * stood on one floor at true relative height, against a metre scale. Pure DOM: two images.
 */
export class Specimen {
  private el: HTMLElement;
  private figsEl: HTMLElement;
  private data: HomininData | null = null;
  private dataP: Promise<HomininData | null> | null = null;

  constructor() {
    this.el = document.createElement("aside");
    this.el.className = "specimen";
    this.el.setAttribute("aria-hidden", "true");
    this.el.innerHTML = `
      <button class="sp-x" aria-label="Close">
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
      </button>
      <div class="sp-stage"><div class="sp-scale"></div><div class="sp-figs"></div></div>
      <div class="sp-body"></div>`;
    document.body.appendChild(this.el);
    this.figsEl = this.el.querySelector(".sp-figs")!;
    this.el.querySelector(".sp-x")!.addEventListener("click", () => { this.close(); this.onUserClose(); });
    addEventListener("keydown", (e) => { if (e.key === "Escape" && this.isOpen) { e.stopImmediatePropagation(); this.close(); this.onUserClose(); } }, { capture: true });
  }

  get isOpen() { return this.el.hasAttribute("data-open"); }
  /** the species on show ("" when closed) */
  current = "";
  /** the visitor closed it themselves (X or Escape) */
  onUserClose: () => void = () => {};
  /** species with a reconstruction to show */
  static readonly FIGURES = new Set(["modern", "sapiens_early", "neanderthalensis", "denisova", "heidelbergensis", "floresiensis", "naledi", "erectus", "habilis", "sediba", "boisei"]);

  load() {
    const f = files["../../data/hominins.json"];
    this.dataP ??= f ? f().catch(() => null) : Promise.resolve(null);
    return this.dataP.then((d) => (this.data = d));
  }

  /** Which species a people label refers to (or "modern"), following hominins.json's alias rules. */
  keyFor(name: string, eraYear: number): string | null {
    const d = this.data;
    if (!d) return null;
    const un = d.unmapped_aliases;
    if (un && (Array.isArray(un) ? un.includes(name) : name in un)) return null;
    for (const x of d.species) {
      if (x.name !== name && !x.alias?.includes(name)) continue;
      const eras = x.alias_eras?.[name];
      if (eras && !eras.some((e) => Math.abs(e - eraYear) <= Math.max(1, Math.abs(eraYear) * 0.05))) continue;
      return x.key;
    }
    const near = (eras: number[]) => eras.some((e) => Math.abs(e - eraYear) <= Math.max(1, Math.abs(eraYear) * 0.05));
    if (d.modern_aliases?.includes(name)) return "modern";
    const me = d.modern_alias_eras?.[name];
    if (me && near(me)) return "modern";
    return eraYear >= -10000 ? "modern" : null;
  }

  async open(key: string, eraLabel: string) {
    await this.load();
    const d = this.data;
    if (!d) return;
    const sp = key === "modern" ? { ...d.modern, name: "Anatomically modern humans", note: "Same body as yours: this group is us.", known_from: "" } : d.species.find((s) => s.key === key);
    if (!sp) return;
    this.current = key;
    this.el.setAttribute("aria-hidden", "false");
    // re-trigger the entrance when switching species while open
    this.el.removeAttribute("data-open"); void this.el.offsetWidth; this.el.setAttribute("data-open", "");
    this.renderBody(sp, d.modern, eraLabel);
    this.stageFigures(sp, d.modern, key);
  }

  close() {
    this.current = "";
    this.el.removeAttribute("data-open");
    this.el.setAttribute("aria-hidden", "true");
  }

  private renderBody(sp: Hominin, modern: Hominin, era: string) {
    const h = avg(sp.height_m), hm = avg(modern.height_m) ?? 1.65;
    const cc = sp.cranial_cc?.mean ?? null, ccm = modern.cranial_cc?.mean ?? 1350;
    const row = (k: string, v: string, bar?: number) =>
      `<div class="sp-row"><dt>${k}</dt><dd>${v}${bar != null ? `<i class="sp-bar"><b style="transform:scaleX(${Math.min(1, bar).toFixed(3)})"></b></i>` : ""}</dd></div>`;
    const conf = sp.confidence === "low" ? `<span class="sp-conf">Body largely unknown</span>` : sp.confidence === "medium" ? `<span class="sp-conf">Partly reconstructed</span>` : "";
    this.el.querySelector(".sp-body")!.innerHTML = `
      <p class="sp-eyebrow">${esc(era)}</p>
      <h2>${esc(sp.name)}</h2>
      <p class="sp-years">${esc(sp.years)}${conf}</p>
      ${sp.note ? `<p class="sp-note">${esc(sp.note)}</p>` : ""}
      <dl>
        ${h ? row("Height", `${h.toFixed(2)} m · you ${hm.toFixed(2)} m`) : sp.height_m?.unreviewed_proxy
          ? row("Height", `Unknown · preprint suggests ${sp.height_m.unreviewed_proxy.value[0].toFixed(2)}–${sp.height_m.unreviewed_proxy.value[1].toFixed(2)} m (not peer-reviewed)`)
          : row("Height", "Unknown: too few bones to reconstruct a body")}
        ${cc ? row("Brain", `${Math.round(cc)} cc · you ${ccm}`, cc / ccm) : ""}
        ${sp.posture ? row("Walked", esc(sp.posture)) : ""}
        ${sp.known_from ? row("Known from", esc(sp.known_from)) : ""}
      </dl>
      <p class="sp-art">Reconstruction: AI image from published measurements, not a fossil cast</p>
      <div class="sp-src">${(sp.sources ?? []).slice(0, 3).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title.length > 34 ? s.title.slice(0, 32) + "…" : s.title)}</a>`).join("")}</div>`;
  }

  /** Both figures on one floor; image height = true height on the stage's metre scale. */
  private stageFigures(sp: Hominin, modern: Hominin, key: string) {
    const hm = avg(modern.height_m) ?? 1.65;
    const proxy = sp.height_m?.unreviewed_proxy?.value;
    const hs = avg(sp.height_m) ?? (proxy ? (proxy[0] + proxy[1]) / 2 : null);
    const unknownBody = hs == null;
    const top = Math.max(hs ?? 0, hm) * 1.14;          // metres shown, with headroom
    const pct = (m: number) => `${((m / top) * 100).toFixed(2)}%`;
    const fig = (k: string, h: number, cls: string, alt: string, tag: string) =>
      `<figure class="sp-fig ${cls}" style="--h:${pct(h)}"><img src="/hominins/${k}.webp" alt="${esc(alt)}" decoding="async"><figcaption>${esc(tag)}</figcaption></figure>`;
    this.figsEl.innerHTML =
      (unknownBody ? "" : fig(key, hs, `a${proxy && avg(sp.height_m) == null ? " uncertain" : ""}`, `Reconstruction of ${sp.name}, ${hs.toFixed(2)} m`, sp.name.replace(/^Homo /, "H. "))) +
      fig("modern", hm, "b", `A modern human, ${hm.toFixed(2)} m`, "You");
    this.figsEl.dataset.single = String(unknownBody);
    const scale = this.el.querySelector(".sp-scale") as HTMLElement;
    scale.innerHTML = [0.5, 1, 1.5, 2].filter((m) => m < top).map((m) => `<span style="bottom:${pct(m)}"><i></i>${m % 1 ? "" : `${m} m`}</span>`).join("");
  }
}
