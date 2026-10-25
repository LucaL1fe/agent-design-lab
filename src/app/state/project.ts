// The open project in the browser: confirmed documents from the server plus this tab's not-yet-confirmed changes
// (optimistic). Server transactions rebase the pending ones: ops are field-level sets, so a rebase is a re-apply.
import { resolveFrame } from '../../core/frames.ts';
import { type Placement, placePage } from '../../core/layout.ts';
import { applyOps, type Docs, invertOps, type SetOp, safeInverse } from '../../core/ops.ts';
import type { Id, Item, PageDoc, Size } from '../../core/types.ts';
import type { Problem } from '../../core/validate.ts';
import type { ActivityEntry, ProjectState, ScreenMeta, ServerMessage, SnapInfo } from '../../protocol/messages.ts';
import { api, connection } from '../boot/connection.ts';

interface Pending {
  seq: number;
  ops: SetOp[];
  summary?: string;
}

export interface UndoEntry {
  page?: string;
  ops: SetOp[];
  summary: string;
}

type Listener = (
  kind: 'docs' | 'screens' | 'snaps' | 'problems' | 'activity' | 'conflict' | 'readonly',
  detail?: unknown,
) => void;

export class ProjectModel {
  readonly id: string;
  /** A built-in example: it can be looked at, never changed (`apply` refuses, the app offers a copy). */
  readonly example: boolean;
  dir = '';
  confirmed: Docs;
  docs: Docs;
  screens: Record<string, ScreenMeta> = {};
  snaps: Record<string, SnapInfo> = {};
  problems: Problem[] = [];
  activity: ActivityEntry[] = [];
  private pending: Pending[] = [];
  private seq = 0;
  private listeners = new Set<Listener>();
  private placements = new Map<
    string,
    { page: PageDoc; screens: Record<string, ScreenMeta>; snaps: Record<string, SnapInfo>; placement: Placement }
  >();
  undoStack: UndoEntry[] = [];
  redoStack: UndoEntry[] = [];
  /** ids recently changed by the agent → time (for the glow) */
  agentTouched = new Map<string, number>();

  constructor(state: ProjectState) {
    this.id = state.id;
    this.example = state.example === true;
    this.dir = state.dir;
    this.confirmed = { project: state.project, pages: state.pages };
    this.docs = this.confirmed;
    this.screens = state.screens;
    this.snaps = state.snaps;
    this.problems = state.problems;
    this.activity = state.activity;
  }

  static async load(pid: string): Promise<ProjectModel> {
    const s = await api<ProjectState>(`/api/p/${encodeURIComponent(pid)}/state`);
    return new ProjectModel(s);
  }

  on(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(kind: Parameters<Listener>[0], detail?: unknown) {
    for (const l of [...this.listeners]) l(kind, detail);
  }

  /** Apply a change made in this tab. Returns the ops actually applied (with prev values) for undo. */
  apply(ops: SetOp[], summary?: string, opts: { undoable?: boolean; page?: string } = {}): SetOp[] {
    if (!ops.length) return [];
    if (this.example) {
      // redraw (a dragged screen snaps back) and let the app offer a copy
      this.emit('docs', []);
      this.emit('readonly');
      return [];
    }
    const r = applyOps(this.docs, ops);
    if (!r.ops.length) return [];
    this.docs = r.docs;
    const seq = ++this.seq;
    this.pending.push({ seq, ops: r.ops, ...(summary ? { summary } : {}) });
    connection.send({ t: 'tx', pid: this.id, ops: r.ops, ...(summary ? { summary } : {}), clientSeq: seq });
    if (opts.undoable !== false) {
      this.undoStack.push({ ops: r.ops, summary: summary ?? 'change', ...(opts.page ? { page: opts.page } : {}) });
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
    }
    this.emit('docs', r.ops);
    return r.ops;
  }

  /** Undo the last change of this tab. Fields that someone else changed since are left alone. */
  undo(): { summary: string; skipped: number } | undefined {
    const e = this.undoStack.pop();
    if (!e) return undefined;
    const inv = safeInverse(this.docs, e.ops);
    const applied = this.apply(inv.ops, `Undo ${e.summary}`, { undoable: false });
    // redo = undoing the undo
    this.redoStack.push({ ops: applied, summary: e.summary, ...(e.page ? { page: e.page } : {}) });
    return { summary: e.summary, skipped: inv.skipped.length };
  }

  redo(): { summary: string; skipped: number } | undefined {
    const e = this.redoStack.pop();
    if (!e) return undefined;
    const inv = safeInverse(this.docs, e.ops);
    const applied = this.apply(inv.ops, e.summary, { undoable: false });
    this.undoStack.push({ ops: applied, summary: e.summary, ...(e.page ? { page: e.page } : {}) });
    return { summary: e.summary, skipped: inv.skipped.length };
  }

  handle(m: ServerMessage) {
    if (m.t === 'tx' && m.pid === this.id) {
      if (m.ops.length) this.confirmed = applyOps(this.confirmed, m.ops).docs;
      if (m.clientId === connection.clientId && m.clientSeq !== undefined)
        this.pending = this.pending.filter((p) => p.seq > m.clientSeq!);
      // rev numbers
      for (const [k, rev] of Object.entries(m.revs)) {
        if (k === 'project') this.confirmed = { ...this.confirmed, project: { ...this.confirmed.project, rev } };
        else {
          const pid = k.slice(5);
          const p = this.confirmed.pages[pid];
          if (p) this.confirmed = { ...this.confirmed, pages: { ...this.confirmed.pages, [pid]: { ...p, rev } } };
        }
      }
      let docs = this.confirmed;
      for (const p of this.pending) docs = applyOps(docs, p.ops).docs;
      this.docs = docs;
      if (m.actor === 'agent') {
        const now = Date.now();
        for (const o of m.ops) if (o.path[0] === 'items' && o.path[1]) this.agentTouched.set(o.path[1], now);
      }
      if (m.ops.length || m.clientId !== connection.clientId) this.emit('docs', m);
      if (m.conflicts?.length) this.emit('conflict', m.conflicts);
    } else if (m.t === 'screens' && m.pid === this.id) {
      this.screens = { ...this.screens };
      for (const s of m.changed) this.screens[s.id] = s;
      for (const id of m.removed) delete this.screens[id];
      const now = Date.now();
      for (const s of m.changed) this.agentTouched.set(s.id, now);
      this.emit('screens', m);
    } else if (m.t === 'snap' && m.pid === this.id) {
      this.snaps = { ...this.snaps, [m.hash]: m.snap };
      this.emit('snaps', m);
    } else if (m.t === 'problems' && m.pid === this.id) {
      this.problems = m.problems;
      this.emit('problems');
    } else if (m.t === 'activity' && m.entry.pid === this.id) {
      this.activity = [...this.activity.slice(-200), m.entry];
      this.emit('activity', m.entry);
    } else if (m.t === 'error' && m.clientSeq !== undefined) {
      // the server refused one of our changes: drop it and rebuild from the confirmed state
      this.pending = this.pending.filter((p) => p.seq !== m.clientSeq);
      let docs = this.confirmed;
      for (const p of this.pending) docs = applyOps(docs, p.ops).docs;
      this.docs = docs;
      this.emit('docs');
    }
  }

  async reload() {
    const s = await api<ProjectState>(`/api/p/${encodeURIComponent(this.id)}/state`);
    this.confirmed = { project: s.project, pages: s.pages };
    let docs = this.confirmed;
    for (const p of this.pending) docs = applyOps(docs, p.ops).docs;
    this.docs = docs;
    this.screens = s.screens;
    this.snaps = s.snaps;
    this.problems = s.problems;
    this.emit('docs');
    this.emit('screens');
    this.emit('snaps');
    this.emit('problems');
  }

  screenOf(id: Id, item: Item): ScreenMeta | undefined {
    return this.screens[(item.kind === 'screen' && item.screen) || id];
  }

  frameOf(id: Id, item: Item): { w: number; h: number | 'auto'; spec: string } {
    const meta = this.screenOf(id, item);
    const spec = (item.kind === 'screen' && item.frame) || meta?.frame || this.docs.project.frame || 'iphone-16';
    const f = resolveFrame(spec, this.docs.project) ?? resolveFrame(undefined, this.docs.project) ?? { w: 393, h: 852 };
    return { w: f.w, h: f.h, spec: `${f.w}x${f.h}` };
  }

  snapOf(id: Id, item: Item): SnapInfo | undefined {
    const meta = this.screenOf(id, item);
    if (!meta) return undefined;
    const f = this.frameOf(id, item);
    return this.snaps[`${meta.hash}@${f.w}x${f.h}`];
  }

  sizeOf = (id: Id, item: Item): Size => {
    if (item.kind !== 'screen') return { w: 300, h: 200 };
    const f = this.frameOf(id, item);
    if (f.h !== 'auto') return { w: f.w, h: f.h };
    const meta = this.screenOf(id, item);
    return { w: f.w, h: meta?.autoH ?? this.snapOf(id, item)?.h ?? 1200 };
  };

  /** Absolute rectangles for a page (memoised on the page document and screen sizes). */
  placement(pageId: string): Placement | undefined {
    const page = this.docs.pages[pageId];
    if (!page) return undefined;
    const c = this.placements.get(pageId);
    if (c && c.page === page && c.screens === this.screens && c.snaps === this.snaps) return c.placement;
    const placement = placePage(page, this.sizeOf);
    this.placements.set(pageId, { page, screens: this.screens, snaps: this.snaps, placement });
    return placement;
  }
}
