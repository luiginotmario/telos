import { esc } from "./swap";

interface Credit { what: string; who: string; licence?: string; url?: string }
interface Credits { sections: { title: string; items: Credit[] }[] }

/** Licence-required attributions, loaded on demand from /credits.json. */
export function mountCredits() {
  const btn = document.createElement("button");
  btn.className = "credits-btn";
  btn.textContent = "Credits";
  const dlg = document.createElement("dialog");
  dlg.className = "credits";
  dlg.innerHTML = `<div class="credits-in"><header><h2>Credits</h2><button class="x" aria-label="Close">Close</button></header><div class="credits-body"><p class="muted">Loading…</p></div></div>`;
  document.body.append(btn, dlg);
  let loaded = false;
  btn.addEventListener("click", async () => {
    dlg.showModal();
    if (loaded) return;
    loaded = true;
    try {
      const c: Credits = await fetch("/credits.json").then((r) => r.json());
      dlg.querySelector(".credits-body")!.innerHTML = c.sections.map((s) => `
        <section><h3>${esc(s.title)}</h3><ul>${s.items.map((i) => `
          <li><b>${i.url ? `<a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.what)}</a>` : esc(i.what)}</b>
          <span>${esc(i.who)}${i.licence ? ` · ${esc(i.licence)}` : ""}</span></li>`).join("")}</ul></section>`).join("");
    } catch { loaded = false; }
  });
  dlg.querySelector(".x")!.addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
}
