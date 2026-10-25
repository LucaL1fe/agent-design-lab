// Editing commands for agents (and people in a terminal): place screens, link them, set statuses and banners, notes,
// sections, proposals. Each one is a transaction through the workspace service, so the canvas updates live.
import fs from 'node:fs';
import path from 'node:path';
import {
  addArrow,
  addItem,
  addNote,
  addPage,
  addStatus,
  deletePage,
  HISTORY_PAGE,
  pickProposal,
  rejectProposal,
  removalHeirs,
  removeItems,
  renamePage,
  restoreFromHistory,
  setStatus,
  Tx,
} from '../../core/actions.ts';
import { isValidId } from '../../core/ids.ts';
import { clone } from '../../core/json.ts';
import { diffDoc, pageKey } from '../../core/ops.ts';
import { arrowStylesOf, statusesOf } from '../../core/status.ts';
import type { Arrow, Id, Item, NoteColor, PageDoc, ScreenItem, StatusDef, Trigger } from '../../core/types.ts';
import { writeAtomic } from '../fsutil.ts';
import { register } from './registry.ts';
import { CommandError, list, num, plural, requireItem, type Session, str, withEdit } from './session.ts';
import { screenHtml } from './templates.ts';

const NOTE_COLORS: NoteColor[] = ['yellow', 'blue', 'green', 'pink', 'grey', 'orange', 'purple'];

function findStatus(s: Session, want: string): StatusDef | undefined {
  const w = want.toLowerCase();
  return statusesOf(s.docs.project).find((d) => d.id === want || d.label.toLowerCase() === w || d.id === w);
}

function requireStatus(s: Session, want: string): StatusDef {
  const d = findStatus(s, want);
  if (!d)
    throw new CommandError(
      `No status "${want}". Statuses: ${statusesOf(s.docs.project)
        .map((x) => x.id)
        .join(', ')}. Make one with --create [--color #hex].`,
    );
  return d;
}

function requireStyle(s: Session, style: string | undefined): string | undefined {
  if (!style) return undefined;
  const styles = arrowStylesOf(s.docs.project);
  if (!styles[style]) throw new CommandError(`No arrow style "${style}". Styles: ${Object.keys(styles).join(', ')}`);
  return style;
}

/** "tap", "tap cta", "tap #cta", "auto 3s", "auto 1500ms", "back", "swipe", "system", "condition" */
export function parseTrigger(text: string | undefined, when?: string): Trigger | undefined {
  if (!text && !when) return undefined;
  if (!text) return { on: 'condition', when: when! };
  const [on, arg] = text.trim().split(/\s+/, 2) as [string, string | undefined];
  const kinds = ['tap', 'auto', 'condition', 'back', 'swipe', 'system'];
  if (!kinds.includes(on)) throw new CommandError(`Unknown trigger "${on}". Use one of: ${kinds.join(', ')}`);
  const t: Trigger = { on: on as Trigger['on'] };
  if (arg && on === 'auto') {
    const m = /^(\d+(?:\.\d+)?)(ms|s)?$/.exec(arg);
    if (!m) throw new CommandError(`"auto" takes a delay like 3s or 1500ms, not "${arg}"`);
    t.after = Math.round(Number(m[1]) * (m[2] === 'ms' ? 1 : 1000));
  } else if (arg) t.el = arg.replace(/^#/, '');
  if (when) t.when = when;
  return t;
}

function sectionId(s: Session, page: PageDoc, want: string): Id {
  if (page.items[want]?.kind === 'section') return want;
  const w = want.toLowerCase();
  const byTitle = Object.entries(page.items).find(
    ([, it]) => it.kind === 'section' && !it.archived && it.title.toLowerCase() === w,
  );
  if (byTitle) return byTitle[0];
  throw new CommandError(`No section "${want}" on page "${s.page}"`);
}

const letters = (i: number) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? String(Math.floor(i / 26)) : '');

function screenFileExists(s: Session, sid: string): boolean {
  return !!s.st.screens.get(sid) || fs.existsSync(path.join(s.st.dir, 'screens', `${sid}.html`));
}

// ---------- add ----------

register({
  name: 'add',
  summary: 'Place screens on a page (planned placeholders when the HTML does not exist yet), optionally linked',
  usage:
    'adl add [<page>] <id>... [--after <id>] [--chain] [--in <section>] [--style flow|new|proposal|loop] [--label "…"]... [--trigger "tap cta"] [--status <status>] [--banner "…"] [--proposal-for <id>] [--title "…"] [--frame <preset|WxH>] [--entry]',
  run: (args, ctx) =>
    withEdit(args, ctx, (s) => {
      const ids = [...args._];
      let page = s.page;
      if (ids.length > 1 && s.docs.pages[ids[0]!] && !str(args.page)) page = ids.shift()!;
      if (!ids.length) throw new CommandError('Which screens? adl add S1 S2 --after S0');
      for (const id of ids)
        if (!isValidId(id)) throw new CommandError(`"${id}" is not a valid id (letters, digits, - _ .)`);
      const p = s.docs.pages[page]!;
      const after = str(args.after);
      if (after && !p.items[after]) throw new CommandError(`"${after}" is not on page "${page}"`);
      const style = requireStyle(s, str(args.style));
      const isProposal = style === 'proposal' || !!str(args['proposal-for']);
      const proposalFor = str(args['proposal-for']) ?? (style === 'proposal' ? after : undefined);
      if (proposalFor && !p.items[proposalFor]) throw new CommandError(`"${proposalFor}" is not on page "${page}"`);
      const statusArg = str(args.status);
      const status = statusArg ? requireStatus(s, statusArg).id : s.docs.project.defaultStatus;
      const parent = str(args.in)
        ? sectionId(s, p, str(args.in)!)
        : after
          ? p.items[after]!.parent
          : proposalFor
            ? p.items[proposalFor]!.parent
            : undefined;
      const labels = list(args.label);
      const trigger = parseTrigger(str(args.trigger), str(args.when));
      const chain = args.chain === true;
      const tx = new Tx(s.docs);
      const added: Id[] = [];
      const existing: Id[] = [];
      const arrows: string[] = [];
      let prev = after;
      ids.forEach((id, i) => {
        if (tx.page(page).items[id]) existing.push(id);
        else {
          const item: ScreenItem = { kind: 'screen' };
          if (parent) item.parent = parent;
          if (status) item.status = status;
          if (str(args.banner)) item.banner = str(args.banner)!;
          if (str(args.title) && ids.length === 1) item.title = str(args.title)!;
          if (str(args.frame)) item.frame = str(args.frame)!;
          // a chain or screens after one start once; screens added side by side are each a start (only the first was,
          // so the other screens added that way read as unreached)
          if (args.entry === true && (i === 0 || (!chain && !after))) item.entry = true;
          if (proposalFor && isProposal) item.proposalFor = proposalFor;
          tx.setItem(page, id, item);
          added.push(id);
        }
        const from = chain ? prev : after;
        if (from && from !== id) {
          // labels go with arrows, in order (a chain without --after has one arrow fewer than screens)
          const k = arrows.length;
          const label =
            labels[chain ? k : Math.min(k, labels.length - 1)] ??
            (style === 'proposal' ? (ids.length > 1 ? `option ${letters(i)}` : 'proposal') : undefined);
          const arrow: Partial<Arrow> = {};
          if (label) arrow.label = label;
          if (style) arrow.style = style;
          if (trigger && style !== 'proposal') arrow.trigger = trigger;
          const r = addArrow(tx.docs, page, from, id, arrow);
          for (const op of r.ops) tx.set(op.doc, [...op.path], op.value);
          arrows.push(label ? `"${label}"` : `${from}→${id}`);
        }
        prev = id;
      });
      s.apply(tx.ops, `${s.who} added ${added.join(', ') || 'arrows'}${after ? ` after ${after}` : ''}`);
      const planned = added.filter((id) => !screenFileExists(s, id));
      let text = `${plural(added.length, 'screen')}, ${plural(arrows.length, 'arrow')}${arrows.length ? `: ${arrows.join(', ')}` : ''}`;
      if (existing.length) text += `\nAlready on the page (kept): ${existing.join(', ')}`;
      if (planned.length)
        text += `\nPlanned (no HTML yet, shown as placeholders): ${planned.map((id) => `screens/${id}.html`).join(', ')}`;
      return { ok: true, text, data: { page, added, existing, planned, arrows: arrows.length } };
    }),
});

// ---------- screen new ----------

register({
  name: 'screen',
  summary: 'Write a starter screen file: adl screen new <id> --title "…" (links styles/tokens.css + components.css)',
  usage: 'adl screen new <id> [--title "…"] [--frame <preset|WxH>] [--force]',
  run: (args, ctx) =>
    withEdit(args, ctx, async (s) => {
      const [sub, id] = args._;
      if (sub !== 'new' || !id) throw new CommandError('Usage: adl screen new <id> --title "…"');
      if (!isValidId(id)) throw new CommandError(`"${id}" is not a valid id`);
      const file = path.join(s.st.dir, 'screens', `${id}.html`);
      if (fs.existsSync(file) && args.force !== true)
        throw new CommandError(`screens/${id}.html exists (--force to overwrite)`);
      await writeAtomic(file, screenHtml({ title: str(args.title) ?? id, frame: str(args.frame) }));
      return { ok: true, text: `Wrote screens/${id}.html. Place it: adl add ${id} --after <id>`, data: { file } };
    }),
});

// ---------- link / unlink ----------

register({
  name: 'link',
  summary: 'Draw labelled arrows: adl link S1 S4 --label "taps 80" --trigger "tap buy" (more ids = a chain)',
  usage:
    'adl link <from> <to> [<to2>...] [--label "…"]... [--style flow|new|proposal|loop] [--trigger "tap cta"|"auto 3s"|back|swipe|system] [--when "condition"] [--page <id>]',
  run: (args, ctx) =>
    withEdit(args, ctx, (s) => {
      const ids = args._;
      if (ids.length < 2) throw new CommandError('Usage: adl link <from> <to> --label "…"');
      const page = str(args.page) ? s.page : requireItem(s.docs, ids[0]!, s.page).page;
      const p = s.docs.pages[page]!;
      for (const id of ids) if (!p.items[id]) throw new CommandError(`"${id}" is not on page "${page}"`);
      const style = requireStyle(s, str(args.style));
      const labels = list(args.label);
      const trigger = parseTrigger(str(args.trigger), str(args.when));
      const tx = new Tx(s.docs);
      const out: string[] = [];
      const warnings: string[] = [];
      for (let i = 0; i + 1 < ids.length; i++) {
        const from = ids[i]!;
        const to = ids[i + 1]!;
        const label = labels[i] ?? labels[labels.length - 1];
        const existing = Object.entries(tx.page(page).arrows).find(([, a]) => a.from === from && a.to === to);
        const patch: Partial<Arrow> = {};
        if (label !== undefined) patch.label = label;
        if (style) patch.style = style;
        if (trigger) patch.trigger = trigger;
        if (existing && args.new !== true) {
          tx.setArrow(page, existing[0], { ...existing[1], ...patch });
        } else {
          const r = addArrow(tx.docs, page, from, to, patch);
          for (const op of r.ops) tx.set(op.doc, [...op.path], op.value);
        }
        if (trigger?.el) {
          const sid = (p.items[from] as ScreenItem).screen ?? from;
          const meta = s.st.screens.get(sid)?.compiled;
          if (meta && !meta.anchors.includes(trigger.el))
            warnings.push(`${from} has no element with data-adl-anchor="${trigger.el}"`);
        }
        out.push(`${from} → ${to}${label ? ` "${label}"` : ''}${existing && args.new !== true ? ' (updated)' : ''}`);
      }
      s.apply(tx.ops, `${s.who} linked ${ids.join(' → ')}`);
      return {
        ok: true,
        text: [...out, ...warnings.map((w) => `warning: ${w}`)].join('\n'),
        data: { page, arrows: out, warnings },
      };
    }),
});

register({
  name: 'unlink',
  summary: 'Remove arrows: adl unlink S1 S4 (all arrows between them) or adl unlink "S1>S4"',
  usage: 'adl unlink <from> <to> | <arrow-id> [--page <id>]',
  run: (args, ctx) =>
    withEdit(args, ctx, (s) => {
      const [a, b] = args._;
      if (!a) throw new CommandError('Usage: adl unlink <from> <to>');
      const page = str(args.page) || !b ? s.page : requireItem(s.docs, a, s.page).page;
      const arrows = s.docs.pages[page]!.arrows;
      const gone = Object.entries(arrows)
        .filter(([id, x]) => (b ? x.from === a && x.to === b : id === a))
        .map(([id]) => id);
      if (!gone.length) throw new CommandError(`No arrow ${b ? `${a} → ${b}` : `"${a}"`} on page "${page}"`);
      const tx = new Tx(s.docs);
      for (const id of gone) tx.setArrow(page, id, undefined);
      s.apply(tx.ops, `${s.who} removed ${plural(gone.length, 'arrow')}`);
      return { ok: true, text: `Removed ${plural(gone.length, 'arrow')}: ${gone.join(', ')}`, data: { removed: gone } };
    }),
});

// ---------- status / banner ----------

register({
  name: 'status',
  summary: 'Set the status and banner text of screens: adl status T4 needs-fix --banner "what to fix"',
  usage:
    'adl status <id>... <status> [--banner "…"|--no-banner] [--create --color #hex --role review|todo|existing|approved] | adl status <id>... --banner "…"',
  run: (args, ctx) =>
    withEdit(args, ctx, (s) => {
      const pos = [...args._];
      if (!pos.length) throw new CommandError('Usage: adl status <id>... <status> [--banner "…"]');
      const page = str(args.page) ? s.page : requireItem(s.docs, pos[0]!, s.page).page;
      const p = s.docs.pages[page]!;
      // the last word is the status unless it is a screen on the page and a banner is given
      const last = pos[pos.length - 1]!;
      const bannerOnly =
        pos.length >= 1 && p.items[last] !== undefined && args.banner !== undefined && !findStatus(s, last);
      const tx = new Tx(s.docs);
      let def: StatusDef | undefined;
      if (!bannerOnly) {
        pos.pop();
        def = findStatus(s, last);
        if (!def && args.create === true) {
          const r = addStatus(tx.docs, {
            label: last,
            color: str(args.color) ?? '#8DB6FF',
            role: (str(args.role) as StatusDef['role']) ?? 'review',
            banner: true,
            createdBy: s.actor,
          });
          for (const op of r.ops) tx.set(op.doc, [...op.path], op.value);
          def = statusesOf(tx.docs.project).find((x) => x.id === r.id);
        }
        if (!def) def = requireStatus(s, last);
      }
      if (!pos.length) throw new CommandError('Which screens?');
      for (const id of pos) {
        const it = p.items[id];
        if (!it) throw new CommandError(`"${id}" is not on page "${page}"`);
        if (it.kind !== 'screen') throw new CommandError(`"${id}" is a ${it.kind}, not a screen`);
      }
      const banner = args.banner === false ? '' : str(args.banner);
      const ops = bannerOnly
        ? pos.flatMap((id) => new Tx(tx.docs).setField(page, id, 'banner', banner || undefined).ops)
        : setStatus(tx.docs, page, pos, def!.id, banner);
      for (const op of ops) tx.set(op.doc, [...op.path], op.value);
      s.apply(
        tx.ops,
        bannerOnly
          ? `${s.who} changed the banner of ${pos.join(', ')}`
          : `${s.who} set ${pos.join(', ')} to ${def!.label}`,
      );
      const who = pos.length === 1 ? pos[0]! : plural(pos.length, 'screen');
      const text = bannerOnly
        ? `${who}: banner “${banner ?? ''}”`
        : `${who} → ${def!.label}${banner ? `: “${banner}”` : def!.role === 'approved' ? ' (banner removed)' : ''}`;
      return { ok: true, text, data: { page, ids: pos, status: def?.id, banner } };
    }),
});

// ---------- notes, sections, remove ----------

register({
  name: 'note',
  summary: 'Add a sticky note, anchored to a screen with --on (it moves with the screen)',
  usage:
    'adl note "text" [--on <id>] [--color yellow|blue|green|pink|grey|orange|purple] [--small] [--in <section>] [--page <id>]',
  run: (args, ctx) =>
    withEdit(args, ctx, (s) => {
      const text = args._.join(' ').trim();
      if (!text) throw new CommandError('Usage: adl note "text" --on S6');
      const on = str(args.on);
      const page = on && !str(args.page) ? requireItem(s.docs, on, s.page).page : s.page;
      const p = s.docs.pages[page]!;
      if (on && !p.items[on]) throw new CommandError(`"${on}" is not on page "${page}"`);
      const color = (str(args.color) ?? 'yellow') as NoteColor;
      if (!NOTE_COLORS.includes(color)) throw new CommandError(`Colours: ${NOTE_COLORS.join(', ')}`);
      const note: Parameters<typeof addNote>[2] = {
        text,
        color,
        ...(args.small === true ? { size: 'small' as const } : {}),
      };
      if (on) note.anchor = on;
      if (str(args.in)) note.parent = sectionId(s, p, str(args.in)!);
      const x = num(args.x);
      const y = num(args.y);
      if (x !== undefined) note.x = x;
      if (y !== undefined) note.y = y;
      const r = addNote(s.docs, page, note, s.actor);
      s.apply(r.ops, `${s.who} added a note${on ? ` on ${on}` : ''}`);
      return { ok: true, text: `Note ${r.id}${on ? ` on ${on}` : ''}`, data: { id: r.id, page } };
    }),
});

register({
  name: 'section',
  summary: 'Group screens in a titled section: adl section "Onboarding" S1 S2 S3 (moves them in, re-laid out)',
  usage: 'adl section "<title>" [<id>...] [--id <section-id>] [--page <id>] | adl section rename <id> "<title>"',
  run: (args, ctx) =>
    withEdit(args, ctx, (s) => {
      const p = s.docs.pages[s.page]!;
      const tx = new Tx(s.docs);
      if (args._[0] === 'rename') {
        const [, id, ...rest] = args._;
        if (!id || !rest.length) throw new CommandError('Usage: adl section rename <id> "<title>"');
        const sid = sectionId(s, p, id);
        tx.setField(s.page, sid, 'title', rest.join(' '));
        s.apply(tx.ops, `${s.who} renamed a section to “${rest.join(' ')}”`);
        return { ok: true, text: `Section ${sid}: “${rest.join(' ')}”` };
      }
      const [title, ...ids] = args._;
      if (!title) throw new CommandError('Usage: adl section "<title>" S1 S2 …');
      for (const id of ids) if (!p.items[id]) throw new CommandError(`"${id}" is not on page "${s.page}"`);
      const wanted = str(args.id);
      const r = addItem(tx.docs, s.page, { kind: 'section', title }, wanted ?? sectionSlug(title));
      for (const op of r.ops) tx.set(op.doc, [...op.path], op.value);
      for (const id of ids) {
        const it = { ...tx.page(s.page).items[id]! } as Item;
        it.parent = r.id;
        delete it.x;
        delete it.y;
        delete it.pinned;
        tx.setItem(s.page, id, it);
      }
      s.apply(tx.ops, `${s.who} made the section “${title}”`);
      return {
        ok: true,
        text: `Section ${r.id} “${title}”${ids.length ? ` with ${plural(ids.length, 'item')}` : ''}`,
        data: { id: r.id, page: s.page },
      };
    }),
});

function sectionSlug(title: string): string {
  return (
    title
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'section'
  );
}

register({
  name: 'remove',
  summary: 'Take items off a page (screen files stay; they show under "Screens not on any page")',
  usage: 'adl remove <id>... [--page <id>]',
  run: (args, ctx) =>
    withEdit(args, ctx, (s) => {
      if (!args._.length) throw new CommandError('Usage: adl remove <id>...');
      const page = str(args.page) ? s.page : requireItem(s.docs, args._[0]!, s.page).page;
      for (const id of args._)
        if (!s.docs.pages[page]!.items[id]) throw new CommandError(`"${id}" is not on "${page}"`);
      const heirs = removalHeirs(s.docs, page, args._);
      s.apply(removeItems(s.docs, page, args._), `${s.who} removed ${args._.join(', ')}`);
      const took = heirs.map(([id, heir]) => `; ${heir} takes ${id}'s place (its other options stay options)`).join('');
      return { ok: true, text: `Removed ${args._.join(', ')} from "${page}"${took}` };
    }),
});

// ---------- patch / layout ----------

/** RFC 7386 JSON merge patch. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> =
    target && typeof target === 'object' && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

register({
  name: 'patch',
  summary: 'Change a page or project.json with a JSON merge patch (null deletes a field)',
  usage: `adl patch <page|project> '{"items":{"S6":{"banner":"…"}}}' | --file patch.json`,
  run: (args, ctx) =>
    withEdit(args, ctx, async (s) => {
      const [target, json] = args._;
      if (!target) throw new CommandError('Usage: adl patch <page|project> \'{"…": …}\'');
      const text = str(args.file) ? fs.readFileSync(path.resolve(ctx.cwd, str(args.file)!), 'utf8') : json;
      if (!text) throw new CommandError('Give the patch as JSON or --file');
      let patch: unknown;
      try {
        patch = JSON.parse(text);
      } catch (e) {
        throw new CommandError(`The patch is not valid JSON: ${(e as Error).message}`);
      }
      const isProject = target === 'project';
      if (!isProject && !s.docs.pages[target]) throw new CommandError(`No page "${target}"`);
      const key = isProject ? 'project' : pageKey(target);
      const before = isProject ? s.docs.project : s.docs.pages[target]!;
      const after = mergePatch(clone(before), patch) as Record<string, unknown>;
      after.rev = before.rev;
      const ops = diffDoc(key, before, after);
      s.apply(ops, `${s.who} patched ${isProject ? 'project.json' : `page “${target}”`}`);
      return { ok: true, text: `${plural(ops.length, 'change')} to ${isProject ? 'project.json' : target}` };
    }),
});

register({
  name: 'layout',
  summary:
    'Re-lay out a page or section in flow order (items a person moved stay put unless --all; --all also fits the section to its content)',
  usage: 'adl layout [<section>] [--all] [--page <id>]',
  run: (args, ctx) =>
    withEdit(args, ctx, (s) => {
      const p = s.docs.pages[s.page]!;
      const sec = args._[0] ? sectionId(s, p, args._[0]) : undefined;
      const tx = new Tx(s.docs);
      let n = 0;
      for (const [id, it] of Object.entries(p.items)) {
        if (it.archived || (it.kind === 'section' && !sec)) continue;
        if (sec ? it.parent !== sec : false) continue;
        if (it.kind === 'note' && it.anchor) continue;
        if (it.pinned && args.all !== true) continue;
        if (it.x === undefined && it.y === undefined) continue;
        const next = { ...it };
        delete next.x;
        delete next.y;
        delete next.pinned;
        tx.setItem(s.page, id, next);
        n++;
      }
      // --all also lets the section fit its content again: its stored size is a minimum, so after compacting it kept
      // its old size (~1000 px of empty frame under the last screen of a real section)
      const box = sec ? p.items[sec] : undefined;
      const fit = args.all === true && box?.kind === 'section' && (box.w !== undefined || box.h !== undefined);
      if (fit && box) {
        const next = { ...box };
        delete next.w;
        delete next.h;
        tx.setItem(s.page, sec!, next);
      }
      s.apply(tx.ops, `${s.who} re-laid out ${sec ? `section ${sec}` : `page “${s.page}”`}`);
      return { ok: true, text: `Re-laid out ${plural(n, 'item')}${fit ? '; the section fits its content again' : ''}` };
    }),
});

// ---------- proposals and history ----------

register({
  name: 'pick',
  summary: 'Use a proposal instead of the screen it replaces (the old one and the other options go to History)',
  usage: 'adl pick <proposal-id> [--page <id>]',
  run: (args, ctx) =>
    withEdit(args, ctx, (s) => {
      const id = args._[0];
      if (!id) throw new CommandError('Usage: adl pick <proposal-id>');
      const page = str(args.page) ? s.page : requireItem(s.docs, id, s.page).page;
      const r = pickProposal(s.docs, page, id, s.actor);
      s.apply(r.ops, `${s.who} used ${id} instead of ${r.replaced}`);
      return {
        ok: true,
        text: `${id} is used instead of ${r.replaced}. On the History page now: ${r.archived.join(', ')}`,
        data: r,
      };
    }),
});

register({
  name: 'reject',
  summary: 'Reject a proposal (it moves to the History page; restore it from there)',
  usage: 'adl reject <proposal-id> [--note "why"] [--page <id>]',
  run: (args, ctx) =>
    withEdit(args, ctx, (s) => {
      const id = args._[0];
      if (!id) throw new CommandError('Usage: adl reject <proposal-id>');
      const page = str(args.page) ? s.page : requireItem(s.docs, id, s.page).page;
      s.apply(rejectProposal(s.docs, page, id, s.actor, str(args.note)), `Rejected ${id}`);
      return { ok: true, text: `${id} is on the History page` };
    }),
});

register({
  name: 'history',
  summary: 'List what was replaced, rejected or removed; restore an item with --restore <id>',
  usage: 'adl history [--restore <id>]',
  run: (args, ctx) =>
    withEdit(args, ctx, (s) => {
      const restore = str(args.restore);
      if (restore) {
        const r = restoreFromHistory(s.docs, restore);
        s.apply(r.ops, `Restored ${r.id}`);
        return { ok: true, text: `Restored ${r.id} on page "${r.page}"`, data: r };
      }
      const h = s.docs.pages[HISTORY_PAGE];
      const rows = Object.entries(h?.items ?? {})
        .filter(([, it]) => it.archived)
        .sort(([, a], [, b]) => (a.archived!.at < b.archived!.at ? 1 : -1))
        .map(([id, it]) => {
          const a = it.archived!;
          return `${id}  ${a.reason}${a.replacedBy ? ` by ${a.replacedBy}` : ''} · ${a.at.slice(0, 16).replace('T', ' ')} · from ${a.from}${a.note ? ` · “${a.note}”` : ''}`;
        });
      return { ok: true, text: rows.join('\n') || 'History is empty', data: { count: rows.length } };
    }),
});

// ---------- pages ----------

register({
  name: 'page',
  summary: 'Pages: adl page new "Design system" | rename <id> "Name" | truth <id> | delete <id>',
  usage:
    'adl page new "<name>" [--after <page>] | adl page rename <id> "<name>" | adl page truth <id> | adl page delete <id>',
  run: (args, ctx) =>
    withEdit(args, ctx, (s) => {
      const [sub, a, ...rest] = args._;
      const need = (id: string | undefined) => {
        if (!id || !s.docs.pages[id])
          throw new CommandError(`No page "${id ?? ''}". Pages: ${s.docs.project.pages.join(', ')}`);
        return id;
      };
      if (sub === 'new') {
        const name = [a, ...rest].filter(Boolean).join(' ');
        if (!name) throw new CommandError('Usage: adl page new "<name>"');
        const r = addPage(s.docs, name, undefined, str(args.after));
        s.apply(r.ops, `${s.who} added the page “${name}”`);
        return {
          ok: true,
          text: `Page ${r.id} “${name}”. Place screens on it with --page ${r.id}`,
          data: { id: r.id },
        };
      }
      if (sub === 'rename') {
        const id = need(a);
        const name = rest.join(' ');
        if (!name) throw new CommandError('Usage: adl page rename <id> "<name>"');
        s.apply(renamePage(s.docs, id, name), `${s.who} renamed a page to “${name}”`);
        return { ok: true, text: `Page ${id} is now “${name}”` };
      }
      if (sub === 'truth') {
        const id = need(a);
        s.apply(new Tx(s.docs).set('project', ['sourceOfTruth'], id).ops, `${s.who} made “${id}” the source of truth`);
        return { ok: true, text: `Page ${id} is the source of truth (handoff builds from it)` };
      }
      if (sub === 'delete') {
        const id = need(a);
        if (s.docs.project.pages.filter((x) => x !== HISTORY_PAGE).length < 2)
          throw new CommandError('A project keeps at least one page');
        s.apply(deletePage(s.docs, id), `${s.who} deleted the page “${id}”`);
        return { ok: true, text: `Deleted page ${id} (a copy is in .adl/trash)` };
      }
      throw new CommandError(`Usage: ${'adl page new "<name>" | rename <id> "<name>" | truth <id> | delete <id>'}`);
    }),
});

// ---------- portals ----------

register({
  name: 'portal',
  summary: 'A box that stands for a screen elsewhere (another section or page): clicking it goes there',
  usage:
    'adl portal --to <id> [--after <id> --label "…" --trigger "tap cta" --when "condition"] [--text "Title\\n→ detail"] [--in <section>] [--page <id>]',
  run: (args, ctx) =>
    withEdit(args, ctx, (s) => {
      const to = str(args.to);
      if (!to) throw new CommandError('Usage: adl portal --to <screen id> [--after <id> --label "…"]');
      const p = s.docs.pages[s.page]!;
      // the target: on this page, or found on another page
      const m = /^page:([^/]+)\/(.+)$/.exec(to);
      const target = m
        ? { page: m[1]!, id: m[2]! }
        : (() => {
            const f = requireItem(s.docs, to, s.page);
            return { page: f.page, id: to };
          })();
      const tp = s.docs.pages[target.page];
      const titem = tp?.items[target.id];
      if (!titem) throw new CommandError(`No "${target.id}" on page "${target.page}"`);
      const other = target.page !== s.page;
      const title =
        (titem.kind === 'screen' && (titem.title ?? s.st.screens.get(titem.screen ?? target.id)?.compiled?.title)) ||
        target.id;
      const after = str(args.after);
      if (after && !p.items[after]) throw new CommandError(`"${after}" is not on page "${s.page}"`);
      const item: Item = {
        kind: 'portal',
        text: str(args.text)?.replace(/\\n/g, '\n') ?? `${title}\n→ ${target.id}${other ? ` on ${tp!.name}` : ''}`,
        target: other ? `page:${target.page}/${target.id}` : target.id,
        w: 300,
        h: 92,
      };
      const parent = str(args.in) ? sectionId(s, p, str(args.in)!) : after ? p.items[after]!.parent : undefined;
      if (parent) item.parent = parent;
      const tx = new Tx(s.docs);
      const added = addItem(tx.docs, s.page, item);
      for (const op of added.ops) tx.set(op.doc, [...op.path], op.value);
      // the arrow into the portal takes a trigger like any other (it was silently dropped)
      const trigger = parseTrigger(str(args.trigger), str(args.when));
      const warnings: string[] = [];
      if (after) {
        const label = str(args.label);
        const r = addArrow(tx.docs, s.page, after, added.id, {
          ...(label ? { label } : {}),
          ...(trigger ? { trigger } : {}),
        });
        for (const op of r.ops) tx.set(op.doc, [...op.path], op.value);
        const from = p.items[after]!;
        const meta = from.kind === 'screen' ? s.st.screens.get(from.screen ?? after)?.compiled : undefined;
        if (trigger?.el && meta && !meta.anchors.includes(trigger.el))
          warnings.push(`warning: ${after} has no element with data-adl-anchor="${trigger.el}"`);
      } else if (trigger) throw new CommandError('--trigger and --when need --after (they belong to the arrow)');
      s.apply(tx.ops, `${s.who} added a portal to ${target.id}`);
      return {
        ok: true,
        text: [
          `Portal ${added.id} → ${target.id}${other ? ` on page ${target.page}` : ''}${after ? `, arrow ${after} → ${added.id}` : ''}`,
          ...warnings,
        ].join('\n'),
        data: { id: added.id, target: item.target },
      };
    }),
});
