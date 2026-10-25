// `adl render`: PNGs of screens, flows and canvas sections, so an agent can look at its own work before reporting it,
// and people can download a section as a picture.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { flowOrder, screensInFlow } from '../../core/flow.ts';
import { resolveFrame } from '../../core/frames.ts';
import { arrowStylesOf, findStatus, showsBanner, statusInk } from '../../core/status.ts';
import type { Id, PageDoc, ScreenItem } from '../../core/types.ts';
import { resolveWorkspace } from '../paths.ts';
import { type RunningServer, startServer } from '../server/server.ts';
import { SnapshotService } from '../snapshot/service.ts';
import type { ProjectState } from '../store/workspace.ts';
import { type CommandContext, type ParsedArgs, register } from './registry.ts';
import { CommandError, list, num, pickPage, pickProject, plural, str } from './session.ts';

// browser-side code in page.evaluate (the node build has no DOM types)
// biome-ignore lint/suspicious/noExplicitAny: see above
type Win = any;

interface Target {
  id: Id;
  sid: string;
  hash: string;
  frame?: string | undefined;
  item?: ScreenItem | undefined;
}

/** The running server's Chrome, or a short-lived helper server with its own Chrome. Canvas renders need the
 *  background snapshots (zoomed-out screens are drawn from them), single screens don't. */
async function withRenderer<T>(
  args: ParsedArgs,
  ctx: CommandContext,
  background: boolean,
  fn: (server: RunningServer, snaps: SnapshotService) => Promise<T>,
): Promise<T> {
  if (ctx.server?.snapshots?.available) return fn(ctx.server, ctx.server.snapshots);
  const server =
    ctx.server ??
    (await startServer({
      ws: resolveWorkspace({ workspace: str(args.workspace), cwd: ctx.cwd }),
      port: 0,
      quiet: true,
      ephemeral: true,
    }));
  const snaps = new SnapshotService(server);
  if (!ctx.server) server.snapshots = snaps;
  try {
    if (!(await snaps.start({ background })))
      throw new CommandError(
        'Rendering needs Google Chrome (or Chromium, Edge), and none was found. Run `adl doctor`.',
      );
    return await fn(server, snaps);
  } finally {
    await snaps.close();
    if (!ctx.server) await server.close();
  }
}

function targetsFor(st: ProjectState, page: PageDoc, ids: Id[]): { targets: Target[]; missing: string[] } {
  const targets: Target[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const it = page.items[id];
    const item = it?.kind === 'screen' ? it : undefined;
    const sid = item?.screen ?? id;
    const hash = st.screens.get(sid)?.compiled?.hash;
    if (!hash) {
      const err = st.screens.get(sid)?.error;
      missing.push(err ? `${id} (${err})` : `${id} (no screens/${sid}.html yet)`);
      continue;
    }
    targets.push({ id, sid, hash, frame: item?.frame, item });
  }
  return { targets, missing };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One picture of several screens with captions, banners and the arrow labels between them. */
function sheetHtml(
  st: ProjectState,
  page: PageDoc,
  shots: { t: Target; png: Buffer; w: number; h: number }[],
  cardW: number,
  flow: boolean,
): string {
  const project = st.docs.project;
  const cards = shots.map(({ t, png, w, h }, i) => {
    const item = t.item;
    const title = item?.title ?? st.screens.get(t.sid)?.compiled?.title ?? '';
    const def = item?.status ? findStatus(project, item.status) : undefined;
    const banner =
      def && showsBanner(project, def.id)
        ? `<div class="ban" style="background:${def.color};color:${statusInk(def)}"><b>${esc(def.label.toUpperCase())}</b>${item?.banner ? ` · ${esc(item.banner)}` : ''}</div>`
        : '';
    let between = '';
    if (flow && i + 1 < shots.length) {
      const nextId = shots[i + 1]!.t.id;
      const a = Object.values(page.arrows).find((x) => x.from === t.id && x.to === nextId);
      between = `<div class="arr"><span>${esc(a?.label ?? '')}</span><i></i></div>`;
    }
    const ih = Math.round((h * cardW) / w);
    return `<div class="card"><div class="cap"><span class="id">${esc(t.id)}</span>${title ? ` · ${esc(title)}` : ''}</div>${banner}<img src="data:image/png;base64,${png.toString('base64')}" width="${cardW}" height="${ih}"></div>${between}`;
  });
  return `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;background:#1b1b1a;font:13px/1.35 system-ui,-apple-system,sans-serif;color:#e8e6df}
  .wrap{display:flex;flex-wrap:wrap;align-items:flex-end;gap:36px 28px;padding:28px;width:max-content;max-width:${flow ? 100000 : 1700}px}
  .card{width:${cardW}px;display:flex;flex-direction:column;gap:6px}
  .cap{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.id{color:#f5c84b}
  .ban{border-radius:6px 6px 0 0;padding:5px 8px;font-size:11px;margin-bottom:-6px}
  img{display:block;border-radius:10px;box-shadow:0 0 0 1px #ffffff1a}
  .arr{align-self:center;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:60px;max-width:120px;color:#cfccc3;font-size:12px;text-align:center}
  .arr i{display:block;width:100%;height:2px;background:#8f8c84;position:relative}
  .arr i::after{content:"";position:absolute;right:-1px;top:-4px;border:5px solid transparent;border-left:8px solid #8f8c84;border-right:0}
  </style><div class="wrap">${cards.join('')}</div>`;
}

async function canvasPng(
  server: RunningServer,
  snaps: SnapshotService,
  pid: string,
  page: string,
  target: Id | undefined,
  maxW: number,
): Promise<{ png: Buffer; tiles: number }> {
  await snaps.idle(60000).catch(() => undefined);
  return snaps.withPage({ width: 1400, height: 900, scale: 2 }, async (p) => {
    await p.goto(`${server.url}/p/${encodeURIComponent(pid)}/${encodeURIComponent(page)}`);
    await p.waitForFunction(
      (pg) => {
        const a = (globalThis as Win).__adl;
        return !!a?.engine && a.engine.rects.size > 0 && a.engine.root.dataset.viewReady === pg;
      },
      page,
      { timeout: 30000 },
    );
    await p.addStyleTag({
      content: '.topbar,.tb,.rc,.insp,.toasts,.progress,.pill-hint,.errbar{display:none!important}',
    });
    const r = (await p.evaluate((id) => {
      const a = (globalThis as Win).__adl;
      a.app.set({ animations: 'never', selection: [] });
      const e = a.engine;
      return id ? e.rects.get(id) : e.contentBounds();
    }, target)) as { x: number; y: number; w: number; h: number } | undefined;
    if (!r) throw new CommandError(`Nothing to render${target ? ` for "${target}"` : ''}`);
    const head = 70;
    const pad = 60;
    // Chrome rasters only part of a giant window for one screenshot (the rest comes out unpainted grey), so the
    // picture is taken in tiles at one zoom and stitched; a small one is a single tile
    const scale = 2;
    const k = (await p.evaluate(
      (want) => {
        const e = (globalThis as Win).__adl.engine;
        e.vp.insetTop = 0;
        e.vp.insetRight = 0;
        e.stickyTitles = false;
        e.vp.set({ k: want, x: 0, y: 0 }, { animate: false });
        return e.vp.v.k;
      },
      Math.min(1, maxW / r.w),
    )) as number;
    const W = Math.round(r.w * k + pad * 2);
    const H = Math.round((r.h + head) * k + pad * 2);
    const tw = Math.min(W, TILE);
    const th = Math.min(H, TILE);
    await p.setViewportSize({ width: Math.max(320, tw), height: Math.max(240, th) });
    const out = new PNG({ width: W * scale, height: H * scale });
    let tiles = 0;
    for (let oy = 0; oy < H; oy += th)
      for (let ox = 0; ox < W; ox += tw) {
        await p.evaluate(
          ([kk, x, y]) => {
            const e = (globalThis as Win).__adl.engine;
            e.vp.set({ k: kk, x, y }, { animate: false });
            e.renderNow?.();
          },
          [k, pad - r.x * k - ox, pad - (r.y - head) * k - oy] as const,
        );
        // wait until every visible screen shows its final picture (twice in a row, a frame apart)
        await p
          .evaluate(() => {
            (globalThis as Win).__adlRenderOk = false;
          })
          .then(() =>
            p.waitForFunction(
              () => {
                const g = globalThis as Win;
                const ok = g.__adl.engine.pending() === 0;
                const was = g.__adlRenderOk === true;
                g.__adlRenderOk = ok;
                return ok && was;
              },
              undefined,
              { timeout: 30000, polling: 100 },
            ),
          )
          .catch(() => undefined);
        await p.waitForTimeout(150);
        const tile = PNG.sync.read(await p.screenshot({ type: 'png' }));
        const w = Math.min(tile.width, (W - ox) * scale);
        const h = Math.min(tile.height, (H - oy) * scale);
        PNG.bitblt(tile, out, 0, 0, w, h, ox * scale, oy * scale);
        tiles++;
      }
    return { png: PNG.sync.write(out), tiles };
  });
}

/** Largest side of one screenshot tile, in CSS pixels (2× on the picture). */
export const TILE = 1800;

register({
  name: 'render',
  summary: 'Render screens to PNG files to look at them (--sheet: one picture, --flow <id>: along the arrows)',
  usage:
    'adl render <id>... [--sheet] [--flow <start-id>] [--section <id>] [--canvas] [--scale 1|2] [--width 300] [--out <dir>] [--page <id>]',
  run: async (args, ctx) => {
    const canvas =
      args.canvas === true || args.base64 === true || (!!str(args.section) && !args._.length && args.sheet !== true);
    return withRenderer(args, ctx, canvas, async (server, snaps) => {
      const service = server.service;
      const st = pickProject(service, args, ctx.cwd, ctx.server);
      const pageId = pickPage(st.docs, str(args.page));
      const page = st.docs.pages[pageId]!;
      const outDir = path.resolve(ctx.cwd, str(args.out) ?? path.join(st.adl, 'renders'));
      await fsp.mkdir(outDir, { recursive: true });
      const rel = (f: string) => {
        const r = path.relative(ctx.cwd, f);
        return r && !r.startsWith('..') ? r : f;
      };
      const section = str(args.section);
      if (section && !page.items[section]) throw new CommandError(`No "${section}" on page "${pageId}"`);

      // a section or the whole page as it looks on the canvas (arrows, captions, banners)
      if (canvas) {
        const { png, tiles } = await canvasPng(server, snaps, st.id, pageId, section, num(args['max-width']) ?? 2400);
        const file = path.join(outDir, `${section ?? pageId}-canvas.png`);
        await fsp.writeFile(file, png);
        return {
          ok: true,
          text: `Rendered ${section ? `section ${section}` : `page ${pageId}`}: ${rel(file)}`,
          data: { file, tiles, ...(args.base64 === true ? { png: png.toString('base64') } : {}) },
        };
      }

      const flowStart = str(args.flow);
      let ids = [...args._, ...list(args.id)];
      if (flowStart) {
        if (!page.items[flowStart]) throw new CommandError(`"${flowStart}" is not on page "${pageId}"`);
        ids = flowOrder(page, screensInFlow(page, st.docs.project), flowStart, st.docs.project);
      } else if (!ids.length) ids = screensInFlow(page, st.docs.project, section);
      if (!ids.length) throw new CommandError('No screens to render');
      const { targets, missing } = targetsFor(st, page, ids);
      const scale = num(args.scale) ?? 1;
      const shots: { t: Target; png: Buffer; w: number; h: number }[] = [];
      const warnings: string[] = [];
      const files: string[] = [];
      for (const t of targets) {
        const r = await snaps.renderPng(st.id, t.hash, t.frame, { scale });
        shots.push({ t, png: r.png, w: r.w, h: r.h });
        for (const o of r.overflow) warnings.push(`${t.id}: text cut off: “${o}”`);
        for (const o of r.outside) warnings.push(`${t.id}: text runs outside the frame: “${o}”`);
        if (r.tall > 4) {
          const f = resolveFrame(t.frame, st.docs.project);
          warnings.push(
            `${t.id}: content is ${r.tall}px taller than the ${f ? `${f.w}x${f.h}` : ''} frame (cut off at the bottom)`,
          );
        }
      }
      const sheet = args.sheet === true || !!flowStart;
      if (sheet) {
        const cardW = num(args.width) ?? 300;
        const html = sheetHtml(st, page, shots, cardW, !!flowStart);
        const png = await snaps.withPage({ width: 1800, height: 1000, scale: 1 }, async (p) => {
          await p.setContent(html);
          await p.waitForFunction(() =>
            [...(globalThis as Win).document.images].every((i: { complete: boolean }) => i.complete),
          );
          const box = await p.locator('.wrap').boundingBox();
          return p.screenshot({
            type: 'png',
            clip: { x: 0, y: 0, width: Math.ceil(box!.width), height: Math.ceil(box!.height) },
            fullPage: true,
          });
        });
        const name = flowStart ? `flow-${flowStart}` : section ? `section-${section}` : `sheet-${ids.length}`;
        const file = path.join(outDir, `${name}.png`);
        await fsp.writeFile(file, png);
        files.push(file);
      } else {
        for (const s of shots) {
          const file = path.join(outDir, `${s.t.id}.png`);
          await fsp.writeFile(file, s.png);
          files.push(file);
        }
      }
      const lines = [
        `Rendered ${plural(shots.length, 'screen')}${sheet ? ' on one sheet' : ''}: ${files.map(rel).join(', ')}`,
      ];
      if (missing.length) lines.push(`Not rendered: ${missing.join(', ')}`);
      if (warnings.length) lines.push(...warnings.map((w) => `warning: ${w}`));
      lines.push('Look at the PNGs before reporting: text fits, nothing overlaps, it matches the brief.');
      return { ok: true, text: lines.join('\n'), data: { files, missing, warnings } };
    });
  },
});
