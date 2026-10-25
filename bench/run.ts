// Performance bench. Headless Chrome on macOS renders with the real GPU at ~60 Hz, so frame timings are real.
// node bench/run.ts <workspace> <project-id> [--cold] [--runs 3]
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { startServer } from '../src/node/server/server.ts';
import { SnapshotService } from '../src/node/snapshot/service.ts';

const [wsArg, pid] = process.argv.slice(2);
const cold = process.argv.includes('--cold');
const runs = Number(process.argv[process.argv.indexOf('--runs') + 1] ?? 3) || 3;
if (!wsArg || !pid) throw new Error('usage: node bench/run.ts <workspace> <project-id> [--cold] [--runs 3]');
const ws = path.resolve(wsArg);
if (cold) fs.rmSync(path.join(ws, pid, '.adl', 'cache'), { recursive: true, force: true });

const server = await startServer({ workspace: ws, port: 4900, quiet: true, ephemeral: true });
const snaps = new SnapshotService(server);
server.snapshots = snaps;
const t0 = Date.now();
await snaps.start();
await snaps.idle(900000);
const snapSeconds = (Date.now() - t0) / 1000;
const nScreens = server.service.projects.get(pid)!.screens.size;

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

async function chromeRssMb(_page: Page): Promise<number> {
  const cdp = await browser.newBrowserCDPSession();
  const info = (await cdp.send('SystemInfo.getProcessInfo')) as { processInfo: { id: number }[] };
  const pids = info.processInfo.map((p) => p.id).filter(Boolean);
  await cdp.detach();
  if (!pids.length) return 0;
  const out = execSync(`ps -o rss= -p ${pids.join(',')}`).toString();
  return Math.round(
    out
      .split('\n')
      .filter(Boolean)
      .reduce((a, l) => a + Number(l.trim()), 0) / 1024,
  );
}

const scenario = (name: string, body: string) => ({ name, body });
const SCENARIOS = [
  scenario('idle fit-all', `e.fitAll(false); await sleep(400); return measure(3000, () => {});`),
  scenario(
    'zoom sweep fit→100%→fit',
    `e.fitAll(false); await sleep(300); const r = busiest(); const cx = r.x + 600, cy = r.y + 600; const W = innerWidth, H = innerHeight; const k0 = e.vp.v.k;
     return measure(4000, (p) => { const k = Math.exp(Math.log(k0) + (Math.log(1) - Math.log(k0)) * Math.sin(p*Math.PI)); e.vp.v = { k, x: W/2 - cx*k, y: H/2 - cy*k }; e.vp.changed(true); });`,
  ),
  scenario(
    'pan at 50% (pictures)',
    `const r = busiest(); const k = 0.5; e.vp.set({ k, x: -r.x*k + 40, y: -(r.y + 80)*k }); await sleep(1500);
     const x0 = e.vp.v.x; return measure(3000, (p) => { e.vp.v = { ...e.vp.v, x: x0 - p*Math.min(6000, r.w)*k }; e.vp.changed(true); });`,
  ),
  scenario(
    'pan at 70% (live screens)',
    `const r = busiest(); const k = 0.7; e.vp.set({ k, x: -r.x*k + 40, y: -(r.y + 80)*k }); await sleep(2500);
     const x0 = e.vp.v.x; return measure(3000, (p) => { e.vp.v = { ...e.vp.v, x: x0 - Math.sin(p*Math.PI)*900 }; e.vp.changed(true); });`,
  ),
  scenario(
    'pan at fit-all',
    `e.fitAll(false); await sleep(300); const x0 = e.vp.v.x; return measure(3000, (p) => { e.vp.v = { ...e.vp.v, x: x0 - Math.sin(p*Math.PI*2)*400 }; e.vp.changed(true); });`,
  ),
  scenario(
    'idle at 100% (live screens)',
    `const r = busiest(); e.vp.set({ k: 1, x: -(r.x + 20), y: -(r.y + 60) }); await sleep(3000); return measure(4000, () => {});`,
  ),
];

const PRELUDE = `
const e = window.__adl.engine;
function busiest() {
  const p = e.page; const counts = {};
  for (const [id, it] of Object.entries(p.items)) if (it.kind === 'screen' && it.parent) counts[it.parent] = (counts[it.parent] || 0) + 1;
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  return e.rects.get(best);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function measure(ms, step) {
  const deltas = []; let last = performance.now(); let longs = 0; let longMax = 0;
  const po = new PerformanceObserver((l) => { for (const x of l.getEntries()) { if (x.duration >= 50) longs++; longMax = Math.max(longMax, x.duration); } });
  try { po.observe({ type: 'long-animation-frame', buffered: false }); } catch {}
  const t0 = performance.now();
  await new Promise((res) => { const f = () => { const now = performance.now(); deltas.push(now - last); last = now; const p = (now - t0) / ms; step(Math.min(1, p)); if (p < 1) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
  po.disconnect(); deltas.shift();
  const s = [...deltas].sort((a, b) => a - b);
  const dropped = deltas.reduce((n, d) => n + Math.max(0, Math.round(d / 16.67) - 1), 0);
  return { frames: deltas.length, droppedPct: +(100 * dropped / (deltas.length + dropped)).toFixed(2), p95: +s[Math.floor(s.length * 0.95)].toFixed(1), max: +s[s.length - 1].toFixed(1), longFrames: longs, longMax: Math.round(longMax), live: e.stats.live, pictures: e.stats.pictures, mosaic: e.stats.mosaic };
}`;

const results: Record<string, unknown[]> = {};
{
  const blank = await ctx.newPage();
  await blank.goto(`${server.url}/api/health`);
  (results['chrome memory baseline MB'] ??= []).push(await chromeRssMb(blank));
  await blank.close();
}
for (let r = 0; r < runs; r++) {
  const page = await ctx.newPage();
  const nav = Date.now();
  await page.goto(`${server.url}/p/${encodeURIComponent(pid)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => performance.getEntriesByName('adl:first-content').length > 0, undefined, {
    timeout: 30000,
  });
  const firstContent = await page.evaluate(() =>
    Math.round(performance.getEntriesByName('adl:first-content')[0]!.startTime),
  );
  // overview complete: every far screen drawn from its picture
  try {
    await page.waitForFunction(
      () => {
        const e = (window as any).__adl?.engine;
        return e && e.stats.frames > 2 && e.stats.mosaicMissing === 0;
      },
      undefined,
      { timeout: 20000, polling: 50 },
    );
  } catch (err) {
    console.error(
      'overview did not complete',
      await page.evaluate(() => {
        const e = (window as any).__adl?.engine;
        return e ? { stats: e.stats, v: e.vp.v, snaps: Object.keys(e.model.snaps).length } : 'no engine';
      }),
    );
    throw err;
  }
  const overviewMs = Date.now() - nav;
  (results['open: first content ms'] ??= []).push(firstContent);
  (results['open: overview complete ms'] ??= []).push(overviewMs);
  for (const s of SCENARIOS) {
    const res = await page.evaluate(`(async () => { ${PRELUDE}\n ${s.body} })()`);
    (results[s.name] ??= []).push(res);
  }
  (results['chrome memory MB'] ??= []).push(await chromeRssMb(page));
  (results['js heap MB'] ??= []).push(
    await page.evaluate(() => Math.round(((performance as any).memory?.usedJSHeapSize ?? 0) / 1e6)),
  );
  await page.close();
}
await browser.close();
await server.close();

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
const summary: Record<string, unknown> = {
  project: pid,
  screens: nScreens,
  snapshotsSeconds: +snapSeconds.toFixed(1),
  runs,
};
for (const [k, v] of Object.entries(results)) {
  if (typeof v[0] === 'number') summary[k] = median(v as number[]);
  else {
    const rows = v as Record<string, number>[];
    const keys = Object.keys(rows[0]!);
    summary[k] = Object.fromEntries(keys.map((kk) => [kk, median(rows.map((x) => x[kk]!))]));
  }
}
console.log(JSON.stringify(summary, null, 2));
fs.mkdirSync(path.join(import.meta.dirname, 'results'), { recursive: true });
fs.writeFileSync(
  path.join(
    import.meta.dirname,
    'results',
    `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${pid}.json`,
  ),
  JSON.stringify({ summary, results }, null, 2),
);
