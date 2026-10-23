/**
 * Cross-fades a container's content: the old block leaves (fast, ease-in, −4px, blur),
 * the new one arrives (opacity leads, blur + 6px rise trail). Interruptible: rapid
 * swaps simply stack and clean themselves up.
 */
export function swapContent(container: HTMLElement, cls: string, html: string, key: string, opts: { stagger?: string } = {}) {
  const cur = container.lastElementChild as HTMLElement | null;
  if (cur && cur.dataset.key === key && cur.dataset.state !== "leave") return;
  for (const el of Array.from(container.children) as HTMLElement[]) {
    if (el.dataset.state === "leave") continue;
    el.dataset.state = "leave";
    setTimeout(() => el.remove(), 320);
  }
  // cap the stack so a fast scrub never piles up DOM
  const leaving = Array.from(container.children).filter((e) => (e as HTMLElement).dataset.state === "leave");
  for (let i = 0; i < leaving.length - 2; i++) leaving[i].remove();

  const next = document.createElement("div");
  next.className = cls;
  next.dataset.key = key;
  next.dataset.state = "enter";
  next.innerHTML = html;
  const kids = opts.stagger ? Array.from(next.querySelectorAll<HTMLElement>(opts.stagger)) : [];
  kids.forEach((k, i) => { k.dataset.state = "enter"; k.style.transitionDelay = `${40 + i * 45}ms`; });
  container.appendChild(next);
  // commit the enter styles, then release them so the transition runs from there
  void next.offsetWidth;
  delete next.dataset.state;
  kids.forEach((k) => delete k.dataset.state);
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
