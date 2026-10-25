// Fidelity gate for the Claude Design importer: every imported screen is rendered three ways, frozen at t = 1200 ms,
// and compared pixel by pixel:
//   original phone on the Claude Design board  vs  the imported standalone screen file
//   standalone screen file                     vs  the Agent Design Lab renderer (Shadow DOM, compiled CSS)
// Usage: ADL_BENCH_WIREFLOWS=<dir> ADL_BENCH_PROJECT=<id> node bench/fidelity-import.ts [section]
//   <dir> holds the original boards (app|onboarding/golden/project/<section>.dc.html), their images
//   (app/assets/blob/, onboarding/assets/ + onboarding/blobmap.json) and the imported workspace (workspace/<id>).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import { startServer } from '../src/node/server/server.ts';

const WF = process.env.ADL_BENCH_WIREFLOWS ?? '';
const PROJECT = process.env.ADL_BENCH_PROJECT ?? '';
if (!WF || !PROJECT) throw new Error('set ADL_BENCH_WIREFLOWS and ADL_BENCH_PROJECT (see the usage line at the top)');
const OUT = path.resolve(import.meta.dirname, 'results/fidelity');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const only = process.argv[2];

// original boards with /_blob/ served from the wireflows assets
const blobs = new Map<string, string>();
for (const f of fs.readdirSync(path.join(WF, 'app/assets/blob')))
  blobs.set(f.replace(/\.\w+$/, ''), path.join(WF, 'app/assets/blob', f));
for (const [name, url] of Object.entries(
  JSON.parse(fs.readFileSync(path.join(WF, 'onboarding/blobmap.json'), 'utf8')) as Record<string, string>,
)) {
  const f = path.join(WF, 'onboarding/assets', `${name}.webp`);
  if (fs.existsSync(f)) blobs.set(url.replace('/_blob/', ''), f);
}
const boardFile = (section: string) =>
  [
    path.join(WF, 'app/golden/project', `${section}.dc.html`),
    path.join(WF, 'onboarding/golden/project', `${section}.dc.html`),
  ].find((f) => fs.existsSync(f));
const boardSrv = http.createServer((req, res) => {
  const u = new URL(req.url!, 'http://x');
  if (u.pathname.startsWith('/_blob/')) {
    const f = blobs.get(u.pathname.slice(7));
    if (!f) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': f.endsWith('.png') ? 'image/png' : 'image/webp' });
    return void res.end(fs.readFileSync(f));
  }
  const f = boardFile(decodeURIComponent(u.pathname.slice(1)));
  if (!f) return void res.writeHead(404).end();
  const s = fs.readFileSync(f, 'utf8');
  const helmet = s.slice(s.indexOf('<helmet>') + 8, s.indexOf('</helmet>'));
  const body = s.slice(s.indexOf('</helmet>') + 9, s.indexOf('</x-dc>'));
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(
    `<!doctype html><html><head><meta charset="utf-8">${helmet}<style>body{margin:0}.am-phone>div[style*="z-index: 9999"]{display:none!important}</style></head><body>${body}</body></html>`,
  );
});
await new Promise<void>((r) => boardSrv.listen(0, '127.0.0.1', r));
const boardBase = `http://127.0.0.1:${(boardSrv.address() as { port: number }).port}`;

const adl = await startServer({ workspace: path.join(WF, 'workspace'), port: 4700, quiet: true });
const st = adl.service.projects.get(PROJECT);
if (!st) throw new Error(`project ${PROJECT} not found in ${WF}/workspace`);
const page = st.docs.pages.truth!;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ deviceScaleFactor: 1 });
const freeze = async (p: import('playwright-core').Page, shadow: boolean) =>
  p.evaluate(async (shadow) => {
    await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 4000))]);
    const root: Document | ShadowRoot = shadow ? document.getElementById('host')!.shadowRoot! : document;
    await Promise.race([
      Promise.all(
        [...root.querySelectorAll('img')].map((i) =>
          i.complete
            ? null
            : new Promise((r) => {
                i.onload = i.onerror = r;
              }),
        ),
      ),
      new Promise((r) => setTimeout(r, 4000)),
    ]);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    for (const a of root.getAnimations()) {
      a.pause();
      a.currentTime = 1200;
    }
    // animated images can't be paused: hide them in every render so they don't count
    for (const i of root.querySelectorAll('img')) (i as HTMLImageElement).style.visibility = 'hidden';
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, shadow);

function diff(a: Buffer, b: Buffer, name: string) {
  const A = PNG.sync.read(a);
  const B = PNG.sync.read(b);
  if (A.width !== B.width || A.height !== B.height)
    return { pct: 100, note: `size ${A.width}x${A.height} vs ${B.width}x${B.height}` };
  const r = 36;
  for (const P of [A, B])
    for (let y = 0; y < P.height; y++)
      for (let x = 0; x < P.width; x++) {
        const dx = x < r ? r - x : x >= P.width - r ? x - (P.width - r - 1) : 0;
        const dy = y < r ? r - y : y >= P.height - r ? y - (P.height - r - 1) : 0;
        if (dx && dy) {
          const k = (y * P.width + x) * 4;
          P.data[k] = P.data[k + 1] = P.data[k + 2] = 0;
          P.data[k + 3] = 255;
        }
      }
  const D = new PNG({ width: A.width, height: A.height });
  const n = pixelmatch(A.data, B.data, D.data, A.width, A.height, { threshold: 0.1 });
  const pct = (100 * n) / (A.width * A.height);
  if (pct >= 0.5) fs.writeFileSync(path.join(OUT, `${name}.diff.png`), PNG.sync.write(D));
  return { pct, note: '' };
}

const rows: { id: string; board: string; orig: number; shadow: number; note: string }[] = [];
const bySection = new Map<string, [string, { x: number; y: number }][]>();
for (const [id, it] of Object.entries(page.items)) {
  if (it.kind !== 'screen' || !it.parent || (only && !id.startsWith(only))) continue;
  if (!bySection.has(it.parent)) bySection.set(it.parent, []);
  bySection.get(it.parent)!.push([id, { x: it.x!, y: it.y! }]);
}
const t0 = Date.now();
for (const [section, screens] of bySection) {
  const bp = await ctx.newPage();
  const sec = page.items[section] as { w: number; h: number };
  await bp.setViewportSize({ width: Math.min(sec.w, 8000), height: Math.min(sec.h, 8000) });
  await bp.goto(`${boardBase}/${section}`, { waitUntil: 'domcontentloaded' });
  await freeze(bp, false);
  for (const [id, pos] of screens) {
    const size = adl.service.frameSize(st, id);
    const orig = await bp.screenshot({ clip: { x: pos.x, y: pos.y, width: size.w, height: size.h } });
    const sp = await ctx.newPage();
    await sp.setViewportSize({ width: size.w, height: size.h });
    await sp.goto(`${adl.url}/api/p/${PROJECT}/f/screens/${encodeURIComponent(id)}.html`, {
      waitUntil: 'domcontentloaded',
    });
    await freeze(sp, false);
    const stand = await sp.screenshot();
    await sp.goto(`${adl.url}/snap`);
    await sp.waitForFunction(() => (window as unknown as { adlSnap?: { ready: boolean } }).adlSnap?.ready);
    const hash = st.screens.get(id)!.compiled!.hash;
    await sp.evaluate(
      (a) => (window as unknown as { adlSnap: { render: (x: unknown) => Promise<unknown> } }).adlSnap.render(a),
      { pid: PROJECT, hash, w: size.w, h: size.h, at: 1200 },
    );
    await freeze(sp, true);
    const shadow = await sp.screenshot({ clip: { x: 0, y: 0, width: size.w, height: size.h } });
    await sp.close();
    const a = diff(orig, stand, `${id}-orig-vs-standalone`);
    const b = diff(stand, shadow, `${id}-standalone-vs-adl`);
    if (a.pct >= 0.5 || b.pct >= 0.5) {
      fs.writeFileSync(path.join(OUT, `${id}-orig.png`), orig);
      fs.writeFileSync(path.join(OUT, `${id}-standalone.png`), stand);
      fs.writeFileSync(path.join(OUT, `${id}-adl.png`), shadow);
    }
    rows.push({ id, board: section, orig: +a.pct.toFixed(3), shadow: +b.pct.toFixed(3), note: a.note || b.note });
  }
  await bp.close();
}
await browser.close();
await adl.close();
boardSrv.close();
const okOrig = rows.filter((r) => r.orig < 0.5).length;
const okShadow = rows.filter((r) => r.shadow < 0.5).length;
const bad = rows.filter((r) => r.orig >= 0.5 || r.shadow >= 0.5);
console.table(bad);
console.log(
  `screens ${rows.length} · original≈standalone ${okOrig}/${rows.length} · standalone≈ADL renderer ${okShadow}/${rows.length} · ${((Date.now() - t0) / 1000).toFixed(1)} s`,
);
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(rows, null, 1));
