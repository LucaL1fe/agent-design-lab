// Still pictures of every screen, rendered by the user's installed Chrome (headless) through the same screenHost code
// the canvas uses. Cached by everything that can change the picture; visible screens first.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Browser, CDPSession, Page } from 'playwright-core';
import { PNG } from 'pngjs';
import { resolveFrame } from '../../core/frames.ts';
import type { SnapInfo } from '../../protocol/messages.ts';
import { sha } from '../fsutil.ts';
import type { RunningServer } from '../server/server.ts';
import type { ProjectState } from '../store/workspace.ts';

const RENDERER_VERSION = 5;
const WIDTHS = [64, 128, 256];
const MAX_W = 512;

interface Job {
  pid: string;
  hash: string;
  w: number;
  h: number | 'auto';
  key: string;
  prio: number;
  /** ms at which animations freeze: the screen's own adl:snapshot, else the project's snapshotAt. */
  at: number;
}

interface Index {
  v: number;
  snaps: Record<
    string,
    SnapInfo & {
      key: string;
      anchors?: Record<string, { x: number; y: number; w: number; h: number }>;
      overflow?: string[];
    }
  >;
}

export class SnapshotService {
  available = false;
  private browser?: Browser;
  private pages: { page: Page; cdp: CDPSession; busy: boolean }[] = [];
  private queue = new Map<string, Job>();
  private indexes = new Map<string, Index>();
  private focus = new Map<string, Set<string>>();
  private running = 0;
  private done = 0;
  private total = 0;
  private closed = false;
  private chromeMajor = '0';
  readonly server: RunningServer;
  concurrency = 6;

  constructor(server: RunningServer) {
    this.server = server;
  }

  /** Launch Chrome. `background: false` skips the warm pages and the snapshot queue (one-off renders from the CLI). */
  async start(opts: { background?: boolean } = {}): Promise<boolean> {
    const { chromium } = await import('playwright-core');
    const tries: (() => Promise<Browser>)[] = [];
    const exe = process.env.ADL_CHROME;
    if (exe) tries.push(() => chromium.launch({ executablePath: exe, headless: true }));
    tries.push(() => chromium.launch({ channel: 'chrome', headless: true }));
    for (const ch of ['chrome-beta', 'msedge', 'chromium'])
      tries.push(() => chromium.launch({ channel: ch, headless: true }));
    tries.push(() => chromium.launch({ headless: true }));
    for (const t of tries) {
      try {
        this.browser = await t();
        break;
      } catch {
        // next option
      }
    }
    if (!this.browser) return false;
    this.chromeMajor = this.browser.version().split('.')[0] ?? '0';
    if (opts.background === false) return true;
    const ctx = await this.browser.newContext({ deviceScaleFactor: 1, viewport: { width: 1600, height: 1200 } });
    for (let i = 0; i < this.concurrency; i++) {
      const page = await ctx.newPage();
      await page.goto(`${this.server.url}/snap`);
      await page.waitForFunction(
        () => (globalThis as unknown as { adlSnap?: { ready: boolean } }).adlSnap?.ready === true,
        undefined,
        { timeout: 30000 },
      );
      const cdp = await ctx.newCDPSession(page);
      this.pages.push({ page, cdp, busy: false });
    }
    this.available = true;
    this.server.service.on('screens', (e: { pid: string }) => this.enqueueProject(e.pid));
    this.server.service.on('tx', (e: { pid: string; ops: { path: readonly string[] }[] }) => {
      if (
        e.ops.some(
          (o) =>
            o.path.includes('frame') || o.path[0] === 'frame' || o.path[0] === 'snapshotAt' || o.path[0] === 'presets',
        )
      )
        this.enqueueProject(e.pid);
    });
    for (const pid of this.server.service.projects.keys()) this.enqueueProject(pid);
    return true;
  }

  private dir(st: ProjectState) {
    return path.join(st.adl, 'cache', 'snap');
  }

  private index(st: ProjectState): Index {
    let ix = this.indexes.get(st.id);
    if (!ix) {
      try {
        ix = JSON.parse(fs.readFileSync(path.join(this.dir(st), 'index.json'), 'utf8')) as Index;
        if (ix.v !== RENDERER_VERSION) ix = { v: RENDERER_VERSION, snaps: {} };
      } catch {
        ix = { v: RENDERER_VERSION, snaps: {} };
      }
      this.indexes.set(st.id, ix);
    }
    return ix;
  }

  private saveIndexSoon = new Map<string, NodeJS.Timeout>();
  private saveIndex(st: ProjectState) {
    const t = this.saveIndexSoon.get(st.id);
    if (t) clearTimeout(t);
    this.saveIndexSoon.set(
      st.id,
      setTimeout(() => {
        const ix = this.index(st);
        fsp
          .mkdir(this.dir(st), { recursive: true })
          .then(() => fsp.writeFile(path.join(this.dir(st), 'index.json'), JSON.stringify(ix)))
          .catch(() => undefined);
      }, 300),
    );
  }

  /** "<hash>@<w>x<h>" → snapshot info, for everything already rendered. */
  snapsFor(pid: string): Record<string, SnapInfo> {
    const st = this.server.service.projects.get(pid);
    if (!st) return {};
    const out: Record<string, SnapInfo> = {};
    for (const [k, v] of Object.entries(this.index(st).snaps))
      out[k] = { url: v.url, w: v.w, h: v.h, ...(v.avg ? { avg: v.avg } : {}) };
    return out;
  }

  anchorsFor(pid: string, snapKey: string) {
    const st = this.server.service.projects.get(pid);
    return st ? this.index(st).snaps[snapKey]?.anchors : undefined;
  }

  setFocus(pid: string, visible: string[]) {
    this.focus.set(pid, new Set(visible));
    for (const j of this.queue.values()) if (j.pid === pid) j.prio = this.prioOf(j.pid, j.hash);
  }

  private prioOf(pid: string, hash: string): number {
    const st = this.server.service.projects.get(pid);
    const vis = this.focus.get(pid);
    if (!st || !vis) return 1;
    for (const id of vis) if (st.screens.get(id)?.compiled?.hash === hash) return 10;
    return 1;
  }

  /** When a screen's still pictures freeze its animations: its own adl:snapshot, else the project's snapshotAt. */
  atFor(st: ProjectState, hash: string): number {
    const own = [...st.screens.values()].find((e) => e.compiled?.hash === hash)?.compiled?.snapshotAt;
    return own ?? st.docs.project.snapshotAt ?? 1200;
  }

  /** The frames each screen is placed at, across all pages. */
  private framesOf(st: ProjectState): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    const add = (hash: string, f: string) => {
      if (!out.has(hash)) out.set(hash, new Set());
      out.get(hash)!.add(f);
    };
    for (const e of st.screens.values()) {
      if (!e.compiled) continue;
      add(e.compiled.hash, e.compiled.frame ?? '');
    }
    for (const page of Object.values(st.docs.pages)) {
      for (const [id, it] of Object.entries(page.items)) {
        if (it.kind !== 'screen' || !it.frame) continue;
        const sid = it.screen ?? id;
        const c = st.screens.get(sid)?.compiled;
        if (c) add(c.hash, it.frame);
      }
    }
    return out;
  }

  snapKeyFor(
    st: ProjectState,
    hash: string,
    frame: string,
  ): { key: string; w: number; h: number | 'auto' } | undefined {
    const f = resolveFrame(frame || undefined, st.docs.project) ?? resolveFrame(undefined, st.docs.project);
    if (!f) return undefined;
    return { key: `${hash}@${f.w}x${f.h}`, w: f.w, h: f.h };
  }

  enqueueProject(pid: string) {
    const st = this.server.service.projects.get(pid);
    if (!st || !this.available) return;
    const ix = this.index(st);
    for (const [hash, frames] of this.framesOf(st)) {
      const at = this.atFor(st, hash);
      for (const fr of frames) {
        const k = this.snapKeyFor(st, hash, fr);
        if (!k) continue;
        const e = st.screens.get([...st.screens.values()].find((s) => s.compiled?.hash === hash)?.id ?? '')?.compiled;
        const depKey = e ? e.deps.map((d) => this.server.service.fileHash(st, d) ?? '-').join(',') : '';
        const cacheKey = sha(`${RENDERER_VERSION}|${this.chromeMajor}|${k.key}|${at}|${depKey}`);
        if (ix.snaps[k.key]?.key === cacheKey) continue;
        this.queue.set(`${pid}|${k.key}`, {
          pid,
          hash,
          w: k.w,
          h: k.h,
          key: cacheKey,
          prio: this.prioOf(pid, hash),
          at,
        });
      }
    }
    this.total = this.done + this.queue.size + this.running;
    this.pump();
  }

  private pump() {
    if (this.closed) return;
    for (const slot of this.pages) {
      if (slot.busy || !this.queue.size) continue;
      let best: [string, Job] | undefined;
      for (const e of this.queue) if (!best || e[1].prio > best[1].prio) best = e;
      if (!best) break;
      this.queue.delete(best[0]);
      slot.busy = true;
      this.running++;
      this.renderOne(slot, best[1])
        .catch(() => undefined)
        .finally(() => {
          slot.busy = false;
          this.running--;
          this.done++;
          this.progress();
          this.pump();
        });
    }
  }

  private lastProgress = 0;
  private progress() {
    const now = Date.now();
    const finished = !this.queue.size && !this.running;
    if (!finished && now - this.lastProgress < 250) return;
    this.lastProgress = now;
    for (const pid of this.server.service.projects.keys())
      this.server.broadcast({ t: 'snapProgress', pid, done: this.done, total: this.total, running: !finished });
    if (finished) {
      this.done = 0;
      this.total = 0;
    }
  }

  private async renderOne(slot: { page: Page; cdp: CDPSession }, job: Job) {
    const st = this.server.service.projects.get(job.pid);
    if (!st) return;
    const at = job.at;
    const r = (await slot.page.evaluate(
      (a) => (globalThis as unknown as { adlSnap: { render: (x: unknown) => Promise<unknown> } }).adlSnap.render(a),
      {
        pid: job.pid,
        hash: job.hash,
        w: job.w,
        h: job.h,
        at,
      },
    )) as {
      w: number;
      h: number;
      anchors: Record<string, { x: number; y: number; w: number; h: number }>;
      overflow: string[];
    };
    const shot = (await slot.cdp.send('Page.captureScreenshot', {
      format: 'webp',
      quality: 90,
      clip: { x: 0, y: 0, width: r.w, height: r.h, scale: 1 },
      captureBeyondViewport: true,
    })) as { data: string };
    const sizes = (await slot.page.evaluate(
      ([d, w]) =>
        (globalThis as unknown as { adlSnap: { resize: (a: string, b: number[]) => Promise<unknown> } }).adlSnap.resize(
          d,
          w,
        ),
      [`data:image/webp;base64,${shot.data}`, WIDTHS] as const,
    )) as { w: number; data: string; avg: string }[];
    const dir = this.dir(st);
    const name = `${job.hash}-${job.w}x${job.h}-${job.key.slice(0, 8)}`;
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${name}-512.webp`), Buffer.from(shot.data, 'base64'));
    for (const s of sizes) await fsp.writeFile(path.join(dir, `${name}-${s.w}.webp`), Buffer.from(s.data, 'base64'));
    const ix = this.index(st);
    const snapKey = `${job.hash}@${job.w}x${job.h}`;
    const old = ix.snaps[snapKey];
    const info = {
      url: `/api/p/${encodeURIComponent(st.id)}/snap/${name}`,
      w: r.w,
      h: r.h,
      avg: sizes[0]?.avg ?? '#222',
      key: job.key,
      anchors: r.anchors,
      overflow: r.overflow,
    };
    ix.snaps[snapKey] = info;
    this.saveIndex(st);
    if (old && old.url !== info.url) {
      const oldBase = old.url.split('/').pop();
      for (const sfx of ['512', ...WIDTHS.map(String)])
        fsp.rm(path.join(dir, `${oldBase}-${sfx}.webp`)).catch(() => undefined);
    }
    if (job.h === 'auto') this.server.service.setAutoHeight(st.id, job.hash, r.h);
    this.server.broadcast({
      t: 'snap',
      pid: st.id,
      hash: snapKey,
      snap: { url: info.url, w: info.w, h: info.h, avg: info.avg },
    });
  }

  /** Wait until nothing is queued (CLI render, tests). */
  async idle(timeout = 120000): Promise<void> {
    const t0 = Date.now();
    while (this.queue.size || this.running) {
      if (Date.now() - t0 > timeout) throw new Error('snapshots did not finish in time');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Render one screen right now at any scale and return PNG bytes (adl render, handoff). */
  /** A fresh page in its own context (closed afterwards). */
  async withPage<T>(
    opts: { width: number; height: number; scale?: number },
    fn: (page: Page) => Promise<T>,
  ): Promise<T> {
    if (!this.browser) throw new Error('Rendering needs Google Chrome, and it was not found. Run `adl doctor`.');
    const ctx = await this.browser.newContext({
      deviceScaleFactor: opts.scale ?? 1,
      viewport: { width: Math.round(opts.width), height: Math.round(opts.height) },
    });
    try {
      return await fn(await ctx.newPage());
    } finally {
      await ctx.close();
    }
  }

  async renderPng(
    pid: string,
    hash: string,
    frame: string | undefined,
    opts: { scale?: number; at?: number } = {},
  ): Promise<{ png: Buffer; w: number; h: number; overflow: string[]; outside: string[]; tall: number }> {
    const st = this.server.service.projects.get(pid);
    if (!st || !this.browser) throw new Error('Snapshots are not available (Chrome not found)');
    // no frame on the page item: the screen's own <meta name="adl:frame">, then the project's
    const own = [...st.screens.values()].find((e) => e.compiled?.hash === hash)?.compiled?.frame;
    const k = this.snapKeyFor(st, hash, frame ?? own ?? '');
    if (!k) throw new Error('unknown frame');
    const scale = opts.scale ?? 2;
    const VH = 1200;
    const ctx = await this.browser.newContext({
      deviceScaleFactor: scale,
      viewport: { width: Math.max(k.w, 400), height: VH },
    });
    try {
      const page = await ctx.newPage();
      await page.goto(`${this.server.url}/snap`);
      await page.waitForFunction(
        () => (globalThis as unknown as { adlSnap?: { ready: boolean } }).adlSnap?.ready === true,
      );
      const r = (await page.evaluate(
        (a) => (globalThis as unknown as { adlSnap: { render: (x: unknown) => Promise<unknown> } }).adlSnap.render(a),
        { pid, hash, w: k.w, h: k.h, at: opts.at ?? this.atFor(st, hash) },
      )) as { w: number; h: number; overflow?: string[]; outside?: string[]; tall?: number };
      // tall screens (full-length pages, boards) are taken in window-high tiles and stitched: growing the window
      // after the screen was drawn painted a copy of its top over the last ~87 px, and one capture beyond the
      // window came out as repeated, zoomed-in tiles (a 390x1333 screen at 2x)
      const H = Math.ceil(r.h);
      let png: Buffer;
      if (H <= VH) png = await page.screenshot({ clip: { x: 0, y: 0, width: r.w, height: r.h }, type: 'png' });
      else {
        const out = new PNG({ width: Math.round(r.w * scale), height: H * scale });
        for (let oy = 0; oy < H; oy += VH) {
          await page.evaluate((y) => {
            const g = globalThis as unknown as {
              document: { getElementById(id: string): { style: { top: string } } };
              requestAnimationFrame(f: () => void): void;
            };
            g.document.getElementById('host').style.top = `${-y}px`;
            return new Promise<void>((done) => g.requestAnimationFrame(() => g.requestAnimationFrame(done)));
          }, oy);
          const th = Math.min(VH, H - oy);
          const tile = PNG.sync.read(
            await page.screenshot({ clip: { x: 0, y: 0, width: r.w, height: th }, type: 'png' }),
          );
          PNG.bitblt(
            tile,
            out,
            0,
            0,
            Math.min(tile.width, out.width),
            Math.min(tile.height, th * scale),
            0,
            oy * scale,
          );
        }
        png = PNG.sync.write(out);
      }
      return { png, w: r.w, h: r.h, overflow: r.overflow ?? [], outside: r.outside ?? [], tall: r.tall ?? 0 };
    } finally {
      await ctx.close();
    }
  }

  async close() {
    this.closed = true;
    this.available = false;
    await this.browser?.close().catch(() => undefined);
  }
}
