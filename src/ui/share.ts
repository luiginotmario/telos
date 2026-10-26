/**
 * Share card: the live frame, cropped to a 1200×630 link-preview shape, with the moment's
 * caption set in the site's own type and its link — handed to the system share sheet where
 * there is one (phones, Safari), otherwise downloaded with the link copied.
 */
export interface Moment { path: string; headline: string; title: string; line: string; world: string; projected: boolean }

const W = 1200, H = 630;

export async function shareMoment(frame: HTMLCanvasElement, m: Moment) {
  const url = `${location.origin}${m.path}`;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const x = c.getContext("2d")!;
  x.fillStyle = "#000"; x.fillRect(0, 0, W, H);
  // cover-crop the frame, biased a little up (the caption sits low on the page)
  const s = Math.max(W / frame.width, H / frame.height);
  const dw = frame.width * s, dh = frame.height * s;
  x.drawImage(frame, (W - dw) / 2, (H - dh) / 2 - dh * 0.04, dw, dh);
  // a quiet floor of shade so the caption reads over anything
  const g = x.createLinearGradient(0, H * 0.48, 0, H);
  g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.78)");
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  const font = getComputedStyle(document.body).fontFamily;
  x.fillStyle = "#fff";
  x.textBaseline = "alphabetic";
  const left = 56;
  x.font = `500 21px ${font}`;
  x.globalAlpha = 0.66;
  x.fillText(`${m.world}${m.headline ? ` · ${m.headline}` : ""}${m.projected ? " · projected" : ""}`, left, H - 132);
  x.globalAlpha = 1;
  x.font = `600 46px ${font}`;
  x.fillText(clip(x, m.title, W - left * 2), left, H - 82);
  x.font = `400 22px ${font}`;
  x.globalAlpha = 0.74;
  x.fillText(clip(x, m.line, W - left * 2 - 300), left, H - 46);
  // the mark and the link, bottom right
  x.globalAlpha = 0.9;
  x.font = `600 20px ${font}`;
  const host = url.replace(/^https?:\/\//, "");
  const tw = x.measureText(host).width;
  x.fillText(host, W - left - tw, H - 46);
  x.globalAlpha = 1;
  x.beginPath(); x.strokeStyle = "#fff"; x.lineWidth = 2.2;
  x.arc(W - left - tw - 22, H - 53, 8, 0, Math.PI * 2); x.stroke();
  x.beginPath(); x.fillStyle = "#fff"; x.arc(W - left - tw - 22, H - 61, 2.6, 0, Math.PI * 2); x.fill();

  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
  if (!blob) return;
  const file = new File([blob], `telos${m.path.replace(/\//g, "-")}.png`, { type: "image/png" });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: `${m.title} · Telos`, text: m.title, url }); return; }
    catch (e) { if ((e as DOMException).name === "AbortError") return; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  try { await navigator.clipboard.writeText(url); } catch { /* not allowed: the image still saved */ }
}

function clip(x: CanvasRenderingContext2D, s: string, max: number) {
  if (x.measureText(s).width <= max) return s;
  while (s.length > 1 && x.measureText(s + "…").width > max) s = s.slice(0, -1);
  return s + "…";
}
