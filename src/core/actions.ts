// High-level edits as transactions. The app applies them optimistically, the server applies them for the CLI and the
// HTTP API, so a person clicking "Approve" and an agent running `adl status T4 approved` produce the same ops.

import { arrowId, freeId, pageIdFromName, shortId } from './ids.ts';
import { clone } from './json.ts';
import { applyOps, type Docs, getIn, pageKey, type SetOp } from './ops.ts';
import { portalTarget } from './reach.ts';
import { DEFAULT_ARROW_STYLES, DEFAULT_STATUSES, slugify } from './status.ts';
import type {
  Actor,
  Arrow,
  Handover,
  Id,
  Item,
  NoteColor,
  PageDoc,
  ProjectDoc,
  ScreenItem,
  StatusDef,
} from './types.ts';

export const HISTORY_PAGE = 'history';

/** Accumulates ops and keeps a working copy so later steps see earlier ones. */
export class Tx {
  docs: Docs;
  ops: SetOp[] = [];
  constructor(docs: Docs) {
    this.docs = docs;
  }
  set(doc: SetOp['doc'], path: string[], value: unknown): this {
    const r = applyOps(this.docs, [{ doc, path, value }]);
    this.docs = r.docs;
    this.ops.push(...r.ops);
    return this;
  }
  page(id: string): PageDoc {
    const p = this.docs.pages[id];
    if (!p) throw new Error(`Page "${id}" does not exist`);
    return p;
  }
  item(page: string, id: Id): Item {
    const it = this.page(page).items[id];
    if (!it) throw new Error(`"${id}" is not on page "${page}"`);
    return it;
  }
  setItem(page: string, id: Id, value: Item | undefined) {
    return this.set(pageKey(page), ['items', id], value);
  }
  setField(page: string, id: Id, field: string, value: unknown) {
    return this.set(pageKey(page), ['items', id, field], value);
  }
  setArrow(page: string, id: Id, value: Arrow | undefined) {
    return this.set(pageKey(page), ['arrows', id], value);
  }
}

export function newProjectDoc(
  name: string,
  opts: { frame?: string; pages?: { id: string; name: string }[] } = {},
): ProjectDoc {
  const pages = opts.pages ?? [{ id: 'truth', name: 'Source of truth' }];
  return {
    adl: 1,
    rev: 0,
    name,
    pages: pages.map((p) => p.id),
    sourceOfTruth: pages[0]!.id,
    frame: opts.frame ?? 'iphone-16',
    styles: [],
    fonts: [],
    statuses: clone(DEFAULT_STATUSES),
    defaultStatus: 'new',
    arrowStyles: clone(DEFAULT_ARROW_STYLES),
    snapshotAt: 1200,
  };
}

export function newPageDoc(name: string, kind?: PageDoc['kind']): PageDoc {
  return { adl: 1, rev: 0, name, ...(kind ? { kind } : {}), items: {}, arrows: {} };
}

// ---------- status ----------

export function setStatus(docs: Docs, page: string, ids: Id[], status: string | undefined, banner?: string): SetOp[] {
  const tx = new Tx(docs);
  const def = docs.project.statuses?.find((s) => s.id === status);
  for (const id of ids) {
    const it = tx.page(page).items[id];
    if (it?.kind !== 'screen') continue;
    tx.setField(page, id, 'status', status);
    if (banner !== undefined) tx.setField(page, id, 'banner', banner || undefined);
    else if (def?.role === 'approved') tx.setField(page, id, 'banner', undefined);
  }
  return tx.ops;
}

export function approvedStatusId(project: ProjectDoc): string {
  return (project.statuses ?? DEFAULT_STATUSES).find((s) => s.role === 'approved')?.id ?? 'approved';
}

export function approve(docs: Docs, page: string, ids: Id[]): SetOp[] {
  return setStatus(docs, page, ids, approvedStatusId(docs.project));
}

export function addStatus(docs: Docs, def: Omit<StatusDef, 'id'> & { id?: string }): { ops: SetOp[]; id: string } {
  const list = clone(docs.project.statuses ?? DEFAULT_STATUSES);
  const id = def.id ?? freeId(slugify(def.label), (x) => list.some((s) => s.id === x)).replace('~', '-');
  list.push({ ...def, id } as StatusDef);
  const tx = new Tx(docs).set('project', ['statuses'], list);
  return { ops: tx.ops, id };
}

export function updateStatusDef(docs: Docs, id: string, patch: Partial<StatusDef>): SetOp[] {
  const list = clone(docs.project.statuses ?? DEFAULT_STATUSES).map((s) => (s.id === id ? { ...s, ...patch, id } : s));
  return new Tx(docs).set('project', ['statuses'], list).ops;
}

/** Delete a status; screens using it move to `replacement` (or no status). */
export function deleteStatusDef(docs: Docs, id: string, replacement?: string): SetOp[] {
  const tx = new Tx(docs);
  const list = clone(docs.project.statuses ?? DEFAULT_STATUSES).filter((s) => s.id !== id);
  tx.set('project', ['statuses'], list);
  for (const [pid, page] of Object.entries(docs.pages))
    for (const [iid, it] of Object.entries(page.items))
      if (it.kind === 'screen' && it.status === id) tx.setField(pid, iid, 'status', replacement);
  return tx.ops;
}

// ---------- items ----------

export interface Move {
  id: Id;
  x: number;
  y: number;
  parent?: Id | null;
}

/** Move items (positions relative to their new parent). Human moves pin the items. */
export function moveItems(docs: Docs, page: string, moves: Move[], actor: Actor): SetOp[] {
  const tx = new Tx(docs);
  for (const m of moves) {
    const it = tx.page(page).items[m.id];
    if (!it) continue;
    const next: Item = { ...it, x: Math.round(m.x), y: Math.round(m.y) };
    if (m.parent === null) delete next.parent;
    else if (m.parent !== undefined) next.parent = m.parent;
    if (actor === 'human') next.pinned = true;
    tx.setItem(page, m.id, next);
  }
  return tx.ops;
}

export function resizeItem(docs: Docs, page: string, id: Id, size: { w?: number; h?: number }, actor: Actor): SetOp[] {
  const tx = new Tx(docs);
  if (size.w !== undefined) tx.setField(page, id, 'w', Math.round(size.w));
  if (size.h !== undefined) tx.setField(page, id, 'h', Math.round(size.h));
  if (actor === 'human') tx.setField(page, id, 'pinned', true);
  return tx.ops;
}

export function addItem(docs: Docs, page: string, item: Item, idHint?: string): { ops: SetOp[]; id: Id } {
  const p = docs.pages[page];
  if (!p) throw new Error(`Page "${page}" does not exist`);
  const taken = (x: string) => x in p.items;
  const prefix =
    item.kind === 'note'
      ? 'n-'
      : item.kind === 'text'
        ? 't-'
        : item.kind === 'section'
          ? 's-'
          : item.kind === 'portal'
            ? 'p-'
            : 'i-';
  const id = idHint ? freeId(idHint, taken) : shortId(prefix, taken);
  const tx = new Tx(docs).setItem(page, id, item);
  return { ops: tx.ops, id };
}

export function addNote(
  docs: Docs,
  page: string,
  note: {
    text: string;
    x?: number;
    y?: number;
    color?: NoteColor;
    anchor?: Id;
    parent?: Id;
    w?: number;
    size?: 'small' | 'normal';
  },
  actor: Actor,
) {
  const item: Item = { kind: 'note', text: note.text, color: note.color ?? 'yellow', by: actor };
  if (note.size === 'small') (item as { size?: string }).size = 'small';
  if (note.x !== undefined) item.x = Math.round(note.x);
  if (note.y !== undefined) item.y = Math.round(note.y);
  if (note.anchor) (item as { anchor?: string }).anchor = note.anchor;
  if (note.parent) item.parent = note.parent;
  if (note.w) (item as { w?: number }).w = note.w;
  return addItem(docs, page, item);
}

/** Remove items from the page. Screens are only unplaced (their HTML file stays). Arrows touching them go too;
 *  notes anchored to them stay where they are. Children of a removed section are kept at the same spot. A removed
 *  screen's first option takes its place (arrows, notes, spot), the others become options for it. */
export function removeItems(
  docs: Docs,
  page: string,
  ids: Id[],
  abs?: (id: Id) => { x: number; y: number } | undefined,
): SetOp[] {
  const tx = new Tx(docs);
  const gone = new Set(ids);
  handOverOptions(tx, page, ids);
  const p = tx.page(page);
  for (const [aid, a] of Object.entries(p.arrows))
    if (gone.has(a.from) || gone.has(a.to) || gone.has(aid)) tx.setArrow(page, aid, undefined);
  for (const [id, it] of Object.entries(p.items)) {
    if (gone.has(id)) continue;
    if (it.kind === 'note' && it.anchor && gone.has(it.anchor)) {
      const a = abs?.(id);
      const next = { ...it } as Item & { anchor?: string };
      delete next.anchor;
      if (a) {
        next.x = Math.round(a.x);
        next.y = Math.round(a.y);
      }
      tx.setItem(page, id, next);
    }
    if (it.parent && gone.has(it.parent)) {
      const a = abs?.(id);
      const next = { ...it };
      delete next.parent;
      if (a) {
        next.x = Math.round(a.x);
        next.y = Math.round(a.y);
      }
      tx.setItem(page, id, next);
    }
  }
  for (const id of ids) tx.setItem(page, id, undefined);
  return tx.ops;
}

/** A removed screen's options stay options: the first one left takes its place in the flow (as "Use instead" would)
 *  and the others become options for it. Repeated, so an option of a removed option climbs to the next screen that
 *  stays. Returns [removed, heir] pairs in the order they happened. */
function handOverOptions(tx: Tx, page: string, ids: Id[]): [Id, Id][] {
  const gone = new Set(ids);
  const done: [Id, Id][] = [];
  for (let moved = true; moved; ) {
    moved = false;
    for (const id of ids) {
      if (tx.page(page).items[id]?.kind !== 'screen') continue;
      const [heir, ...rest] = Object.entries(tx.page(page).items)
        .filter(([o, it]) => !gone.has(o) && it.kind === 'screen' && !it.archived && it.proposalFor === id)
        .map(([o]) => o);
      if (!heir) continue;
      takePlace(tx, page, heir, id, rest);
      for (const o of rest) tx.setField(page, o, 'proposalFor', heir);
      done.push([id, heir]);
      moved = true;
    }
  }
  return done;
}

/** Which option takes whose place when these items are removed (for the canvas toast and `adl remove`). */
export function removalHeirs(docs: Docs, page: string, ids: Id[]): [Id, Id][] {
  return handOverOptions(new Tx(docs), page, ids);
}

// ---------- arrows ----------

export function addArrow(
  docs: Docs,
  page: string,
  from: Id,
  to: Id,
  props: Partial<Arrow> = {},
): { ops: SetOp[]; id: Id } {
  const p = docs.pages[page];
  if (!p) throw new Error(`Page "${page}" does not exist`);
  const id = arrowId(from, to, (x) => x in p.arrows);
  const arrow: Arrow = { from, to, ...props };
  return { ops: new Tx(docs).setArrow(page, id, arrow).ops, id };
}

/** Fields to change on an arrow; `undefined` removes the field. */
export type ArrowPatch = { [K in keyof Arrow]?: Arrow[K] | undefined };

export function updateArrow(docs: Docs, page: string, id: Id, patch: ArrowPatch, actor: Actor): SetOp[] {
  const tx = new Tx(docs);
  const a = tx.page(page).arrows[id];
  if (!a) return [];
  const next = { ...a, ...patch } as Arrow;
  for (const k of Object.keys(patch))
    if ((patch as Record<string, unknown>)[k] === undefined) delete (next as Record<string, unknown>)[k];
  if (actor === 'human' && ('waypoints' in patch || 'fromSide' in patch || 'toSide' in patch)) next.pinned = true;
  // re-attaching an end changes the id so ids stay readable
  if (patch.from || patch.to) {
    const nid = arrowId(next.from, next.to, (x) => x !== id && x in tx.page(page).arrows);
    tx.setArrow(page, id, undefined);
    tx.setArrow(page, nid, next);
  } else tx.setArrow(page, id, next);
  return tx.ops;
}

export function reverseArrow(docs: Docs, page: string, id: Id): SetOp[] {
  const a = docs.pages[page]?.arrows[id];
  if (!a) return [];
  const patch: Record<string, unknown> = { from: a.to, to: a.from };
  if (a.fromSide || a.toSide) {
    patch.fromSide = a.toSide;
    patch.toSide = a.fromSide;
  }
  return updateArrow(docs, page, id, patch as ArrowPatch, 'human');
}

// ---------- pages ----------

export function addPage(
  docs: Docs,
  name: string,
  kind?: PageDoc['kind'],
  afterId?: string,
): { ops: SetOp[]; id: string } {
  const id = pageIdFromName(name, (x) => x in docs.pages || docs.project.pages.includes(x));
  const order = [...docs.project.pages];
  // new pages go after `afterId`, else at the end but before History
  const history = order.indexOf(HISTORY_PAGE);
  const at = afterId && order.includes(afterId) ? order.indexOf(afterId) + 1 : history >= 0 ? history : order.length;
  order.splice(at, 0, id);
  const tx = new Tx(docs).set(pageKey(id), [], newPageDoc(name, kind)).set('project', ['pages'], order);
  return { ops: tx.ops, id };
}

export function renamePage(docs: Docs, id: string, name: string): SetOp[] {
  return new Tx(docs).set(pageKey(id), ['name'], name).ops;
}

export function reorderPages(docs: Docs, order: string[]): SetOp[] {
  return new Tx(docs).set('project', ['pages'], order).ops;
}

export function deletePage(docs: Docs, id: string): SetOp[] {
  const tx = new Tx(docs);
  tx.set(
    'project',
    ['pages'],
    docs.project.pages.filter((p) => p !== id),
  );
  if (docs.project.sourceOfTruth === id)
    tx.set(
      'project',
      ['sourceOfTruth'],
      docs.project.pages.find((p) => p !== id),
    );
  tx.set(pageKey(id), [], undefined);
  return tx.ops;
}

export function duplicatePage(docs: Docs, id: string): { ops: SetOp[]; id: string } {
  const src = docs.pages[id];
  if (!src) throw new Error(`Page "${id}" does not exist`);
  const r = addPage(docs, `${src.name} copy`, src.kind, id);
  const tx = new Tx(docs);
  tx.ops.push(...r.ops);
  tx.docs = applyOps(docs, r.ops).docs;
  tx.set(pageKey(r.id), ['items'], clone(src.items));
  tx.set(pageKey(r.id), ['arrows'], clone(src.arrows));
  return { ops: tx.ops, id: r.id };
}

// ---------- proposals and history ----------

function ensureHistory(tx: Tx) {
  if (tx.docs.pages[HISTORY_PAGE]) return;
  tx.set(pageKey(HISTORY_PAGE), [], newPageDoc('History', 'history'));
  if (!tx.docs.project.pages.includes(HISTORY_PAGE))
    tx.set('project', ['pages'], [...tx.docs.project.pages, HISTORY_PAGE]);
}

function daySection(tx: Tx, at: string): Id {
  const day = at.slice(0, 10);
  const id = `day-${day}`;
  if (!tx.page(HISTORY_PAGE).items[id]) {
    const d = new Date(`${day}T12:00:00Z`);
    const title = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    tx.setItem(HISTORY_PAGE, id, { kind: 'section', title });
  }
  return id;
}

/** Move items to the History page with everything needed to restore them later. */
export function archiveItems(
  tx: Tx,
  page: string,
  ids: Id[],
  reason: string,
  actor: Actor,
  extra: { replacedBy?: Id; note?: string; handover?: Handover } = {},
) {
  ensureHistory(tx);
  const at = new Date().toISOString();
  const day = daySection(tx, at);
  const p = tx.page(page);
  for (const id of ids) {
    const it = p.items[id];
    if (!it) continue;
    const arrows: Record<Id, Arrow> = {};
    for (const [aid, a] of Object.entries(tx.page(page).arrows)) {
      if (a.from === id || a.to === id) {
        arrows[aid] = a;
        tx.setArrow(page, aid, undefined);
      }
    }
    const hp = tx.page(HISTORY_PAGE);
    const hid = freeId(id, (x) => x in hp.items);
    const archived: Item = {
      ...clone(it),
      parent: day,
      archived: {
        at,
        by: actor,
        reason,
        from: page,
        was: { parent: it.parent, x: it.x, y: it.y, status: it.kind === 'screen' ? it.status : undefined },
        arrows,
        ...extra,
      },
    } as Item;
    delete archived.x;
    delete archived.y;
    delete (archived as { pinned?: boolean }).pinned;
    if (archived.kind === 'screen' && hid !== id && !archived.screen) archived.screen = id;
    if (archived.archived) {
      for (const k of Object.keys(archived.archived) as (keyof NonNullable<Item['archived']>)[])
        if (archived.archived[k] === undefined) delete archived.archived[k];
    }
    tx.setItem(page, id, undefined);
    tx.setItem(HISTORY_PAGE, hid, archived);
    // notes on it (what it shows, why) go along and stay on it; a restore brings them back
    for (const [nid, n] of Object.entries(tx.page(page).items)) {
      if (n.kind !== 'note' || n.anchor !== id) continue;
      tx.setItem(page, nid, undefined);
      tx.setItem(
        HISTORY_PAGE,
        freeId(nid, (x) => x in tx.page(HISTORY_PAGE).items),
        { ...n, anchor: hid, parent: day },
      );
    }
    // a portal only it led to would lead from nowhere: it goes along too (restoring this item brings it back)
    const orphans = Object.values(arrows)
      .map((a) => a.to)
      .filter((to, i, all) => all.indexOf(to) === i && tx.page(page).items[to]?.kind === 'portal')
      .filter((to) => !Object.values(tx.page(page).arrows).some((a) => a.to === to));
    if (orphans.length) archiveItems(tx, page, orphans, `went with ${id}`, actor);
  }
}

/** The proposal takes the place of the screen it is an option for: its spot, section, entry flag and place in a
 *  chain of options, its arrows, the notes on it and the portals that stand for it. Links from that screen to its
 *  other options (`siblings`) start at the proposal. Used by "Use instead" and when a screen with options is removed. */
function takePlace(tx: Tx, page: string, proposalId: Id, targetId: Id, siblings: Id[]): Handover {
  const handover: Handover = { arrows: [], notes: [], portals: [] };
  const P = tx.item(page, proposalId) as ScreenItem;
  const T = tx.item(page, targetId);
  // 1. the proposal takes the original's spot, including its place in a chain of options (an option of an option
  //    becomes the option for what the replaced screen was an option for)
  const next: ScreenItem = { ...P };
  const up = T.kind === 'screen' ? (T as ScreenItem).proposalFor : undefined;
  if (up) next.proposalFor = up;
  else delete next.proposalFor;
  if (T.parent !== undefined) next.parent = T.parent;
  else delete next.parent;
  if (T.x !== undefined && T.y !== undefined) {
    next.x = T.x;
    next.y = T.y;
  } else {
    delete next.x;
    delete next.y;
  }
  if ((T as ScreenItem).entry) next.entry = true;
  tx.setItem(page, proposalId, next);
  // 2. arrows to and from the original now point at the proposal (except the proposal links themselves); one that
  //    would repeat an arrow the proposal already has between the same two screens is merged into that one
  const proposalSet = new Set([proposalId, ...siblings]);
  const pair = (a: Arrow) => JSON.stringify([a.from, a.to]);
  const own = new Set(
    Object.values(tx.page(page).arrows)
      .filter((a) => a.from === proposalId || a.to === proposalId)
      .map(pair),
  );
  for (const [aid, a] of Object.entries(tx.page(page).arrows)) {
    const linksProposal =
      (a.from === targetId && proposalSet.has(a.to)) || (a.to === targetId && proposalSet.has(a.from));
    if (linksProposal) {
      tx.setArrow(page, aid, undefined);
      if (a.from === targetId && a.to === proposalId) handover.link = { id: aid, arrow: a };
      // the link to another option now starts at the proposal (after a pick, History keeps it with that option)
      const other = a.from === targetId ? a.to : a.from;
      if (other !== proposalId) {
        const moved: Arrow = {
          ...a,
          from: a.from === targetId ? proposalId : a.from,
          to: a.to === targetId ? proposalId : a.to,
        };
        tx.setArrow(
          page,
          arrowId(moved.from, moved.to, (x) => x in tx.page(page).arrows),
          moved,
        );
      }
      continue;
    }
    if (a.from !== targetId && a.to !== targetId) continue;
    const moved: Arrow = {
      ...a,
      from: a.from === targetId ? proposalId : a.from,
      to: a.to === targetId ? proposalId : a.to,
    };
    if (moved.from === moved.to && a.from !== a.to) continue;
    tx.setArrow(page, aid, undefined);
    if (own.has(pair(moved))) {
      handover.merged = [...(handover.merged ?? []), { id: aid, arrow: moved }];
      continue;
    }
    const nid = arrowId(moved.from, moved.to, (x) => x in tx.page(page).arrows);
    tx.setArrow(page, nid, moved);
    handover.arrows.push(nid);
  }
  // 3. notes on the original (where it sits in the flow, what leads there) now sit on the pick, and portals that
  //    stand for the original (on any page) lead to the pick, so other flows still arrive
  for (const [nid, it] of Object.entries(tx.page(page).items))
    if (it.kind === 'note' && it.anchor === targetId) {
      tx.setItem(page, nid, { ...it, anchor: proposalId });
      handover.notes.push(nid);
    }
  for (const [pid, pg] of Object.entries(tx.docs.pages)) {
    if (pg.kind === 'history') continue;
    for (const [iid, it] of Object.entries(pg.items)) {
      if (it.kind !== 'portal' || !it.target || it.archived) continue;
      const t = portalTarget(pid, it.target);
      if (t.page !== page || t.id !== targetId) continue;
      tx.setItem(pid, iid, { ...it, target: pid === page ? proposalId : `page:${page}/${proposalId}` });
      handover.portals.push({ page: pid, id: iid });
    }
  }
  return handover;
}

/** "Use instead of S6": the proposal takes the original's place and arrows; the original and the other proposals move
 *  to History. The pick does not approve anything. */
export function pickProposal(
  docs: Docs,
  page: string,
  proposalId: Id,
  actor: Actor,
): { ops: SetOp[]; replaced: Id; archived: Id[] } {
  const tx = new Tx(docs);
  const P = tx.item(page, proposalId) as ScreenItem;
  const targetId = P.proposalFor;
  if (P.kind !== 'screen' || !targetId) throw new Error(`${proposalId} is not a proposal`);
  const p = tx.page(page);
  const siblings = Object.entries(p.items)
    .filter(([id, it]) => id !== proposalId && it.kind === 'screen' && it.proposalFor === targetId)
    .map(([id]) => id);
  const handover = takePlace(tx, page, proposalId, targetId, siblings);
  // the original and the other proposals go to History
  archiveItems(tx, page, [targetId], 'replaced', actor, { replacedBy: proposalId, handover });
  if (siblings.length) archiveItems(tx, page, siblings, 'not picked', actor, { replacedBy: proposalId });
  return { ops: tx.ops, replaced: targetId, archived: [targetId, ...siblings] };
}

export function rejectProposal(docs: Docs, page: string, proposalId: Id, actor: Actor, note?: string): SetOp[] {
  const tx = new Tx(docs);
  archiveItems(tx, page, [proposalId], 'rejected', actor, note ? { note } : {});
  return tx.ops;
}

/** Put an archived item back where it was (nudged when the spot is taken) with the arrows that still make sense. */
export function restoreFromHistory(docs: Docs, historyId: Id): { ops: SetOp[]; page: string; id: Id } {
  const tx = new Tx(docs);
  const r = restoreInto(tx, historyId);
  return { ops: tx.ops, ...r };
}

function restoreInto(tx: Tx, historyId: Id): { page: string; id: Id } {
  const it = tx.item(HISTORY_PAGE, historyId);
  const a = it.archived;
  if (!a) throw new Error(`${historyId} is not archived`);
  const page = tx.docs.pages[a.from] ? a.from : (tx.docs.project.sourceOfTruth ?? tx.docs.project.pages[0]!);
  const target = tx.page(page);
  const baseId = it.kind === 'screen' && it.screen && !(it.screen in target.items) ? it.screen : historyId;
  const id = freeId(baseId, (x) => x in target.items);
  const back = clone(it) as Item;
  delete back.archived;
  delete back.parent;
  if (a.was?.parent && target.items[a.was.parent]?.kind === 'section') back.parent = a.was.parent;
  if (a.was?.x !== undefined && a.was?.y !== undefined) {
    back.x = a.was.x;
    back.y = a.was.y;
  }
  if (back.kind === 'screen') {
    if (a.was?.status !== undefined) back.status = a.was.status;
    else delete back.status;
    if (back.screen === id) delete back.screen;
  }
  // an option that was not picked: the screen it was an option for has been replaced, so it becomes an option for
  // the replacement (and its arrows follow)
  const gone =
    back.kind === 'screen' && back.proposalFor && !target.items[back.proposalFor] ? back.proposalFor : undefined;
  const heir = gone && a.replacedBy && target.items[a.replacedBy] ? a.replacedBy : undefined;
  if (back.kind === 'screen' && gone) {
    if (heir) back.proposalFor = heir;
    else delete back.proposalFor;
  }
  // an option that was not picked, restored after its screen came back (the pick was undone): the link the pick
  // took over from that screen starts at the screen again
  const R = a.replacedBy ? target.items[a.replacedBy] : undefined;
  const undone =
    back.kind === 'screen' &&
    back.proposalFor &&
    target.items[back.proposalFor] &&
    R?.kind === 'screen' &&
    R.proposalFor === back.proposalFor
      ? back.proposalFor
      : undefined;
  const alias = (x: Id) =>
    x === historyId || x === baseId ? id : x === gone && heir ? heir : undone && x === a.replacedBy ? undone : x;
  tx.setItem(page, id, back);
  if (a.reason === 'replaced' && a.replacedBy) undoPick(tx, page, id, back, a.replacedBy, a.handover);
  for (const arrow of Object.values(a.arrows ?? {})) {
    const from = alias(arrow.from);
    const to = alias(arrow.to);
    // a portal that went to History with it comes back with it
    const went = tx.page(HISTORY_PAGE).items[to];
    if (!tx.page(page).items[to] && went?.kind === 'portal' && went.archived?.from === page) restoreInto(tx, to);
    if (!tx.page(page).items[from] || !tx.page(page).items[to]) continue;
    const nid = arrowId(from, to, (x) => x in tx.page(page).arrows);
    tx.setArrow(page, nid, { ...arrow, from, to });
  }
  tx.setItem(HISTORY_PAGE, historyId, undefined);
  // the notes that went to History with it come back on it
  for (const [nid, n] of Object.entries(tx.page(HISTORY_PAGE).items)) {
    if (n.kind !== 'note' || n.anchor !== historyId) continue;
    const note = { ...n, anchor: id };
    if (back.parent) note.parent = back.parent;
    else delete note.parent;
    tx.setItem(HISTORY_PAGE, nid, undefined);
    tx.setItem(
      page,
      freeId(nid, (x) => x in tx.page(page).items),
      note,
    );
  }
  return { page, id };
}

/** Restoring a screen a pick replaced undoes that pick: the pick becomes its option again and hands back what it took
 *  over (arrows, the link to it, notes, portals on any page). A record from before picks kept that list: every arrow
 *  and portal of the pick goes back (an option has none of its own until it is picked), notes stay on the pick. */
function undoPick(tx: Tx, page: string, id: Id, back: Item, heirId: Id, handover: Handover | undefined) {
  const H = tx.page(page).items[heirId];
  if (H?.kind !== 'screen' || back.kind !== 'screen') return;
  const swap = (x: Id) => (x === heirId ? id : x);
  const arrowIds =
    handover?.arrows ??
    Object.entries(tx.page(page).arrows)
      .filter(([, ar]) => ar.from === heirId || ar.to === heirId)
      .map(([aid]) => aid);
  for (const aid of arrowIds) {
    const ar = tx.page(page).arrows[aid];
    if (!ar || (ar.from !== heirId && ar.to !== heirId)) continue;
    tx.setArrow(page, aid, undefined);
    const moved: Arrow = { ...ar, from: swap(ar.from), to: swap(ar.to) };
    tx.setArrow(
      page,
      arrowId(moved.from, moved.to, (x) => x in tx.page(page).arrows),
      moved,
    );
  }
  // the arrows the pick's own arrows stood in for come back on the restored screen
  for (const m of handover?.merged ?? []) {
    const moved: Arrow = { ...m.arrow, from: swap(m.arrow.from), to: swap(m.arrow.to) };
    tx.setArrow(
      page,
      arrowId(moved.from, moved.to, (x) => x in tx.page(page).arrows),
      moved,
    );
  }
  if (handover?.link)
    tx.setArrow(
      page,
      arrowId(id, heirId, (x) => x in tx.page(page).arrows),
      { ...handover.link.arrow, from: id, to: heirId },
    );
  for (const nid of handover?.notes ?? []) {
    const n = tx.page(page).items[nid];
    if (n?.kind === 'note' && n.anchor === heirId) tx.setItem(page, nid, { ...n, anchor: id });
  }
  const portals =
    handover?.portals ??
    Object.entries(tx.docs.pages).flatMap(([pid, pg]) =>
      pg.kind === 'history' ? [] : Object.keys(pg.items).map((iid) => ({ page: pid, id: iid })),
    );
  for (const ref of portals) {
    const it = tx.docs.pages[ref.page]?.items[ref.id];
    if (it?.kind !== 'portal' || !it.target || it.archived) continue;
    const t = portalTarget(ref.page, it.target);
    if (t.page !== page || t.id !== heirId) continue;
    tx.setItem(ref.page, ref.id, { ...it, target: ref.page === page ? id : `page:${page}/${id}` });
  }
  const next = { ...H, proposalFor: id } as ScreenItem;
  delete next.x;
  delete next.y;
  if (back.parent !== undefined) next.parent = back.parent;
  if (back.entry) delete next.entry;
  tx.setItem(page, heirId, next);
}

/** Copy items to another position or page (screens keep pointing at the same HTML file). */
export function duplicateItems(
  docs: Docs,
  fromPage: string,
  toPage: string,
  ids: Id[],
  dx: number,
  dy: number,
): { ops: SetOp[]; idMap: Record<Id, Id> } {
  const tx = new Tx(docs);
  const src = tx.page(fromPage);
  const idMap: Record<Id, Id> = {};
  for (const id of ids) {
    const it = src.items[id];
    if (!it) continue;
    const copy = clone(it) as Item;
    delete copy.pinned;
    if (copy.kind === 'screen' && !copy.screen) copy.screen = id;
    if (copy.x !== undefined) copy.x = Math.round(copy.x + dx);
    if (copy.y !== undefined) copy.y = Math.round(copy.y + dy);
    if (copy.parent && !tx.page(toPage).items[copy.parent] && !ids.includes(copy.parent)) delete copy.parent;
    const nid = freeId(id, (x) => x in tx.page(toPage).items || Object.values(idMap).includes(x));
    idMap[id] = nid;
    tx.setItem(toPage, nid, copy);
  }
  for (const [oid, nid] of Object.entries(idMap)) {
    const it = tx.page(toPage).items[nid]!;
    if (it.parent && idMap[it.parent]) tx.setField(toPage, nid, 'parent', idMap[it.parent]);
    if (it.kind === 'note' && it.anchor && idMap[it.anchor]) tx.setField(toPage, nid, 'anchor', idMap[it.anchor]);
    void oid;
  }
  for (const a of Object.values(src.arrows)) {
    if (idMap[a.from] && idMap[a.to]) {
      const from = idMap[a.from]!;
      const to = idMap[a.to]!;
      tx.setArrow(
        toPage,
        arrowId(from, to, (x) => x in tx.page(toPage).arrows),
        { ...clone(a), from, to },
      );
    }
  }
  return { ops: tx.ops, idMap };
}

export { getIn };
