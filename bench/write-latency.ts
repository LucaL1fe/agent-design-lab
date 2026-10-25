// Agent write → canvas latency: an agent writes a page file (banner text) or a screen file (HTML text) and we time
// until the open app shows it. Target: p95 ≤ 500 ms.  node bench/write-latency.ts [--runs 30]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { newPageDoc, newProjectDoc } from '../src/core/actions.ts';
import { stringifyPage, stringifyProject } from '../src/core/json.ts';
import { startServer } from '../src/node/server/server.ts';
import { SnapshotService } from '../src/node/snapshot/service.ts';

const runs = Number(process.argv[process.argv.indexOf('--runs') + 1] ?? 30) || 30;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adl-lat-'));
const pdir = path.join(root, 'demo');
fs.mkdirSync(path.join(pdir, 'pages'), { recursive: true });
fs.mkdirSync(path.join(pdir, 'screens'), { recursive: true });
fs.writeFileSync(path.join(pdir, 'project.json'), stringifyProject(newProjectDoc('Latency') as never));
const page = newPageDoc('Source of truth');
const ids = Array.from({ length: 12 }, (_, i) => `S${i + 1}`);
for (const [i, id] of ids.entries()) {
  page.items[id] = { kind: 'screen', x: (i % 6) * 520, y: Math.floor(i / 6) * 1100, status: 'new', banner: 'start' };
  fs.writeFileSync(
    path.join(pdir, 'screens', `${id}.html`),
    `<!doctype html><title>${id}</title><body style="margin:0;font:20px system-ui"><h1 id="t">${id} v0</h1></body>`,
  );
}
fs.writeFileSync(path.join(pdir, 'pages', 'truth.json'), stringifyPage(page as never));

const server = await startServer({ workspace: root, port: 4950, quiet: true });
const snaps = new SnapshotService(server);
server.snapshots = snaps;
await snaps.start();
await snaps.idle(60000);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const p = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await p.goto(`${server.url}/p/demo/truth`);
await p.waitForFunction(() => (window as any).__adl?.engine?.root.dataset.viewReady === 'truth');
// zoom so S1–S3 are live (real DOM) and the others are pictures
await p.evaluate(() => {
  const e = (window as any).__adl.engine;
  e.fit(['S1', 'S2'], false);
});
await p.waitForTimeout(1500);

const pct = (xs: number[], q: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]!;

// 1. page file: banner text of S1 (drawn by the app above the screen)
const bannerMs: number[] = [];
for (let i = 1; i <= runs; i++) {
  const text = `banner ${i}`;
  const doc = JSON.parse(fs.readFileSync(path.join(pdir, 'pages', 'truth.json'), 'utf8'));
  doc.items.S1.banner = text;
  const wait = p.waitForFunction(
    (t) => document.querySelector('.it.scr[data-id="S1"] .ban')?.textContent?.includes(t),
    text,
    { polling: 'raf', timeout: 5000 },
  );
  const t0 = performance.now();
  fs.writeFileSync(path.join(pdir, 'pages', 'truth.json'), JSON.stringify(doc, null, 2));
  await wait;
  bannerMs.push(performance.now() - t0);
  await p.waitForTimeout(250);
}

// 2. screen file: the heading text inside the live screen S1
const htmlMs: number[] = [];
for (let i = 1; i <= runs; i++) {
  const text = `S1 v${i}`;
  const wait = p.waitForFunction(
    (t) => {
      const host = document.querySelector('.it.scr[data-id="S1"] .host') as HTMLElement | null;
      return host?.shadowRoot?.textContent?.includes(t) ?? false;
    },
    text,
    { polling: 'raf', timeout: 5000 },
  );
  const t0 = performance.now();
  fs.writeFileSync(
    path.join(pdir, 'screens', 'S1.html'),
    `<!doctype html><title>S1</title><body style="margin:0;font:20px system-ui"><h1 id="t">${text}</h1></body>`,
  );
  await wait;
  htmlMs.push(performance.now() - t0);
  await p.waitForTimeout(250);
}

// 3. screen HTML of a screen shown as a still picture (zoomed out): time until the new picture is on screen
await p.evaluate(() => (window as any).__adl.engine.fitAll(false));
await p.waitForTimeout(1500);
const picMs: number[] = [];
for (let i = 1; i <= Math.min(runs, 10); i++) {
  const before = await p.evaluate(() => (window as any).__adl.engine.screens.get('S7')?.img?.src ?? '');
  const wait = p.waitForFunction(
    (b) => {
      const img = (window as any).__adl.engine.screens.get('S7')?.img as HTMLImageElement | undefined;
      return !!img && img.src !== b && img.complete && img.naturalWidth > 0;
    },
    before,
    { polling: 'raf', timeout: 10000 },
  );
  const t0 = performance.now();
  fs.writeFileSync(
    path.join(pdir, 'screens', 'S7.html'),
    `<!doctype html><title>S7</title><body style="margin:0;font:20px system-ui;background:hsl(${i * 30} 60% 80%)"><h1>S7 v${i}</h1></body>`,
  );
  await wait;
  picMs.push(performance.now() - t0);
  await p.waitForTimeout(300);
}

const fmt = (xs: number[]) =>
  `p50 ${Math.round(pct(xs, 0.5))} ms · p95 ${Math.round(pct(xs, 0.95))} ms · max ${Math.round(Math.max(...xs))} ms`;
console.log(`page file → banner on canvas (${runs} runs): ${fmt(bannerMs)}`);
console.log(`screen HTML → live screen updated (${runs} runs): ${fmt(htmlMs)}`);
console.log(`screen HTML → still picture updated (${picMs.length} runs): ${fmt(picMs)}`);
await browser.close();
await snaps.close();
await server.close();
fs.rmSync(root, { recursive: true, force: true });
process.exit(pct(bannerMs, 0.95) <= 500 && pct(htmlMs, 0.95) <= 500 ? 0 : 1);
