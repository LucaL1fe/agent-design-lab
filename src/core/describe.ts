// Plain-language lines for what a transaction changed ("S4: Needs a fix: “button too small”", "moved S1, S2"), so an
// agent reading `adl context` knows exactly what the person did since its last look.
import { jsonEqual } from './json.ts';
import { type Docs, pageIdOf, type SetOp } from './ops.ts';
import { findStatus } from './status.ts';
import type { Arrow, Item, PageDoc } from './types.ts';

const q = (s: string | undefined, max = 80) => `“${(s ?? '').length > max ? `${s!.slice(0, max - 1)}…` : (s ?? '')}”`;

export function describeChanges(before: Docs, after: Docs, ops: readonly SetOp[], max = 12): string[] {
  const out: string[] = [];
  const moved: string[] = [];
  const pages = new Set<string>();
  let projectTouched = false;
  // "<page>/<id>" of items this transaction moved to the History page
  const archivedNow = new Set<string>();
  for (const op of ops) {
    const p = pageIdOf(op.doc);
    if (p) pages.add(p);
    else projectTouched = true;
    const v = op.value as Item | undefined;
    if (p === 'history' && op.path[0] === 'items' && op.path[1] && v?.archived)
      archivedNow.add(`${v.archived.from}/${v.kind === 'screen' && v.screen ? v.screen : op.path[1]}`);
  }
  for (const pid of pages) {
    const a = before.pages[pid];
    const b = after.pages[pid];
    if (!a && b) {
      out.push(`new page ${q(b.name)}`);
      continue;
    }
    if (a && !b) {
      out.push(`deleted the page ${q(a.name)}`);
      continue;
    }
    if (!a || !b) continue;
    if (a.name !== b.name) out.push(`renamed the page ${q(a.name)} to ${q(b.name)}`);
    const where = pid === (after.project.sourceOfTruth ?? '') ? '' : ` (page ${pid})`;
    const ids = new Set<string>();
    const arrows = new Set<string>();
    for (const op of ops) {
      if (op.doc !== `page:${pid}`) continue;
      if (op.path[0] === 'items' && op.path[1]) ids.add(op.path[1]);
      if (op.path[0] === 'arrows' && op.path[1]) arrows.add(op.path[1]);
      if (op.path[0] === 'arrows' && !op.path[1]) for (const k of Object.keys(b.arrows)) arrows.add(k);
      if (op.path[0] === 'items' && !op.path[1]) for (const k of Object.keys(b.items)) ids.add(k);
    }
    for (const id of ids) describeItem(after, pid, id, a.items[id], b.items[id], where, out, moved, archivedNow);
    for (const id of arrows) describeArrow(a, b, id, a.arrows[id], b.arrows[id], where, out);
  }
  if (moved.length)
    out.push(`moved ${moved.slice(0, 8).join(', ')}${moved.length > 8 ? ` and ${moved.length - 8} more` : ''}`);
  if (projectTouched) describeProject(before, after, out);
  return out.length > max ? [...out.slice(0, max - 1), `and ${out.length - max + 1} more changes`] : out;
}

function statusText(docs: Docs, it: Item | undefined): string {
  if (it?.kind !== 'screen') return '';
  const def = it.status ? findStatus(docs.project, it.status) : undefined;
  return def?.label ?? it.status ?? 'no status';
}

function describeItem(
  docs: Docs,
  pid: string,
  id: string,
  a: Item | undefined,
  b: Item | undefined,
  where: string,
  out: string[],
  moved: string[],
  archivedNow: Set<string>,
) {
  if (pid === 'history') {
    if (!a && b?.archived) out.push(`${id} went to History (${b.archived.reason})`);
    else if (a && !b) out.push(`restored ${id} from History`);
    return;
  }
  if (!a && b) {
    if (b.kind === 'screen') out.push(`placed ${id}${where}`);
    else if (b.kind === 'note') out.push(`note${b.anchor ? ` on ${b.anchor}` : ''}${where}: ${q(b.text)}`);
    else if (b.kind === 'section') out.push(`new section ${q(b.title)}${where}`);
    else if (b.kind === 'text') out.push(`text${where}: ${q(b.text)}`);
    else out.push(`added ${b.kind} ${id}${where}`);
    return;
  }
  if (a && !b) {
    if (archivedNow.has(`${pid}/${id}`)) return; // the History line says it
    out.push(`removed ${a.kind === 'screen' ? 'screen' : a.kind} ${id}${where}`);
    return;
  }
  if (!a || !b) return;
  if (a.kind === 'screen' && b.kind === 'screen') {
    if (a.status !== b.status) {
      out.push(`${id}: ${statusText(docs, a)} → ${statusText(docs, b)}${b.banner ? `: ${q(b.banner)}` : ''}`);
    } else if ((a.banner ?? '') !== (b.banner ?? '')) out.push(`${id}: banner ${b.banner ? q(b.banner) : 'removed'}`);
    if (a.title !== b.title && b.title) out.push(`${id}: caption ${q(b.title)}`);
    if (a.frame !== b.frame) out.push(`${id}: frame ${b.frame ?? 'default'}`);
    if (a.entry !== b.entry && b.entry) out.push(`${id} is where the flow starts`);
  }
  if ((a.kind === 'note' || a.kind === 'text') && (b.kind === 'note' || b.kind === 'text') && a.text !== b.text)
    out.push(`${b.kind} ${id}: ${q(b.text)}`);
  if (a.kind === 'note' && b.kind === 'note' && a.resolved !== b.resolved && b.resolved)
    out.push(`resolved note ${id}`);
  if (a.kind === 'section' && b.kind === 'section' && a.title !== b.title) out.push(`section renamed to ${q(b.title)}`);
  if (a.x !== b.x || a.y !== b.y || a.parent !== b.parent) moved.push(id);
  else if (
    !jsonEqual((a as { w?: number }).w, (b as { w?: number }).w) ||
    !jsonEqual((a as { h?: number }).h, (b as { h?: number }).h)
  )
    out.push(`resized ${id}`);
}

function arrowText(x: Arrow) {
  return `${x.from} → ${x.to}${x.label ? ` ${q(x.label, 40)}` : ''}`;
}

function describeArrow(
  _a: PageDoc,
  _b: PageDoc,
  _id: string,
  x: Arrow | undefined,
  y: Arrow | undefined,
  where: string,
  out: string[],
) {
  if (!x && y) out.push(`arrow ${arrowText(y)}${where}`);
  else if (x && !y) out.push(`removed arrow ${arrowText(x)}${where}`);
  else if (x && y) {
    if ((x.label ?? '') !== (y.label ?? '')) out.push(`arrow ${x.from} → ${x.to}: label ${q(y.label ?? '', 40)}`);
    if ((x.style ?? '') !== (y.style ?? '')) out.push(`arrow ${x.from} → ${x.to}: style ${y.style ?? 'flow'}`);
    if (x.from !== y.from || x.to !== y.to) out.push(`arrow now ${y.from} → ${y.to}`);
  }
}

function describeProject(before: Docs, after: Docs, out: string[]) {
  const a = before.project;
  const b = after.project;
  const sa = new Map((a.statuses ?? []).map((s) => [s.id, s]));
  const sb = new Map((b.statuses ?? []).map((s) => [s.id, s]));
  for (const [id, s] of sb) {
    const old = sa.get(id);
    if (!old) out.push(`new status ${q(s.label)}`);
    else if (!jsonEqual(old, s)) out.push(`status ${q(s.label)} changed`);
  }
  for (const [id, s] of sa) if (!sb.has(id)) out.push(`deleted status ${q(s.label)}`);
  if (a.sourceOfTruth !== b.sourceOfTruth && b.sourceOfTruth)
    out.push(`the source of truth is now page ${b.sourceOfTruth}`);
  if (!jsonEqual(a.pages, b.pages) && a.pages.length === b.pages.length) out.push('reordered pages');
  if (a.name !== b.name) out.push(`renamed the project to ${q(b.name)}`);
}
