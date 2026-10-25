// The snapshot renderer: the server's headless Chrome loads this page and calls window.adlSnap.render() for each
// screen, then takes the screenshot itself. Uses the same screenHost code as the canvas.
import {
  anchorRects,
  contentHeight,
  fetchSource,
  mountPrepared,
  prepare,
  seekAnimations,
  settle,
} from '../engine/screenHost.ts';

interface RenderArgs {
  pid: string;
  hash: string;
  w: number;
  h: number | 'auto';
  at: number;
}

const host = document.getElementById('host') as HTMLElement;

async function render(a: RenderArgs) {
  const src = fetchSource('', a.pid);
  const p = await prepare(src, a.hash);
  host.style.width = `${a.w}px`;
  host.style.height = a.h === 'auto' ? '20000px' : `${a.h}px`;
  const root = mountPrepared(host, p);
  await settle(root);
  seekAnimations(root, a.at);
  let h = a.h === 'auto' ? Math.max(200, Math.min(20000, contentHeight(root))) : a.h;
  if (a.h === 'auto') {
    host.style.height = `${h}px`;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    h = Math.max(200, Math.min(20000, contentHeight(root)));
    host.style.height = `${h}px`;
  }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  // text a person could not read: cut off inside its box, or running past the frame edges
  const overflow: string[] = [];
  const outside: string[] = [];
  const hr = host.getBoundingClientRect();
  for (const el of root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,span,button,a,li,label,div,strong,em,small,td,th')) {
    const e = el as HTMLElement;
    const text = (e.textContent ?? '').trim();
    if (e.children.length !== 0 || !text) continue;
    if (e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow === 'hidden')
      overflow.push(text.slice(0, 40));
    const r = e.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && (r.right > hr.right + 1 || r.left < hr.left - 1 || r.top < hr.top - 1))
      outside.push(text.slice(0, 40));
  }
  const tall = a.h === 'auto' ? 0 : Math.max(0, contentHeight(root) - a.h);
  return {
    w: a.w,
    h,
    anchors: anchorRects(host, root),
    overflow: overflow.slice(0, 5),
    outside: outside.slice(0, 5),
    tall,
  };
}

/** Downscale a captured image in the page (no native image library on the server). */
async function resize(dataUrl: string, widths: number[]): Promise<{ w: number; data: string; avg: string }[]> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const out: { w: number; data: string; avg: string }[] = [];
  for (const w of widths) {
    const h = Math.max(1, Math.round((img.naturalHeight * w) / img.naturalWidth));
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, w, h);
    const blob = await c.convertToBlob({ type: 'image/webp', quality: 0.86 });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    const px = c.getContext('2d')!.getImageData(0, 0, w, h).data;
    let r = 0;
    let gg = 0;
    let b = 0;
    const n = px.length / 4;
    for (let i = 0; i < px.length; i += 16) {
      r += px[i]!;
      gg += px[i + 1]!;
      b += px[i + 2]!;
    }
    const k = Math.max(1, Math.ceil(n / 4));
    out.push({ w, data: btoa(bin), avg: `rgb(${Math.round(r / k)},${Math.round(gg / k)},${Math.round(b / k)})` });
  }
  return out;
}

(window as unknown as { adlSnap: unknown }).adlSnap = { render, resize, ready: true };
