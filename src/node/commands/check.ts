// Reading commands for the agent's loop: `validate` (is everything consistent?), `context` (what does the person see,
// what did they change since my last look, what is waiting for me?) and `show` (everything about one screen).

import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import { HISTORY_PAGE } from '../../core/actions.ts';
import { buildDef, flowsThrough } from '../../core/build.ts';
import { portalsTo } from '../../core/reach.ts';
import { arrowStylesOf, countStatuses, countsText, findStatus } from '../../core/status.ts';
import type { Arrow, Item, NoteItem, PageDoc, ScreenItem } from '../../core/types.ts';
import type { Problem } from '../../core/validate.ts';
import { markSeen, readSeen, startSeen } from '../agent.ts';
import { parseTokens, rawColors } from '../handoff/tokens.ts';
import type { ProjectState } from '../store/workspace.ts';
import { register } from './registry.ts';
import { CommandError, plural, requireItem, type Session, str, withSession } from './session.ts';

// ---------- validate ----------

/** Checks that need the files: planned screens, triggers pointing at missing anchors, loose screen files. */
export function extraProblems(st: ProjectState): Problem[] {
  const out: Problem[] = [];
  const placed = new Set<string>();
  for (const [pid, page] of Object.entries(st.docs.pages)) {
    for (const [id, it] of Object.entries(page.items)) {
      if (it.kind !== 'screen') continue;
      const sid = it.screen ?? id;
      placed.add(sid);
      if (pid === HISTORY_PAGE || it.archived) continue;
      if (!st.screens.has(sid))
        out.push({
          level: 'info',
          code: 'planned',
          page: pid,
          id,
          message: `${id} is planned: screens/${sid}.html does not exist yet`,
        });
    }
    if (pid === HISTORY_PAGE) continue;
    for (const [aid, a] of Object.entries(page.arrows)) {
      const el = a.trigger?.el ?? a.fromEl;
      if (!el) continue;
      const from = page.items[a.from] as ScreenItem | undefined;
      const anchors = st.screens.get(from?.screen ?? a.from)?.compiled?.anchors;
      if (anchors && !anchors.includes(el))
        out.push({
          level: 'warning',
          code: 'missing-anchor',
          page: pid,
          id: aid,
          message: `arrow ${aid}: ${a.from} has no element with data-adl-anchor="${el}"`,
        });
    }
  }
  for (const e of st.screens.values())
    if (!placed.has(e.id))
      out.push({ level: 'info', code: 'unplaced', id: e.id, message: `${e.file} is on no page (adl add ${e.id})` });
  out.push(...designSystemProblems(st));
  return out;
}

const COLOR_PROPS =
  /^(color|background(-color)?|border(-(top|right|bottom|left))?(-color)?|outline(-color)?|text-decoration-color|caret-color|accent-color)$/;

/** Screens should use the design system: link tokens.css, take colours from it instead of writing raw values. */
export function designSystemProblems(st: ProjectState): Problem[] {
  const tokensFile = path.join(st.dir, 'styles', 'tokens.css');
  if (!fs.existsSync(tokensFile)) return [];
  const tokens = parseTokens(fs.readFileSync(tokensFile, 'utf8')).filter((t) => t.type === 'color');
  const byValue = new Map(tokens.map((t) => [t.value.toLowerCase().replace(/\s+/g, ''), t.name]));
  const out: Problem[] = [];
  for (const e of st.screens.values()) {
    const file = path.join(st.dir, e.file);
    let html: string;
    try {
      html = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!/<link[^>]+href=["'][^"']*tokens\.css/i.test(html))
      out.push({
        level: 'warning',
        code: 'no-tokens',
        file: e.file,
        id: e.id,
        message: `${e.id}: does not link ../styles/tokens.css, so it cannot use the design tokens`,
      });
    const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!);
    for (const m of html.matchAll(/\sstyle="([^"]*)"/gi)) css.push(`x{${m[1]}}`);
    const raw = new Set<string>();
    for (const text of css) {
      try {
        postcss.parse(text).walkDecls((d) => {
          if (d.prop.startsWith('--') || !COLOR_PROPS.test(d.prop)) return;
          if (d.parent?.parent?.type === 'atrule' && /keyframes/i.test((d.parent.parent as postcss.AtRule).name))
            return;
          for (const c of rawColors(d.value)) raw.add(c);
        });
      } catch {
        // broken CSS is reported by the compiler
      }
    }
    if (!raw.size) continue;
    const known = [...raw].filter((c) => byValue.has(c.replace(/\s+/g, '')));
    const list = [...raw].slice(0, 5).join(', ') + (raw.size > 5 ? ` and ${raw.size - 5} more` : '');
    out.push({
      level: known.length ? 'warning' : 'info',
      code: 'raw-colors',
      file: e.file,
      id: e.id,
      message: known.length
        ? `${e.id}: use the tokens: ${known
            .slice(0, 4)
            .map((c) => `${c} is var(--${byValue.get(c.replace(/\s+/g, ''))})`)
            .join(', ')}`
        : `${e.id}: colours not from tokens.css: ${list}`,
    });
  }
  return out;
}

function problemLine(p: Problem): string {
  const where = p.file ?? (p.page ? `pages/${p.page}.json` : 'project.json');
  return `${p.level.padEnd(7)} ${where}${p.line ? `:${p.line}` : ''}  ${p.message}`;
}

function totals(st: ProjectState): { screens: number; arrows: number } {
  let screens = 0;
  let arrows = 0;
  for (const [pid, page] of Object.entries(st.docs.pages)) {
    if (pid === HISTORY_PAGE) continue;
    screens += Object.values(page.items).filter((i) => i.kind === 'screen' && !i.archived).length;
    arrows += Object.keys(page.arrows).length;
  }
  return { screens, arrows };
}

register({
  name: 'validate',
  summary: 'Check the project: broken references, unlabelled arrows, missing anchors, screen and CSS problems',
  usage: 'adl validate [--project <id>] [--quiet]',
  run: (args, ctx) =>
    withSession(args, ctx, (s) => {
      s.service.revalidate(s.st);
      const problems = [...s.st.problems, ...extraProblems(s.st)];
      const errors = problems.filter((p) => p.level === 'error').length;
      const warnings = problems.filter((p) => p.level === 'warning').length;
      const { screens, arrows } = totals(s.st);
      const head = `${errors ? 'errors' : 'ok'} · ${plural(screens, 'screen')} · ${plural(arrows, 'arrow')} · ${plural(errors + warnings, 'problem')}`;
      const shown = problems.filter((p) => args.quiet !== true || p.level !== 'info');
      const lines = [head, ...shown.slice(0, 60).map(problemLine)];
      if (shown.length > 60) lines.push(`… and ${shown.length - 60} more (--json for all)`);
      return {
        ok: errors === 0,
        text: lines.join('\n'),
        data: { screens, arrows, errors, warnings, problems },
        exitCode: errors ? 1 : 0,
      };
    }),
});

// ---------- context ----------

function screenLine(s: Session, page: PageDoc, id: string, it: ScreenItem): string {
  const def = it.status ? findStatus(s.docs.project, it.status) : undefined;
  const title = it.title ?? s.st.screens.get(it.screen ?? id)?.compiled?.title;
  return `${id}${title ? ` “${title}”` : ''}${def ? ` · ${def.label}` : ''}${it.banner ? `: ${it.banner}` : ''}${page.items[it.proposalFor ?? '']?.kind ? ` (proposal for ${it.proposalFor})` : ''}`;
}

register({
  name: 'context',
  summary: 'What the person sees and changed since your last look, what is waiting for you, open problems',
  usage: 'adl context [--peek] [--all] [--hook] [--session <id>]',
  run: (args, ctx) =>
    withSession(args, ctx, (s) => {
      const st = s.st;
      const p = s.docs.project;
      const session = str(args.session);
      const seen = readSeen(st, session);
      const lines: string[] = [];
      const hook = args.hook === true;
      const rel = path.relative(ctx.cwd, st.dir);
      lines.push(`Project “${p.name}” (${st.id}) in ${rel.startsWith('..') ? st.dir : rel || '.'}`);
      // what the person is looking at right now
      const views = [...(ctx.server?.views.values() ?? [])].filter((v) => v.pid === st.id);
      for (const v of views.slice(0, 2)) {
        const page = s.docs.pages[v.page];
        const vis = (v as { visible?: string[] }).visible ?? [];
        lines.push(
          `They are looking at page “${page?.name ?? v.page}” at ${Math.round(v.zoom * 100)}%${vis.length ? `: ${vis.slice(0, 12).join(', ')}${vis.length > 12 ? ` (+${vis.length - 12})` : ''}` : ''}${v.selection.length ? ` · selected: ${v.selection.join(', ')}` : ''}`,
        );
      }
      // changes by the person since the agent last looked
      const changes = st.activity.filter((e) => e.actor === 'human' && (!seen || e.at > seen));
      if (changes.length) {
        lines.push(`Changed by the person since your last look${seen ? ` (${seen.slice(11, 16)} UTC)` : ''}:`);
        for (const e of changes.slice(-25)) {
          const details = e.details?.length ? e.details : [e.summary];
          for (const d of details) lines.push(`  - ${d}`);
        }
      } else if (!hook) lines.push('No changes by the person since your last look.');
      // work waiting for the agent: screens with a todo status, and notes people left
      const todo: string[] = [];
      const review: string[] = [];
      const notes: string[] = [];
      for (const [pid, page] of Object.entries(s.docs.pages)) {
        if (pid === HISTORY_PAGE) continue;
        for (const [id, it] of Object.entries(page.items)) {
          if (it.archived) continue;
          if (it.kind === 'screen' && it.status) {
            const def = findStatus(p, it.status);
            const line = `${screenLine(s, page, id, it)}${pid !== s.page ? ` [page ${pid}]` : ''}`;
            if (def?.role === 'todo') todo.push(line);
            else if (def?.role === 'review') review.push(line);
          }
          if (it.kind === 'note' && it.by === 'human' && !(it as NoteItem).resolved)
            notes.push(`${id}${it.anchor ? ` on ${it.anchor}` : ''}: ${(it as NoteItem).text}`);
        }
      }
      if (todo.length) {
        lines.push(`To do (${todo.length}):`);
        for (const t of todo.slice(0, args.all ? 500 : 30)) lines.push(`  - ${t}`);
      }
      if (notes.length) {
        lines.push(`Notes from the person (${notes.length}):`);
        for (const n of notes.slice(0, args.all ? 500 : 20)) lines.push(`  - ${n}`);
      }
      if (review.length && !hook)
        lines.push(
          `Waiting for their review (${review.length}): ${review
            .slice(0, 15)
            .map((r) => r.split(' ')[0])
            .join(', ')}${review.length > 15 ? ' …' : ''}`,
        );
      const errors = st.problems.filter((x) => x.level === 'error');
      if (errors.length) lines.push(`Problems: ${plural(errors.length, 'error')}, run adl validate`);
      if (!hook) {
        const page = s.docs.pages[s.page]!;
        lines.push(
          `Pages: ${p.pages
            .filter((x) => x !== HISTORY_PAGE && s.docs.pages[x])
            .map((x) => `${x}${x === p.sourceOfTruth ? ' (source of truth)' : ''}`)
            .join(', ')} · ${countsText(countStatuses(p, page)) || 'no screens yet'} on ${s.page}`,
        );
      }
      if (args.peek !== true) markSeen(st, ctx.server, session);
      else if (session) startSeen(st, session);
      const empty = hook && !changes.length && !todo.length && !notes.length && !errors.length;
      return {
        ok: true,
        text: empty ? '' : lines.join('\n'),
        data: {
          project: st.id,
          views,
          changes: changes.map((c) => ({ at: c.at, summary: c.summary, details: c.details })),
          todo,
          notes,
          review,
          errors: errors.length,
        },
      };
    }),
});

// ---------- show ----------

register({
  name: 'show',
  summary: 'Everything about one screen: file, size, status, banner, section, arrows in and out, notes, warnings',
  usage: 'adl show <id> [--page <id>]',
  run: (args, ctx) =>
    withSession(args, ctx, (s) => {
      const id = args._[0];
      if (!id) throw new CommandError('Usage: adl show <id>');
      const { page: pid, item } = requireItem(s.docs, id, str(args.page) ? s.page : undefined);
      const page = s.docs.pages[pid]!;
      const lines: string[] = [];
      const styles = arrowStylesOf(s.docs.project);
      const arrowLine = (a: Arrow) =>
        `${a.from} → ${a.to}${a.label ? ` “${a.label}”` : ''}${a.style && a.style !== 'flow' ? ` [${styles[a.style]?.label ?? a.style}]` : ''}${a.trigger ? ` (${a.trigger.on}${a.trigger.el ? ` ${a.trigger.el}` : ''}${a.trigger.after ? ` ${a.trigger.after}ms` : ''}${a.trigger.when ? ` when ${a.trigger.when}` : ''})` : ''}`;
      if (item.kind === 'screen') {
        const sid = item.screen ?? id;
        const e = s.st.screens.get(sid);
        const size = s.service.frameSize(s.st, sid, item.frame);
        lines.push(
          `${id}${e?.compiled?.title ? ` “${item.title ?? e.compiled.title}”` : ''} · ${e ? e.file : `planned (screens/${sid}.html does not exist)`} · ${size.w}x${size.h}`,
        );
        const def = item.status ? findStatus(s.docs.project, item.status) : undefined;
        lines.push(
          `page ${pid}${item.parent ? ` · section ${item.parent}` : ''} · status ${def?.label ?? item.status ?? 'none'}${item.banner ? `: “${item.banner}”` : ''}${item.pinned ? ' · placed by hand' : ''}`,
        );
        if (item.proposalFor) lines.push(`proposal for ${item.proposalFor}`);
        const proposals = Object.entries(page.items)
          .filter(([, x]) => x.kind === 'screen' && x.proposalFor === id && !x.archived)
          .map(([x]) => x);
        if (proposals.length) lines.push(`proposals: ${proposals.join(', ')}`);
        if (item.build) {
          const caps = (item.build.captures ?? []).map((c) => `${c.device} ${c.kind} ${c.src}`);
          lines.push(
            `build: ${buildDef(item.build.state)?.label ?? item.build.state}${item.build.note ? ` · ${item.build.note}` : ''}${caps.length ? ` · ${caps.join(', ')}` : ' · no captures'}`,
          );
        }
        const through = flowsThrough(page, id);
        if (through.length) lines.push(`in flows: ${through.join(', ')}`);
        if (e?.compiled?.anchors.length) lines.push(`anchors: ${e.compiled.anchors.join(', ')}`);
        for (const x of e?.compiled?.sounds ?? [])
          lines.push(`sound: ${x.src} on ${x.el}${x.at ? `, ${x.at} ms into its animation` : ''}`);
        for (const w of e?.compiled?.warnings ?? []) lines.push(`warning: ${w}`);
        if (e?.error) lines.push(`error: ${e.error}`);
      } else
        lines.push(`${id} · ${item.kind} on page ${pid}${'title' in item && item.title ? ` “${item.title}”` : ''}`);
      const ins = Object.values(page.arrows).filter((a) => a.to === id);
      const outs = Object.values(page.arrows).filter((a) => a.from === id);
      for (const a of ins) lines.push(`in:  ${arrowLine(a)}`);
      const via = portalsTo(s.docs.pages, pid, id);
      for (const v of via)
        lines.push(
          `via: portal ${v.id}${v.page !== pid ? ` on page ${v.page}` : ''}${v.text ? ` “${v.text}”` : ''}${v.from.length ? ` from ${v.from.join(', ')}` : ''}`,
        );
      for (const a of outs) lines.push(`out: ${arrowLine(a)}`);
      for (const [nid, n] of Object.entries(page.items) as [string, Item][])
        if (n.kind === 'note' && n.anchor === id) lines.push(`note ${nid}${n.by ? ` by ${n.by}` : ''}: ${n.text}`);
      return { ok: true, text: lines.join('\n'), data: { page: pid, item, in: ins, via, out: outs } };
    }),
});
