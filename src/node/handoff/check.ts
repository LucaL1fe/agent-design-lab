// `adl handoff check`: compare the built app with the handoff. Per screen: a picture at the same size and moment as
// the reference (structural similarity + changed pixels + a side-by-side sheet) and the copy; per transition: tap the
// anchored element and see that the right screen comes next.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import type { Browser, Page } from 'playwright-core';
import { PNG } from 'pngjs';
import type { Id } from '../../core/types.ts';
import type { Spec } from './handoff.ts';
import { ssim } from './ssim.ts';

// browser-side code in page.evaluate (the node build has no DOM types)
// biome-ignore lint/suspicious/noExplicitAny: see above
type Win = any;

export type Step = { click: string } | { wait: number } | { fill: [string, string] } | { press: string };

export interface RouteDef {
  path?: string;
  url?: string;
  /** Steps after loading, before the picture (open a sheet, fill a field …). */
  setup?: Step[];
  /** A selector that exists only on this screen (tells transitions apart when the URL does not change). */
  match?: string;
}

export interface Routes {
  baseUrl: string;
  screens: Record<Id, RouteDef>;
}

export interface ScreenResult {
  id: Id;
  ok: boolean;
  ssim?: number;
  changed?: number;
  missing: string[];
  sheet?: string;
  error?: string;
}

export interface TransitionResult {
  from: Id;
  to: Id;
  label: string;
  result: 'pass' | 'fail' | 'skipped';
  why?: string;
}

export interface CheckReport {
  ok: boolean;
  threshold: number;
  screens: ScreenResult[];
  transitions: TransitionResult[];
  noRoute: Id[];
}

const urlOf = (routes: Routes, r: RouteDef) => r.url ?? new URL(r.path ?? '/', routes.baseUrl).toString();
const normText = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

async function open(page: Page, routes: Routes, r: RouteDef) {
  await page.goto(urlOf(routes, r), { waitUntil: 'load', timeout: 20000 });
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
  for (const s of r.setup ?? []) {
    if ('click' in s) await page.locator(s.click).first().click({ timeout: 5000 });
    else if ('fill' in s) await page.locator(s.fill[0]).first().fill(s.fill[1], { timeout: 5000 });
    else if ('press' in s) await page.keyboard.press(s.press);
    else if ('wait' in s) await page.waitForTimeout(s.wait);
  }
  if (r.match) await page.locator(r.match).first().waitFor({ timeout: 5000 });
  await page.evaluate(() => (globalThis as Win).document.fonts?.ready);
}

/** Freeze every animation at `at` ms, like the reference pictures. */
async function freeze(page: Page, at: number) {
  await page.waitForTimeout(Math.min(at, 1500));
  await page.evaluate((t) => {
    for (const a of (globalThis as Win).document.getAnimations()) {
      a.pause();
      a.currentTime = t;
    }
  }, at);
  await page.waitForTimeout(50);
}

function sheet(ref: PNG, got: PNG, diff: PNG): PNG {
  const gap = 24;
  const w = ref.width * 3 + gap * 2;
  const h = Math.max(ref.height, got.height);
  const out = new PNG({ width: w, height: h });
  out.data.fill(0x1b);
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = 255;
  PNG.bitblt(ref, out, 0, 0, ref.width, ref.height, 0, 0);
  PNG.bitblt(got, out, 0, 0, Math.min(got.width, ref.width), got.height, ref.width + gap, 0);
  PNG.bitblt(diff, out, 0, 0, diff.width, diff.height, (ref.width + gap) * 2, 0);
  return out;
}

/** The built picture cropped or padded (white) to the reference size, so both can be compared. */
function fitTo(got: PNG, w: number, h: number): PNG {
  if (got.width === w && got.height === h) return got;
  const out = new PNG({ width: w, height: h });
  out.data.fill(255);
  PNG.bitblt(got, out, 0, 0, Math.min(w, got.width), Math.min(h, got.height), 0, 0);
  return out;
}

export async function runCheck(
  browser: Browser,
  spec: Spec,
  routes: Routes,
  dir: string,
  opts: { threshold?: number; only?: Id[] } = {},
): Promise<CheckReport> {
  const threshold = opts.threshold ?? 0.92;
  const outDir = path.join(dir, 'check');
  await fsp.rm(outDir, { recursive: true, force: true });
  await fsp.mkdir(outDir, { recursive: true });
  const screens: ScreenResult[] = [];
  const noRoute: Id[] = [];
  const wanted = spec.screens.filter((s) => !opts.only?.length || opts.only.includes(s.id));
  for (const s of wanted) {
    const r = routes.screens[s.id];
    if (!r) {
      noRoute.push(s.id);
      continue;
    }
    const refFile = path.join(dir, s.png);
    if (!fs.existsSync(refFile)) {
      screens.push({ id: s.id, ok: false, missing: [], error: `no reference picture ${s.png}` });
      continue;
    }
    const ref = PNG.sync.read(fs.readFileSync(refFile));
    const vh = s.frame.h === 'auto' ? 900 : s.frame.h;
    const ctx = await browser.newContext({ viewport: { width: s.frame.w, height: vh }, deviceScaleFactor: 2 });
    try {
      const page = await ctx.newPage();
      await open(page, routes, r);
      await freeze(page, s.snapshotAt ?? spec.snapshotAt);
      const buf = await page.screenshot({ type: 'png', fullPage: s.frame.h === 'auto' });
      const got = fitTo(PNG.sync.read(buf), ref.width, ref.height);
      const diff = new PNG({ width: ref.width, height: ref.height });
      const changed = pixelmatch(ref.data, got.data, diff.data, ref.width, ref.height, { threshold: 0.12 });
      const score = ssim(ref, got);
      const text = normText(
        await page.evaluate(() => ((globalThis as Win).document.body?.innerText as string | undefined) ?? ''),
      );
      const missing = s.strings.filter((t) => t.trim().length > 1 && !text.includes(normText(t)));
      const sheetFile = path.join(outDir, `${s.id}.png`);
      await fsp.writeFile(sheetFile, PNG.sync.write(sheet(ref, PNG.sync.read(buf), diff)));
      screens.push({
        id: s.id,
        ok: score >= threshold && missing.length === 0,
        ssim: Math.round(score * 1000) / 1000,
        changed: Math.round((changed / (ref.width * ref.height)) * 1000) / 10,
        missing,
        sheet: path.relative(dir, sheetFile),
      });
    } catch (e) {
      screens.push({ id: s.id, ok: false, missing: [], error: (e as Error).message.split('\n')[0] ?? 'error' });
    } finally {
      await ctx.close();
    }
  }

  const transitions: TransitionResult[] = [];
  for (const s of wanted) {
    for (const t of s.transitions.filter((x) => x.included)) {
      const base: TransitionResult = { from: s.id, to: t.to, label: t.label, result: 'skipped' };
      const from = routes.screens[s.id];
      const to = routes.screens[t.to];
      const tr = t.trigger;
      if (!from || !to) {
        transitions.push({ ...base, why: 'no route for one of the screens' });
        continue;
      }
      if (!tr || (tr.on !== 'tap' && tr.on !== 'auto') || (tr.on === 'tap' && !tr.el)) {
        transitions.push({ ...base, why: tr ? `"${tr.on}" triggers are checked by hand` : 'no trigger in the design' });
        continue;
      }
      const ctx = await browser.newContext({
        viewport: { width: s.frame.w, height: s.frame.h === 'auto' ? 900 : s.frame.h },
      });
      try {
        const page = await ctx.newPage();
        await open(page, routes, from);
        if (tr.on === 'tap') await page.locator(`[data-adl-anchor="${tr.el}"]`).first().click({ timeout: 4000 });
        const target = new URL(urlOf(routes, to));
        const arrived = async () =>
          to.match
            ? (await page.locator(to.match).count()) > 0
            : new URL(page.url()).pathname === target.pathname &&
              (!target.hash || new URL(page.url()).hash === target.hash);
        const deadline = Date.now() + (tr.on === 'auto' ? (tr.after ?? 0) + 3000 : 3000);
        let ok = await arrived();
        while (!ok && Date.now() < deadline) {
          await page.waitForTimeout(100);
          ok = await arrived();
        }
        transitions.push({
          ...base,
          result: ok ? 'pass' : 'fail',
          ...(ok ? {} : { why: `still on ${new URL(page.url()).pathname}` }),
        });
      } catch (e) {
        transitions.push({ ...base, result: 'fail', why: (e as Error).message.split('\n')[0] ?? 'error' });
      } finally {
        await ctx.close();
      }
    }
  }
  const ok = noRoute.length === 0 && screens.every((x) => x.ok) && transitions.every((x) => x.result !== 'fail');
  const report: CheckReport = { ok, threshold, screens, transitions, noRoute };
  await fsp.writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await fsp.writeFile(path.join(outDir, 'report.md'), reportMarkdown(report));
  return report;
}

export function reportMarkdown(r: CheckReport): string {
  const L = [`# Handoff check: ${r.ok ? 'PASS' : 'NOT YET'}`, ''];
  L.push(`Screens pass at structural similarity ≥ ${r.threshold} with all of their copy present.`, '');
  L.push('| Screen | Result | Similarity | Changed pixels | Missing copy | Side by side |');
  L.push('|---|---|---|---|---|---|');
  for (const s of r.screens)
    L.push(
      `| ${s.id} | ${s.ok ? 'pass' : 'fail'} | ${s.ssim ?? '–'} | ${s.changed !== undefined ? `${s.changed} %` : '–'} | ${s.error ? `error: ${s.error}` : s.missing.map((m) => `“${m}”`).join(', ') || '–'} | ${s.sheet ? `\`${s.sheet}\`` : '–'} |`,
    );
  for (const id of r.noRoute) L.push(`| ${id} | no route | – | – | add it to adl-routes.json | – |`);
  L.push('', '## Transitions', '');
  for (const t of r.transitions)
    L.push(
      `- ${t.result === 'pass' ? '✓' : t.result === 'fail' ? '✗' : '–'} ${t.from} → ${t.to} “${t.label}”${t.why ? `: ${t.why}` : ''}`,
    );
  L.push('', 'Each side-by-side picture is: the design · your build · the differences in red.');
  return `${L.join('\n')}\n`;
}
