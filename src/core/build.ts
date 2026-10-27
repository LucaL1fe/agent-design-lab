// The build check: does the real product match each screen and flow? It is separate from the design status (which
// says whether the design is decided): a screen can be approved and not built yet, or built and deviating. Captures
// (screenshots and recordings of the real product, per device) sit next to the state, so a person can compare the
// design with the real thing without opening the product.

import { Tx } from './actions.ts';
import type { Docs } from './ops.ts';
import { pageKey, type SetOp } from './ops.ts';
import type { Actor, BuildInfo, BuildState, Capture, Flow, Id, PageDoc } from './types.ts';

export interface BuildStateDef {
  id: BuildState;
  label: string;
  color: string;
  /** Shown in lists: what the state means in a few words. */
  hint: string;
}

/** In the order a screen goes through them. Only `matching` counts as done. */
export const BUILD_STATES: BuildStateDef[] = [
  { id: 'todo', label: 'Not built', color: '#7A7A73', hint: 'not built or not checked yet' },
  { id: 'wip', label: 'Building', color: '#5B9DFF', hint: 'being built right now' },
  { id: 'matching', label: 'Matching', color: '#45C08A', hint: 'the real product looks and works like the design' },
  { id: 'deviating', label: 'Deviating', color: '#FF9F43', hint: 'built, but differs (the note says why)' },
  { id: 'blocked', label: 'Blocked', color: '#FF6B6B', hint: 'cannot be built now (the note says why)' },
];

const IDS = new Set<string>(BUILD_STATES.map((s) => s.id));

/** States that need a reason in the note. */
export const NEEDS_NOTE = new Set<BuildState>(['deviating', 'blocked']);

export function isBuildState(s: unknown): s is BuildState {
  return typeof s === 'string' && IDS.has(s);
}

export function buildDef(state: BuildState | undefined): BuildStateDef | undefined {
  return BUILD_STATES.find((s) => s.id === state);
}

/** "match", "ok", "done" → matching; "deviates" → deviating … so people and agents can type it loosely. */
export function parseBuildState(word: string): BuildState | undefined {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (IDS.has(w)) return w as BuildState;
  const aliases: Record<string, BuildState> = {
    notbuilt: 'todo',
    open: 'todo',
    building: 'wip',
    inprogress: 'wip',
    progress: 'wip',
    match: 'matching',
    matches: 'matching',
    ok: 'matching',
    done: 'matching',
    deviates: 'deviating',
    deviation: 'deviating',
    differs: 'deviating',
    block: 'blocked',
  };
  return aliases[w];
}

/** The capture of one device and kind (the newest wins when a list has two). */
export function captureFor(build: BuildInfo | undefined, device: string, kind?: Capture['kind']): Capture | undefined {
  const list = build?.captures ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i]!;
    if (c.device === device && (!kind || c.kind === kind)) return c;
  }
  return undefined;
}

/** What a person would show for a device: a video beats a still (it shows the motion). */
export function shownCapture(build: BuildInfo | undefined, device: string): Capture | undefined {
  return captureFor(build, device, 'video') ?? captureFor(build, device, 'image');
}

/** Known devices in a fixed order (big to small), so switches and columns always read the same way. */
const DEVICE_ORDER = ['desktop', 'laptop', 'tablet', 'phone', 'watch'];

/** Every device that has a capture on the page (screens and flows): known ones big to small, then the rest. */
export function captureDevices(page: Pick<PageDoc, 'items' | 'flows'>): string[] {
  const seen: string[] = [];
  const add = (b: BuildInfo | undefined) => {
    for (const c of b?.captures ?? []) if (!seen.includes(c.device)) seen.push(c.device);
  };
  for (const it of Object.values(page.items)) if (it.kind === 'screen' && !it.archived) add(it.build);
  for (const f of Object.values(page.flows ?? {})) add(f.build);
  const rank = (d: string) => {
    const i = DEVICE_ORDER.indexOf(d.toLowerCase());
    return i < 0 ? DEVICE_ORDER.length : i;
  };
  return seen
    .map((d, i) => ({ d, i }))
    .sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i)
    .map((x) => x.d);
}

/** Whether the page uses the build check at all (any screen or flow has a build field). */
export function usesBuild(page: Pick<PageDoc, 'items' | 'flows'>): boolean {
  for (const it of Object.values(page.items)) if (it.kind === 'screen' && !it.archived && it.build) return true;
  return Object.values(page.flows ?? {}).some((f) => !!f.build);
}

export interface BuildCount {
  state: BuildState;
  label: string;
  count: number;
}

/** Counts per build state for the screens of a page (optionally one section, nested sections included). Screens
 *  without a build field are not counted: the check is opt-in per screen. */
export function countBuild(page: Pick<PageDoc, 'items'>, parent?: Id): BuildCount[] {
  const counts = new Map<BuildState, number>();
  for (const [id, it] of Object.entries(page.items)) {
    if (it.kind !== 'screen' || it.archived || !it.build) continue;
    if (parent !== undefined && !within(page, id, parent)) continue;
    counts.set(it.build.state, (counts.get(it.build.state) ?? 0) + 1);
  }
  return BUILD_STATES.filter((s) => counts.get(s.id)).map((s) => ({
    state: s.id,
    label: s.label,
    count: counts.get(s.id)!,
  }));
}

export function countFlows(page: Pick<PageDoc, 'flows'>): BuildCount[] {
  const counts = new Map<BuildState, number>();
  for (const f of Object.values(page.flows ?? {})) {
    const s = f.build?.state ?? 'todo';
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return BUILD_STATES.filter((s) => counts.get(s.id)).map((s) => ({
    state: s.id,
    label: s.label,
    count: counts.get(s.id)!,
  }));
}

function within(page: Pick<PageDoc, 'items'>, id: Id, section: Id): boolean {
  const seen = new Set<Id>();
  let cur = page.items[id]?.parent;
  while (cur && !seen.has(cur)) {
    if (cur === section) return true;
    seen.add(cur);
    cur = page.items[cur]?.parent;
  }
  return false;
}

/** "12/20 matching" (done out of all checked), or "" when nothing is tracked. */
export function progressText(counts: BuildCount[]): string {
  const total = counts.reduce((n, c) => n + c.count, 0);
  if (!total) return '';
  const done = counts.find((c) => c.state === 'matching')?.count ?? 0;
  return `${done}/${total} matching`;
}

/** "12 matching · 3 deviating · 1 blocked · 4 not built" */
export function buildCountsText(counts: BuildCount[]): string {
  return counts.map((c) => `${c.count} ${c.label.toLowerCase()}`).join(' · ');
}

/** A build field before it is stamped with who and when. */
interface BuildFields {
  state: BuildState;
  note?: string | undefined;
  captures?: Capture[] | undefined;
  [extra: string]: unknown;
}

function stamp(info: BuildFields, by: Actor): BuildInfo {
  // a fixed key order keeps the files' diffs small
  const out: BuildInfo = { state: info.state };
  if (info.note) out.note = info.note;
  out.by = by;
  out.at = new Date().toISOString();
  if (info.captures?.length) out.captures = info.captures;
  for (const [k, v] of Object.entries(info))
    if (!(k in out) && k !== 'by' && k !== 'at' && k !== 'note' && k !== 'captures' && v !== undefined) out[k] = v;
  return out;
}

/** Set the build state (and note) of screens. `note: undefined` keeps the note, `''` removes it. Captures stay. */
export function setBuild(
  docs: Docs,
  page: string,
  ids: Id[],
  state: BuildState,
  note: string | undefined,
  by: Actor,
): SetOp[] {
  const tx = new Tx(docs);
  for (const id of ids) {
    const it = tx.page(page).items[id];
    if (it?.kind !== 'screen') continue;
    const cur = it.build;
    const keep = note === undefined ? cur?.note : note || undefined;
    tx.setField(page, id, 'build', stamp({ ...(cur ?? {}), state, note: keep }, by));
  }
  return tx.ops;
}

/** Remove the build field (the screen leaves the check). */
export function clearBuild(docs: Docs, page: string, ids: Id[]): SetOp[] {
  const tx = new Tx(docs);
  for (const id of ids) if (tx.page(page).items[id]?.kind === 'screen') tx.setField(page, id, 'build', undefined);
  return tx.ops;
}

function withCapture(cur: BuildInfo | undefined, capture: Capture): BuildFields {
  // one capture per device and kind: a new one replaces the old
  const rest = (cur?.captures ?? []).filter((c) => !(c.device === capture.device && c.kind === capture.kind));
  const ordered: Capture = { device: capture.device, kind: capture.kind, src: capture.src };
  if (capture.poster) ordered.poster = capture.poster;
  if (capture.thumb) ordered.thumb = capture.thumb;
  if (capture.label) ordered.label = capture.label;
  ordered.at = capture.at ?? new Date().toISOString();
  return { ...(cur ?? {}), state: cur?.state ?? 'todo', captures: [...rest, ordered] };
}

/** Add (or replace) a capture of a screen. A screen without a build field gets one, state "todo". */
export function addCapture(docs: Docs, page: string, id: Id, capture: Capture, by: Actor): SetOp[] {
  const tx = new Tx(docs);
  const it = tx.item(page, id);
  if (it.kind !== 'screen') throw new Error(`"${id}" is a ${it.kind}, not a screen`);
  tx.setField(page, id, 'build', stamp(withCapture(it.build, capture), by));
  return tx.ops;
}

/** Remove a screen's capture for one device (both kinds when `kind` is missing). */
export function removeCapture(docs: Docs, page: string, id: Id, device: string, kind?: Capture['kind']): SetOp[] {
  const tx = new Tx(docs);
  const it = tx.item(page, id);
  if (it.kind !== 'screen' || !it.build) return [];
  const captures = (it.build.captures ?? []).filter((c) => !(c.device === device && (!kind || c.kind === kind)));
  tx.setField(page, id, 'build', { ...it.build, captures: captures.length ? captures : undefined });
  return tx.ops;
}

// ---------- flows ----------

export function setFlow(docs: Docs, page: string, id: Id, flow: Flow | undefined): SetOp[] {
  const tx = new Tx(docs);
  tx.page(page);
  tx.set(pageKey(page), ['flows', id], flow);
  return tx.ops;
}

export function setFlowBuild(
  docs: Docs,
  page: string,
  id: Id,
  state: BuildState,
  note: string | undefined,
  by: Actor,
): SetOp[] {
  const tx = new Tx(docs);
  const f = tx.page(page).flows?.[id];
  if (!f) throw new Error(`No flow "${id}" on page "${page}"`);
  const keep = note === undefined ? f.build?.note : note || undefined;
  tx.set(pageKey(page), ['flows', id, 'build'], stamp({ ...(f.build ?? {}), state, note: keep }, by));
  return tx.ops;
}

export function addFlowCapture(docs: Docs, page: string, id: Id, capture: Capture, by: Actor): SetOp[] {
  const tx = new Tx(docs);
  const f = tx.page(page).flows?.[id];
  if (!f) throw new Error(`No flow "${id}" on page "${page}"`);
  tx.set(pageKey(page), ['flows', id, 'build'], stamp(withCapture(f.build, capture), by));
  return tx.ops;
}

/** Flows that go through a screen (for the side panel: "part of 3 flows"). */
export function flowsThrough(page: Pick<PageDoc, 'flows'>, id: Id): Id[] {
  return Object.entries(page.flows ?? {})
    .filter(([, f]) => f.steps.includes(id))
    .map(([fid]) => fid);
}
