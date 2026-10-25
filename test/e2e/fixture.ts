// A small generic project for end-to-end tests, written to a temp folder, plus a running server and a browser page.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Browser, chromium, type Page } from 'playwright-core';
import { newPageDoc, newProjectDoc } from '../../src/core/actions.ts';
import { stringifyPage, stringifyProject } from '../../src/core/json.ts';
import type { PageDoc } from '../../src/core/types.ts';
import { type RunningServer, startServer } from '../../src/node/server/server.ts';
import { SnapshotService } from '../../src/node/snapshot/service.ts';

export const SCREEN = (
  title: string,
  color: string,
  extra = '',
) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="../styles/app.css"></head><body><main class="screen" style="background:${color}"><h1>${title}</h1><button class="btn" data-adl-anchor="next">Next</button>${extra}</main></body></html>`;

export function writeDemo(root: string) {
  const p = path.join(root, 'demo');
  for (const d of ['pages', 'screens', 'styles']) fs.mkdirSync(path.join(p, d), { recursive: true });
  fs.writeFileSync(
    path.join(p, 'styles', 'app.css'),
    'html{background:#111}body{margin:0;font:16px system-ui;color:#fff}.screen{height:100cqh;padding:60px 24px;box-sizing:border-box}.btn{margin-top:20px;padding:14px 20px;border-radius:12px;background:#4d8eff;color:#fff;border:0;font-weight:700}@keyframes spin{to{transform:rotate(1turn)}}.spin{animation:spin 1s linear infinite}',
  );
  const colors = ['#1d2b4f', '#3b1d4f', '#1d4f3a', '#4f3b1d', '#4f1d2b', '#2b2b2b'];
  for (const [i, id] of ['A1', 'A2', 'A3', 'B1', 'B2', 'B3'].entries())
    fs.writeFileSync(
      path.join(p, 'screens', `${id}.html`),
      SCREEN(
        `Screen ${id}`,
        colors[i]!,
        i === 0 ? '<div class="spin" style="width:40px;height:40px;background:#fff;margin:30px"></div>' : '',
      ),
    );
  const project = { ...newProjectDoc('Demo app'), frame: '390x844' };
  const page: PageDoc = newPageDoc('Source of truth');
  page.items = {
    'sec-a': { kind: 'section', title: 'FLOW · Sign up', x: 0, y: 0, w: 1900, h: 1150 },
    A1: { kind: 'screen', parent: 'sec-a', x: 64, y: 150, status: 'new', banner: 'first draft' },
    A2: { kind: 'screen', parent: 'sec-a', x: 734, y: 150, status: 'approved' },
    A3: { kind: 'screen', parent: 'sec-a', x: 1404, y: 150, status: 'to-decide', banner: 'which colour?' },
    'sec-b': { kind: 'section', title: 'FLOW · Library', x: 0, y: 1500, w: 1900, h: 1150 },
    B1: { kind: 'screen', parent: 'sec-b', x: 64, y: 150 },
    B2: { kind: 'screen', parent: 'sec-b', x: 734, y: 150, status: 'needs-fix', banner: 'wrong font' },
    B3: { kind: 'screen', parent: 'sec-b', x: 1404, y: 150, proposalFor: 'B2', status: 'new', banner: 'option A' },
    n1: { kind: 'note', x: 2100, y: 100, w: 300, text: 'Check the empty state', color: 'yellow', by: 'human' },
  };
  page.arrows = {
    'A1>A2': { from: 'A1', to: 'A2', label: 'taps Next' },
    'A2>A3': { from: 'A2', to: 'A3', label: '3 s later' },
    'B1>B2': { from: 'B1', to: 'B2', label: 'opens' },
    'B2>B3': { from: 'B2', to: 'B3', label: 'option A', style: 'proposal' },
  };
  fs.writeFileSync(path.join(p, 'project.json'), stringifyProject(project as never));
  fs.writeFileSync(path.join(p, 'pages', 'truth.json'), stringifyPage(page as never));
  return p;
}

export interface Harness {
  root: string;
  pdir: string;
  server: RunningServer;
  browser: Browser;
  page: Page;
  errors: string[];
  readPage: () => PageDoc;
  close: () => Promise<void>;
}

let port = 5100;
export async function harness(
  opts: { snapshots?: boolean; viewport?: { width: number; height: number } } = {},
): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adl-e2e-'));
  const pdir = writeDemo(root);
  const server = await startServer({ workspace: root, port: port++, quiet: true });
  server.service.writeDelay = 30;
  server.service.minWriteGap = 0;
  if (opts.snapshots) {
    const snaps = new SnapshotService(server);
    server.snapshots = snaps;
    await snaps.start();
    await snaps.idle();
  }
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: opts.viewport ?? { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  return {
    root,
    pdir,
    server,
    browser,
    page,
    errors,
    readPage: () => JSON.parse(fs.readFileSync(path.join(pdir, 'pages', 'truth.json'), 'utf8')),
    close: async () => {
      await browser.close();
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Open the demo project and wait until the canvas has drawn. */
export async function openDemo(h: Harness) {
  await h.page.goto(`${h.server.url}/p/demo/truth`);
  await h.page.waitForFunction(
    () => (window as any).__adl?.engine?.stats.frames > 1 && (window as any).__adl.engine.root.dataset.viewReady,
  );
}

export async function fitAndWait(h: Harness, ids: string[]) {
  await h.page.evaluate((ids) => (window as any).__adl.engine.fit(ids, false), ids);
  await h.page.waitForTimeout(400);
}

/** Screen-space centre of an item. */
export async function centerOf(h: Harness, id: string): Promise<[number, number]> {
  return h.page.evaluate((id) => {
    const e = (window as any).__adl.engine;
    const r = e.rects.get(id);
    const [x, y] = e.vp.toScreen(r.x + r.w / 2, r.y + r.h / 2);
    const b = e.root.getBoundingClientRect();
    return [x + b.left, y + b.top] as [number, number];
  }, id);
}

export async function until(fn: () => boolean | Promise<boolean>, ms = 5000) {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 30));
  }
}
