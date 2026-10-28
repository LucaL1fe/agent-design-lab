// Everything a person does with the pointer and keyboard on the canvas: select, marquee, drag with snapping and guides,
// connect screens from edge handles, edit arrow labels and styles, bend and re-attach arrows, notes, text, sections,
// resize, copy/paste/duplicate/delete, nudge, undo/redo, context menus. Changes become transactions on the project
// model (applied at once, sent to the server, undoable).
import {
  type ArrowPatch,
  addArrow,
  addItem,
  addNote,
  duplicateItems,
  moveItems,
  removalHeirs,
  removeItems,
  resizeItem,
  reverseArrow,
  updateArrow,
} from '../../core/actions.ts';
import { type Guide, snapMove, union } from '../../core/geom.ts';
import { applyOps, pageKey, type SetOp } from '../../core/ops.ts';
import { routeAll } from '../../core/route.ts';
import { arrowStylesOf } from '../../core/status.ts';
import type { Arrow, Id, Item, NoteColor, Rect, Side } from '../../core/types.ts';
import { api } from '../boot/connection.ts';
import { app, navigate, toast } from '../state/app.ts';
import { toggleScreenSound } from '../state/sound.ts';
import { type Engine, HEAD_H } from './engine.ts';
import { isTyping } from './viewport.ts';

const NOTE_COLORS: NoteColor[] = ['yellow', 'blue', 'green', 'pink', 'grey'];
const SVGNS = 'http://www.w3.org/2000/svg';

type Mode =
  | { k: 'idle' }
  | { k: 'press'; x: number; y: number; id?: Id; arrow?: Id; onSection?: Id; shift: boolean; pointer: number }
  | { k: 'drag'; ids: Id[]; startX: number; startY: number; base: Rect; dx: number; dy: number; guides: Guide[] }
  | { k: 'marquee'; x0: number; y0: number; x1: number; y1: number; shift: boolean; before: Id[] }
  | { k: 'connect'; from: Id; side?: Side | undefined; x: number; y: number; target?: Id | undefined }
  | { k: 'reattach'; arrow: Id; end: 'from' | 'to'; x: number; y: number; target?: Id | undefined }
  | { k: 'bend'; arrow: Id; x: number; y: number }
  | { k: 'draw-section'; x0: number; y0: number; x1: number; y1: number }
  | { k: 'resize'; id: Id; edge: 'r' | 'b' | 'rb'; base: Rect; x0: number; y0: number; w: number; h: number };

let clipboard: { project: string; page: string; ids: Id[] } | undefined;

export class Interaction {
  readonly e: Engine;
  private mode: Mode = { k: 'idle' };
  private ac = new AbortController();
  private layer: HTMLDivElement;
  private svg: SVGSVGElement;
  private boxes = new Map<string, HTMLDivElement>();
  private hover?: Id | undefined;
  private editor?: HTMLElement | undefined;
  private unsub: (() => void)[] = [];

  constructor(engine: Engine) {
    this.e = engine;
    this.layer = document.createElement('div');
    this.layer.className = 'ix';
    engine.overlay.appendChild(this.layer);
    this.svg = document.createElementNS(SVGNS, 'svg');
    this.svg.setAttribute('class', 'ix-svg');
    engine.overlay.appendChild(this.svg);
    const root = engine.root;
    const on = { signal: this.ac.signal };
    root.addEventListener('pointerdown', (ev) => this.down(ev), on);
    window.addEventListener('pointermove', (ev) => this.move(ev), on);
    window.addEventListener('pointerup', (ev) => this.up(ev), on);
    root.addEventListener('dblclick', (ev) => this.dbl(ev), on);
    root.addEventListener('contextmenu', (ev) => this.context(ev), on);
    root.addEventListener('pointerleave', () => this.setHover(undefined), on);
    window.addEventListener('keydown', (ev) => this.key(ev), on);
    engine.overlay.addEventListener('click', (ev) => this.overlayClick(ev), on);
    root.addEventListener('click', (ev) => this.speakerClick(ev), on);
    engine.hooks.add(() => this.draw());
    this.unsub.push(app.subscribe(() => this.onApp()));
    this.onApp();
  }

  destroy() {
    this.ac.abort();
    for (const u of this.unsub) u();
    this.closeEditor(false);
    this.layer.remove();
    this.svg.remove();
  }

  private lastSel: Id[] = [];
  private lastArrows: Id[] = [];
  private onApp() {
    const s = app.get();
    if (s.selection !== this.lastSel || s.arrowSel !== this.lastArrows) {
      this.lastSel = s.selection;
      this.lastArrows = s.arrowSel;
      this.e.applySelection(s.selection, s.arrowSel);
      this.e.boost = new Set(s.selection);
      this.e.schedule();
    }
    this.e.root.classList.toggle(`tool-${s.tool}`, true);
    for (const t of ['select', 'hand', 'text', 'section', 'note', 'arrow'])
      if (t !== s.tool) this.e.root.classList.remove(`tool-${t}`);
  }

  private get page() {
    return this.e.page!;
  }
  private get model() {
    return this.e.model;
  }
  private world(ev: { clientX: number; clientY: number }) {
    return this.e.vp.toWorld(ev.clientX, ev.clientY);
  }
  private select(ids: Id[], arrows: Id[] = []) {
    app.set({ selection: ids, arrowSel: arrows });
  }
  private apply(ops: SetOp[], summary: string) {
    return this.model.apply(ops, summary, { page: this.e.pageId });
  }

  // ---------- hit testing ----------

  private hitAt(ev: PointerEvent | MouseEvent): { id?: Id; arrow?: Id; section?: Id; handle?: HTMLElement } {
    const t = ev.target as Element;
    const handle = t.closest?.('[data-h]') as HTMLElement | null;
    if (handle) return { handle };
    const title = t.closest?.('.sec-title') as HTMLElement | null;
    if (title) return { id: title.dataset.id! };
    const label = t.closest?.('.alab') as HTMLElement | null;
    if (label) return { arrow: label.dataset.id! };
    const g = t.closest?.('g[data-id]') as SVGGElement | null;
    if (g && t.classList.contains('hit')) return { arrow: g.dataset.id! };
    const el = t.closest?.('.it[data-id]') as HTMLElement | null;
    if (el) {
      const id = el.dataset.id!;
      if (this.page.items[id]?.kind === 'section') return { section: id };
      return { id };
    }
    return {};
  }

  // ---------- pointer ----------

  private down(ev: PointerEvent) {
    if (ev.button === 2) return;
    if (this.e.vp.space || this.e.vp.handTool || ev.button === 1 || (ev.pointerType === 'touch' && !ev.isPrimary))
      return;
    if (this.editor && this.editor.contains(ev.target as Node)) return;
    if (this.editor) this.closeEditor(true);
    // a screen's speaker is a button: no selection, no drag (the click turns the sound on)
    if ((ev.target as Element).closest?.('[data-snd]')) {
      ev.preventDefault();
      return;
    }
    const tool = app.get().tool;
    const [wx, wy] = this.world(ev);
    const hit = this.hitAt(ev);
    if (app.get().menu) app.set({ menu: undefined });
    this.closeContext();
    if (hit.handle) {
      ev.preventDefault();
      this.startHandle(hit.handle, ev, wx, wy);
      return;
    }
    if (tool === 'note') {
      ev.preventDefault();
      this.createNote(wx, wy);
      app.set({ tool: 'select' });
      return;
    }
    if (tool === 'text') {
      ev.preventDefault();
      this.createText(wx, wy);
      app.set({ tool: 'select' });
      return;
    }
    if (tool === 'section') {
      ev.preventDefault();
      this.mode = { k: 'draw-section', x0: wx, y0: wy, x1: wx, y1: wy };
      return;
    }
    if (tool === 'arrow' && hit.id && this.connectable(hit.id)) {
      ev.preventDefault();
      this.mode = { k: 'connect', from: hit.id, x: wx, y: wy };
      return;
    }
    this.mode = {
      k: 'press',
      x: ev.clientX,
      y: ev.clientY,
      ...(hit.id ? { id: hit.id } : {}),
      ...(hit.arrow ? { arrow: hit.arrow } : {}),
      ...(hit.section ? { onSection: hit.section } : {}),
      shift: ev.shiftKey || ev.metaKey,
      pointer: ev.pointerId,
    };
    if (hit.arrow) {
      this.select([], ev.shiftKey ? toggle(app.get().arrowSel, hit.arrow) : [hit.arrow]);
      return;
    }
    if (hit.id) {
      const sel = app.get().selection;
      if (ev.shiftKey || ev.metaKey) this.select(toggle(sel, hit.id));
      else if (!sel.includes(hit.id)) this.select([hit.id]);
    }
  }

  private move(ev: PointerEvent): void {
    const m = this.mode;
    if (m.k === 'idle') {
      if (ev.buttons === 0 && !this.e.vp.panning && (ev.target as Element)?.closest?.('.adl-viewport'))
        this.updateHover(ev);
      return;
    }
    const [wx, wy] = this.world(ev);
    const k = this.e.vp.v.k;
    if (m.k === 'press') {
      if (Math.hypot(ev.clientX - m.x, ev.clientY - m.y) < 4) return;
      const [sx, sy] = this.e.vp.toWorld(m.x, m.y);
      if (m.id) {
        const sel = app.get().selection.filter((id) => this.page.items[id] && !this.page.items[id]!.archived);
        const ids = topLevel(sel.includes(m.id) ? sel : [m.id], this.page.items);
        const rects = ids.map((id) => this.boxOf(id)).filter(Boolean) as Rect[];
        const base = union(rects);
        if (!base) return;
        this.mode = { k: 'drag', ids, startX: sx, startY: sy, base, dx: 0, dy: 0, guides: [] };
        this.e.root.classList.add('dragging');
      } else if (!m.arrow) {
        this.mode = {
          k: 'marquee',
          x0: sx,
          y0: sy,
          x1: wx,
          y1: wy,
          shift: m.shift,
          before: m.shift ? app.get().selection : [],
        };
      } else {
        this.mode = { k: 'idle' };
      }
      this.move(ev);
      return;
    }
    if (m.k === 'drag') {
      let dx = wx - m.startX;
      let dy = wy - m.startY;
      const moving = this.e.dependents(m.ids);
      const others: Rect[] = [];
      for (const id of this.e.index.query(this.e.vp.visibleRect(400))) {
        if (moving.has(id)) continue;
        const r = this.e.rects.get(id);
        if (r) others.push(r);
      }
      m.guides = [];
      if (!ev.altKey) {
        const snapped = snapMove({ x: m.base.x + dx, y: m.base.y + dy, w: m.base.w, h: m.base.h }, others, 7 / k);
        dx += snapped.dx;
        dy += snapped.dy;
        m.guides = snapped.guides;
      }
      m.dx = dx;
      m.dy = dy;
      this.e.previewMove(m.ids, dx, dy);
      return;
    }
    if (m.k === 'marquee') {
      m.x1 = wx;
      m.y1 = wy;
      const r = norm(m.x0, m.y0, m.x1, m.y1);
      const hit = this.e.index.query(r).filter((id) => this.page.items[id] && this.page.items[id]!.kind !== 'section');
      const sections = Object.entries(this.page.items)
        .filter(([id, it]) => it.kind === 'section' && contains(r, this.e.rects.get(id)))
        .map(([id]) => id);
      const next = [...new Set([...m.before, ...hit, ...sections])];
      if (!sameList(next, app.get().selection)) this.select(next);
      this.e.schedule();
      return;
    }
    if (m.k === 'connect' || m.k === 'reattach') {
      m.x = wx;
      m.y = wy;
      const t = this.e.itemAt(ev.clientX, ev.clientY);
      m.target = t && this.connectable(t) ? t : undefined;
      this.e.schedule();
      return;
    }
    if (m.k === 'bend') {
      m.x = wx;
      m.y = wy;
      const a = this.page.arrows[m.arrow];
      if (a) {
        const preview = { ...a, waypoints: [[Math.round(wx), Math.round(wy)]] as [number, number][] };
        this.drawArrowPreview(m.arrow, preview);
      }
      return;
    }
    if (m.k === 'draw-section') {
      m.x1 = wx;
      m.y1 = wy;
      this.e.schedule();
      return;
    }
    if (m.k === 'resize') {
      const dx = wx - m.x0;
      const dy = wy - m.y0;
      m.w = Math.max(80, m.base.w + (m.edge.includes('r') ? dx : 0));
      m.h = Math.max(60, m.base.h + (m.edge.includes('b') ? dy : 0));
      const el = this.e.nodeOf(m.id);
      if (el) {
        el.style.width = `${m.w}px`;
        if (this.page.items[m.id]?.kind === 'section') el.style.height = `${m.h}px`;
      }
      this.e.schedule();
    }
  }

  private up(ev: PointerEvent) {
    const m = this.mode;
    this.mode = { k: 'idle' };
    this.e.root.classList.remove('dragging');
    if (m.k === 'press') {
      // a click without movement
      if (!m.id && !m.arrow) {
        if (m.onSection && !m.shift) this.select([m.onSection]);
        else if (!m.shift) this.select([]);
      } else if (m.id && !m.shift && app.get().selection.length > 1 && app.get().selection.includes(m.id))
        this.select([m.id]);
      this.e.schedule();
      return;
    }
    if (m.k === 'drag') {
      if (Math.abs(m.dx) < 0.5 && Math.abs(m.dy) < 0.5) {
        this.e.endPreview();
        return;
      }
      this.commitMove(m.ids, m.dx, m.dy);
      return;
    }
    if (m.k === 'marquee') {
      this.e.schedule();
      return;
    }
    if (m.k === 'connect') {
      this.e.schedule();
      if (!m.target) {
        // dropped on empty canvas: the arrow leads to a screen somewhere else (a portal stands for it here)
        const r = this.e.rects.get(m.from);
        const inside = r && m.x >= r.x && m.x <= r.x + r.w && m.y >= r.y && m.y <= r.y + r.h;
        if (!inside) this.pickPortal(m.from, m.x, m.y, m.side);
        return;
      }
      const loop = m.target === m.from;
      const props: Partial<Arrow> = loop ? { style: 'loop' } : {};
      if (m.side && !loop) props.fromSide = m.side;
      const r = addArrow(this.model.docs, this.e.pageId, m.from, m.target, props);
      this.apply(r.ops, `Connected ${m.from} → ${m.target}`);
      // a plain arrow: name it later (double-click or Enter), change its style in the side panel
      this.select([], [r.id]);
      app.set({ tool: 'select' });
      this.e.renderNow();
      return;
    }
    if (m.k === 'reattach') {
      this.e.endPreview();
      if (!m.target) return;
      const a = this.page.arrows[m.arrow];
      if (!a || a[m.end] === m.target) return;
      const ops = updateArrow(
        this.model.docs,
        this.e.pageId,
        m.arrow,
        { [m.end]: m.target, waypoints: undefined } as ArrowPatch,
        'human',
      );
      this.apply(ops, `Re-attached an arrow to ${m.target}`);
      const nid = Object.entries(this.model.docs.pages[this.e.pageId]!.arrows).find(
        ([, x]) => x.from === (m.end === 'from' ? m.target : a.from) && x.to === (m.end === 'to' ? m.target : a.to),
      )?.[0];
      if (nid) this.select([], [nid]);
      return;
    }
    if (m.k === 'bend') {
      this.e.endPreview();
      const ops = updateArrow(
        this.model.docs,
        this.e.pageId,
        m.arrow,
        { waypoints: [[Math.round(m.x), Math.round(m.y)]] },
        'human',
      );
      this.apply(ops, 'Bent an arrow');
      return;
    }
    if (m.k === 'draw-section') {
      app.set({ tool: 'select' });
      const r = norm(m.x0, m.y0, m.x1, m.y1);
      if (r.w < 40 || r.h < 40) {
        this.e.schedule();
        return;
      }
      this.createSection(r);
      return;
    }
    if (m.k === 'resize') {
      const it = this.page.items[m.id];
      if (!it) return;
      const ops = resizeItem(
        this.model.docs,
        this.e.pageId,
        m.id,
        it.kind === 'section' ? { w: m.w, h: m.h } : { w: m.w },
        'human',
      );
      this.apply(ops, 'Resized');
      return;
    }
    void ev;
  }

  /** Drop: positions become relative to the section the item lands in; arrows with manual routes re-route. */
  private commitMove(ids: Id[], dx: number, dy: number) {
    const page = this.page;
    const base = new Map<Id, Rect>();
    for (const id of ids) {
      const r = this.e.rects.get(id);
      if (r) base.set(id, { x: r.x - dx, y: r.y - dy, w: r.w, h: r.h });
    }
    const moving = this.e.dependents(ids);
    this.e.endPreview();
    const docs = this.model.docs;
    const sections = Object.entries(page.items).filter(([sid, it]) => it.kind === 'section' && !moving.has(sid));
    const moves: { id: Id; x: number; y: number; parent?: Id | null }[] = [];
    for (const id of ids) {
      const it = page.items[id];
      const b = base.get(id);
      if (!it || !b) continue;
      const nx = b.x + dx;
      const ny = b.y + dy;
      if (it.kind === 'note' && it.anchor && page.items[it.anchor]) {
        const a = this.e.rects.get(it.anchor);
        if (a && !moving.has(it.anchor)) {
          moves.push({ id, x: nx - a.x, y: ny - a.y });
          continue;
        }
      }
      let parent: Id | undefined;
      if (it.kind !== 'section') {
        const cx = nx + b.w / 2;
        const cy = ny + Math.min(b.h / 2, 120);
        let best: { id: Id; area: number } | undefined;
        for (const [sid] of sections) {
          const sr = this.e.rects.get(sid);
          if (sr && cx >= sr.x && cx <= sr.x + sr.w && cy >= sr.y && cy <= sr.y + sr.h) {
            const area = sr.w * sr.h;
            if (!best || area < best.area) best = { id: sid, area };
          }
        }
        parent = best?.id;
      } else parent = it.parent && page.items[it.parent] && !moving.has(it.parent) ? it.parent : undefined;
      const pr = parent ? this.e.rects.get(parent) : undefined;
      moves.push({ id, x: nx - (pr?.x ?? 0), y: ny - (pr?.y ?? 0), parent: parent ?? null });
    }
    const ops = moveItems(docs, this.e.pageId, moves, 'human');
    // arrows with a manual route through a moved item go back to automatic routing
    for (const [aid, a] of Object.entries(page.arrows)) {
      if (a.waypoints && (moving.has(a.from) || moving.has(a.to)))
        ops.push({ doc: pageKey(this.e.pageId), path: ['arrows', aid, 'waypoints'], value: undefined });
    }
    this.apply(ops, ids.length === 1 ? `Moved ${ids[0]}` : `Moved ${ids.length} items`);
  }

  // ---------- handles ----------

  private startHandle(h: HTMLElement, ev: PointerEvent, wx: number, wy: number) {
    const kind = h.dataset.h!;
    const id = h.dataset.id!;
    if (kind === 'edge') {
      this.mode = { k: 'connect', from: id, side: h.dataset.side as Side, x: wx, y: wy };
    } else if (kind === 'from' || kind === 'to') {
      this.mode = { k: 'reattach', arrow: id, end: kind, x: wx, y: wy };
    } else if (kind === 'bend') {
      this.mode = { k: 'bend', arrow: id, x: wx, y: wy };
    } else if (kind === 'r' || kind === 'b' || kind === 'rb') {
      const base = this.e.rects.get(id);
      if (base) this.mode = { k: 'resize', id, edge: kind, base: { ...base }, x0: wx, y0: wy, w: base.w, h: base.h };
    }
    void ev;
  }

  private connectable(id: Id): boolean {
    const k = this.page.items[id]?.kind;
    return k === 'screen' || k === 'portal' || k === 'image' || k === 'note';
  }

  private setHover(id: Id | undefined) {
    if (this.hover === id) return;
    this.hover = id;
    this.e.schedule();
  }

  private updateHover(ev: PointerEvent) {
    const t = ev.target as Element;
    if (t.closest('[data-h]')) return;
    const el = t.closest('.it[data-id]') as HTMLElement | null;
    const id = el?.dataset.id;
    this.setHover(id && this.page.items[id]?.kind !== 'section' ? id : undefined);
  }

  // ---------- overlay ----------

  private box(key: string, cls: string): HTMLDivElement {
    let b = this.boxes.get(key);
    if (!b) {
      b = document.createElement('div');
      b.className = cls;
      this.layer.appendChild(b);
      this.boxes.set(key, b);
    }
    b.className = cls;
    return b;
  }

  /** Screen rectangle of an item (including caption space for screens when asked). */
  private boxOf(id: Id): Rect | undefined {
    return this.e.rects.get(id);
  }

  private screenRect(r: Rect): Rect {
    const { x, y, k } = this.e.vp.v;
    return { x: r.x * k + x, y: r.y * k + y, w: r.w * k, h: r.h * k };
  }

  private draw() {
    const used = new Set<string>();
    const put = (key: string, cls: string, r: Rect, extra?: (el: HTMLDivElement) => void) => {
      const b = this.box(key, cls);
      b.style.transform = `translate(${Math.round(r.x)}px, ${Math.round(r.y)}px)`;
      b.style.width = `${Math.max(0, Math.round(r.w))}px`;
      b.style.height = `${Math.max(0, Math.round(r.h))}px`;
      extra?.(b);
      used.add(key);
      return b;
    };
    const s = app.get();
    const page = this.e.page;
    this.svg.replaceChildren();
    if (!page) return;
    const m = this.mode;
    const k = this.e.vp.v.k;
    // selection boxes and handles
    for (const id of s.selection) {
      const r = this.e.rects.get(id);
      if (!r) continue;
      const sr = this.screenRect(r);
      put(`sel:${id}`, 'ix-sel', { x: sr.x - 3, y: sr.y - 3, w: sr.w + 6, h: sr.h + 6 });
      if (s.selection.length === 1 && m.k !== 'drag') {
        const it = page.items[id];
        if (it?.kind === 'section') {
          put(`h:r:${id}`, 'ix-hdl r', { x: sr.x + sr.w - 4, y: sr.y + sr.h / 2 - 10, w: 8, h: 20 }, (el) =>
            setH(el, 'r', id),
          );
          put(`h:b:${id}`, 'ix-hdl b', { x: sr.x + sr.w / 2 - 10, y: sr.y + sr.h - 4, w: 20, h: 8 }, (el) =>
            setH(el, 'b', id),
          );
          put(`h:rb:${id}`, 'ix-hdl rb', { x: sr.x + sr.w - 6, y: sr.y + sr.h - 6, w: 12, h: 12 }, (el) =>
            setH(el, 'rb', id),
          );
        } else if (it?.kind === 'note' || it?.kind === 'text') {
          put(`h:r:${id}`, 'ix-hdl r', { x: sr.x + sr.w - 4, y: sr.y + sr.h / 2 - 10, w: 8, h: 20 }, (el) =>
            setH(el, 'r', id),
          );
        }
      }
    }
    // hover outline + edge handles (connect)
    const hoverId = m.k === 'idle' && this.hover && !s.selection.includes(this.hover) ? this.hover : undefined;
    if (hoverId) {
      const r = this.e.rects.get(hoverId);
      if (r) {
        const sr = this.screenRect(r);
        put('hover', 'ix-hover', { x: sr.x - 2, y: sr.y - 2, w: sr.w + 4, h: sr.h + 4 });
      }
    }
    const edgeFor =
      m.k === 'idle'
        ? this.hover && this.connectable(this.hover)
          ? this.hover
          : s.selection.length === 1 && this.connectable(s.selection[0]!)
            ? s.selection[0]
            : undefined
        : undefined;
    if (edgeFor && k > 0.06 && s.tool !== 'hand') {
      const r = this.e.rects.get(edgeFor);
      if (r) {
        const sr = this.screenRect(r);
        const pts: [Side, number, number][] = [
          ['top', sr.x + sr.w / 2, sr.y],
          ['right', sr.x + sr.w, sr.y + sr.h / 2],
          ['bottom', sr.x + sr.w / 2, sr.y + sr.h],
          ['left', sr.x, sr.y + sr.h / 2],
        ];
        for (const [side, x, y] of pts) {
          put(`edge:${side}`, 'ix-edge', { x: x - 7, y: y - 7, w: 14, h: 14 }, (el) => {
            el.dataset.h = 'edge';
            el.dataset.id = edgeFor;
            el.dataset.side = side;
            el.title = 'Drag to another screen to connect';
          });
        }
      }
    }
    // selected arrows: end handles + bend handle
    if (s.arrowSel.length === 1 && m.k === 'idle') {
      const aid = s.arrowSel[0]!;
      const route = this.e.routes.get(aid);
      if (route && route.points.length >= 2) {
        const [fx, fy] = this.e.vp.toScreen(...route.points[0]!);
        const [tx, ty] = this.e.vp.toScreen(...route.points[route.points.length - 1]!);
        const [lx, ly] = this.e.vp.toScreen(...route.label);
        put('a:from', 'ix-end', { x: fx - 6, y: fy - 6, w: 12, h: 12 }, (el) =>
          setH(el, 'from', aid, 'Drag to another screen'),
        );
        put('a:to', 'ix-end', { x: tx - 6, y: ty - 6, w: 12, h: 12 }, (el) =>
          setH(el, 'to', aid, 'Drag to another screen'),
        );
        put('a:bend', 'ix-bend', { x: lx - 6, y: ly + 6, w: 12, h: 12 }, (el) =>
          setH(el, 'bend', aid, 'Drag to bend the arrow'),
        );
      }
    }
    // marquee
    if (m.k === 'marquee' || m.k === 'draw-section') {
      const r = this.screenRect(norm(m.x0, m.y0, m.x1, m.y1));
      put('marquee', m.k === 'marquee' ? 'ix-marquee' : 'ix-newsec', r);
    }
    // drag guides
    if (m.k === 'drag') {
      for (const [i, g] of m.guides.entries()) {
        if (g.type === 'align') {
          if (g.axis === 'x') {
            const [x, y1] = this.e.vp.toScreen(g.pos, g.from);
            const [, y2] = this.e.vp.toScreen(g.pos, g.to);
            put(`g${i}`, 'ix-guide', { x: x - 0.5, y: y1, w: 1, h: y2 - y1 });
          } else {
            const [x1, y] = this.e.vp.toScreen(g.from, g.pos);
            const [x2] = this.e.vp.toScreen(g.to, g.pos);
            put(`g${i}`, 'ix-guide', { x: x1, y: y - 0.5, w: x2 - x1, h: 1 });
          }
        } else {
          for (const [j, seg] of g.segments.entries()) {
            if (g.axis === 'x') {
              const [x1, y] = this.e.vp.toScreen(seg.a, seg.at);
              const [x2] = this.e.vp.toScreen(seg.b, seg.at);
              put(`g${i}-${j}`, 'ix-guide', { x: x1, y: y - 0.5, w: x2 - x1, h: 1 });
              put(`gt${i}-${j}`, 'ix-gtag', { x: (x1 + x2) / 2 - 20, y: y - 10, w: 40, h: 18 }, (el) => {
                el.textContent = String(g.value);
              });
            } else {
              const [x, y1] = this.e.vp.toScreen(seg.at, seg.a);
              const [, y2] = this.e.vp.toScreen(seg.at, seg.b);
              put(`g${i}-${j}`, 'ix-guide', { x: x - 0.5, y: y1, w: 1, h: y2 - y1 });
              put(`gt${i}-${j}`, 'ix-gtag', { x: x - 20, y: (y1 + y2) / 2 - 9, w: 40, h: 18 }, (el) => {
                el.textContent = String(g.value);
              });
            }
          }
        }
      }
    }
    // connect / re-attach preview
    if (m.k === 'connect' || m.k === 'reattach') {
      let sx: number;
      let sy: number;
      if (m.k === 'connect') {
        const r = this.e.rects.get(m.from);
        if (!r) return;
        const p = sidePt(r, m.side ?? 'right');
        [sx, sy] = this.e.vp.toScreen(p[0], p[1]);
      } else {
        const route = this.e.routes.get(m.arrow);
        const a = route?.points;
        if (!a) return;
        const other = m.end === 'from' ? a[a.length - 1]! : a[0]!;
        [sx, sy] = this.e.vp.toScreen(other[0], other[1]);
      }
      const [ex, ey] = this.e.vp.toScreen(m.x, m.y);
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('d', `M${sx} ${sy} L${ex} ${ey}`);
      path.setAttribute('class', 'ix-line');
      this.svg.appendChild(path);
      if (m.target) {
        const r = this.e.rects.get(m.target);
        if (r) {
          const sr = this.screenRect(r);
          put('drop', 'ix-drop', { x: sr.x - 4, y: sr.y - 4, w: sr.w + 8, h: sr.h + 8 });
        }
      }
    }
    for (const [key, b] of this.boxes) {
      if (used.has(key)) continue;
      b.remove();
      this.boxes.delete(key);
    }
    if (this.editor) this.positionEditor();
  }

  private drawArrowPreview(id: Id, arrow: Arrow) {
    const from = this.e.rects.get(arrow.from);
    const to = this.e.rects.get(arrow.to);
    if (!from || !to) return;
    const r = routeAll([{ id, arrow, from, to }], { obstacles: new Map(), headroom: HEAD_H + 8 }).get(id);
    if (!r) return;
    this.e.routes.set(id, r);
    const svg = this.e.root.querySelector('svg.layer.arrows') as SVGSVGElement;
    this.e.drawArrow(
      svg,
      id,
      arrow,
      r,
      arrowStylesOf(this.model.docs.project)[arrow.style ?? 'flow'] ?? { color: '#8C8C8C' },
    );
  }

  // ---------- creating things ----------

  private createNote(wx: number, wy: number) {
    // a note dropped next to a screen is anchored to it and moves with it
    let anchor: Id | undefined;
    for (const id of this.e.index.query({ x: wx - 120, y: wy - 120, w: 240, h: 240 })) {
      const it = this.page.items[id];
      if (it?.kind !== 'screen') continue;
      anchor = id;
      break;
    }
    const a = anchor ? this.e.rects.get(anchor) : undefined;
    let parent: Id | undefined;
    if (!a) parent = this.sectionAt(wx, wy);
    const pr = parent ? this.e.rects.get(parent) : undefined;
    const r = addNote(
      this.model.docs,
      this.e.pageId,
      a
        ? { text: '', x: wx - a.x, y: wy - a.y, anchor: anchor!, color: 'yellow', w: 260 }
        : {
            text: '',
            x: wx - (pr?.x ?? 0),
            y: wy - (pr?.y ?? 0),
            color: 'yellow',
            w: 260,
            ...(parent ? { parent } : {}),
          },
      'human',
    );
    this.apply(r.ops, 'Added a note');
    this.select([r.id]);
    this.e.renderNow();
    this.editText(r.id, true);
  }

  private createText(wx: number, wy: number) {
    const parent = this.sectionAt(wx, wy);
    const pr = parent ? this.e.rects.get(parent) : undefined;
    const item: Item = {
      kind: 'text',
      text: 'Text',
      size: 'h2',
      x: Math.round(wx - (pr?.x ?? 0)),
      y: Math.round(wy - (pr?.y ?? 0)),
      ...(parent ? { parent } : {}),
    };
    const r = addItem(this.model.docs, this.e.pageId, item);
    this.apply(r.ops, 'Added a text');
    this.select([r.id]);
    this.e.renderNow();
    this.editText(r.id, true);
  }

  private createSection(r: Rect) {
    const page = this.page;
    const r1 = addItem(this.model.docs, this.e.pageId, {
      kind: 'section',
      title: 'New section',
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.w),
      h: Math.round(r.h),
    });
    const ops = [...r1.ops];
    // everything fully inside becomes part of the section
    const inside: { id: Id; x: number; y: number }[] = [];
    for (const [id, it] of Object.entries(page.items)) {
      if (it.kind === 'section' || (it.kind === 'note' && it.anchor)) continue;
      const ir = this.e.rects.get(id);
      if (ir && contains(r, ir)) inside.push({ id, x: ir.x - r.x, y: ir.y - r.y });
    }
    if (inside.length) {
      const docs = applyOps(this.model.docs, r1.ops).docs;
      ops.push(
        ...moveItems(
          docs,
          this.e.pageId,
          inside.map((x) => ({ ...x, parent: r1.id })),
          'human',
        ),
      );
    }
    this.apply(ops, 'Added a section');
    this.select([r1.id]);
    this.e.renderNow();
    this.renameSection(r1.id, true);
  }

  private sectionAt(wx: number, wy: number): Id | undefined {
    let best: { id: Id; area: number } | undefined;
    for (const [id, it] of Object.entries(this.page.items)) {
      if (it.kind !== 'section') continue;
      const r = this.e.rects.get(id);
      if (r && wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h && (!best || r.w * r.h < best.area))
        best = { id, area: r.w * r.h };
    }
    return best?.id;
  }

  // ---------- editors ----------

  private closeEditor(commit: boolean) {
    const ed = this.editor;
    if (!ed) return;
    this.editor = undefined;
    (ed as unknown as { commit?: (c: boolean) => void }).commit?.(commit);
    if (ed.parentElement === this.e.overlay || ed.classList.contains('ix-editor')) ed.remove();
    app.set({ editing: undefined, hint: undefined });
  }

  private positionEditor() {
    const ed = this.editor as (HTMLElement & { place?: () => void }) | undefined;
    ed?.place?.();
  }

  /** An arrow dropped on empty canvas: pick the screen it leads to (any page); a portal at the drop point stands for
   *  it, with the arrow into it. Clicking the portal goes there; present mode walks through it. */
  pickPortal(from: Id | undefined, wx: number, wy: number, side?: Side) {
    this.closeEditor(true);
    const docs = this.model.docs;
    const entries: { id: Id; page: string; title: string; pageName: string }[] = [];
    for (const pid of docs.project.pages) {
      const pg = docs.pages[pid];
      if (!pg || pg.kind === 'history') continue;
      for (const [id, it] of Object.entries(pg.items)) {
        if (it.kind !== 'screen' || it.archived || (pid === this.e.pageId && id === from)) continue;
        entries.push({ id, page: pid, title: it.title ?? this.model.screenOf(id, it)?.title ?? '', pageName: pg.name });
      }
    }
    const wrap = document.createElement('div') as HTMLDivElement & {
      place?: () => void;
      commit?: (c: boolean) => void;
    };
    wrap.className = 'ix-editor ix-portal';
    wrap.dataset.testid = 'portal-picker';
    const input = document.createElement('input');
    input.placeholder = 'Leads to which screen? Type an id or a name';
    input.setAttribute('aria-label', 'Screen the arrow leads to');
    const list = document.createElement('div');
    list.className = 'ix-portal-list';
    wrap.append(input, list);
    let hits: typeof entries = [];
    let cur = 0;
    let chosen: (typeof entries)[number] | undefined;
    const render = () => {
      const q = input.value.trim().toLowerCase();
      hits = entries
        .filter((e) => !q || e.id.toLowerCase().includes(q) || e.title.toLowerCase().includes(q))
        .sort(
          (a, b) =>
            Number(b.id.toLowerCase() === q) - Number(a.id.toLowerCase() === q) ||
            Number(b.page === this.e.pageId) - Number(a.page === this.e.pageId) ||
            a.id.localeCompare(b.id, undefined, { numeric: true }),
        )
        .slice(0, 8);
      cur = Math.min(cur, Math.max(0, hits.length - 1));
      list.replaceChildren(
        ...hits.map((h, i) => {
          const row = document.createElement('button');
          row.type = 'button';
          row.className = `ix-portal-row${i === cur ? ' on' : ''}`;
          const b = document.createElement('b');
          b.textContent = h.id;
          const t = document.createElement('span');
          t.textContent = h.title;
          row.append(b, t);
          if (h.page !== this.e.pageId) {
            const pg = document.createElement('em');
            pg.textContent = h.pageName;
            row.append(pg);
          }
          row.onpointerdown = (ev) => ev.preventDefault();
          row.onclick = () => {
            chosen = h;
            this.closeEditor(true);
          };
          return row;
        }),
      );
      if (!hits.length) {
        const none = document.createElement('div');
        none.className = 'ix-portal-none';
        none.textContent = 'No screen with that id or name';
        list.append(none);
      }
    };
    input.oninput = () => {
      cur = 0;
      render();
    };
    input.onkeydown = (ev) => {
      ev.stopPropagation();
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        cur = Math.min(hits.length - 1, cur + 1);
        render();
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        cur = Math.max(0, cur - 1);
        render();
      } else if (ev.key === 'Enter') {
        chosen = hits[cur];
        this.closeEditor(true);
      } else if (ev.key === 'Escape') this.closeEditor(false);
    };
    wrap.place = () => {
      // at the drop point, kept inside the canvas
      const [x, y] = this.e.vp.toScreen(wx, wy);
      const W = this.e.root.clientWidth;
      const H = this.e.root.clientHeight;
      const cx = Math.max(8, Math.min(x, W - 328));
      const cy = Math.max(30, Math.min(y, H - 300));
      wrap.style.transform = `translate(${Math.round(cx)}px, ${Math.round(cy)}px)`;
    };
    wrap.commit = (commit) => {
      if (!commit || !chosen) return;
      const page = this.page;
      // the smallest section under the drop point holds the portal
      let parent: Id | undefined;
      let area = Number.POSITIVE_INFINITY;
      for (const [sid, it] of Object.entries(page.items)) {
        if (it.kind !== 'section' || it.archived) continue;
        const r = this.e.rects.get(sid);
        if (r && wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h && r.w * r.h < area) {
          parent = sid;
          area = r.w * r.h;
        }
      }
      const pr = parent ? this.e.rects.get(parent) : undefined;
      const W = 300;
      const H = 92;
      const other = chosen.page !== this.e.pageId;
      const item = {
        kind: 'portal',
        text: `${chosen.title || chosen.id}\n→ ${chosen.id}${other ? ` on ${chosen.pageName}` : ''}`,
        target: other ? `page:${chosen.page}/${chosen.id}` : chosen.id,
        x: Math.round(wx - (pr?.x ?? 0)),
        y: Math.round(wy - H / 2 - (pr?.y ?? 0)),
        w: W,
        h: H,
        pinned: true,
        ...(parent ? { parent } : {}),
      } as Item;
      const added = addItem(this.model.docs, this.e.pageId, item);
      if (!from) {
        // from the right-click menu: the portal alone; connect it later from a screen's edge
        this.apply(added.ops, `Portal to ${chosen.id}`);
        this.select([added.id]);
        return;
      }
      const docs2 = applyOps(this.model.docs, added.ops).docs;
      const arrow = addArrow(docs2, this.e.pageId, from, added.id, side ? { fromSide: side } : {});
      this.apply([...added.ops, ...arrow.ops], `Portal to ${chosen.id}`);
      this.select([], [arrow.id]);
    };
    this.e.overlay.appendChild(wrap);
    this.editor = wrap;
    wrap.place();
    render();
    input.focus({ preventScroll: true });
    app.set({ editing: { kind: 'portal', id: from ?? '' }, hint: 'Enter picks the screen · Esc draws nothing' });
  }

  /** Arrow label editor with the four arrow styles underneath. */
  editLabel(arrowId: Id, created = false) {
    const a = this.page.arrows[arrowId];
    if (!a) return;
    this.closeEditor(true);
    const wrap = document.createElement('div') as HTMLDivElement & {
      place?: () => void;
      commit?: (c: boolean) => void;
    };
    wrap.className = 'ix-editor ix-label';
    const input = document.createElement('input');
    input.value = a.label ?? '';
    input.placeholder = 'What does the person do? (or the condition)';
    input.setAttribute('aria-label', 'Arrow label');
    const styles = document.createElement('div');
    styles.className = 'ix-styles';
    let style = a.style ?? 'flow';
    const all = arrowStylesOf(this.model.docs.project);
    const renderStyles = () => {
      styles.replaceChildren();
      for (const [sid, st] of Object.entries(all)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `ix-style${sid === style ? ' on' : ''}`;
        const sw = document.createElement('i');
        sw.style.borderTopColor = st.color;
        sw.style.borderTopStyle = st.dash ? 'dashed' : 'solid';
        b.append(sw, document.createTextNode(st.label));
        b.onpointerdown = (ev) => ev.preventDefault();
        b.onclick = () => {
          style = sid;
          renderStyles();
          input.focus({ preventScroll: true });
        };
        styles.appendChild(b);
      }
    };
    renderStyles();
    wrap.append(input, styles);
    this.e.overlay.appendChild(wrap);
    wrap.place = () => {
      const route = this.e.routes.get(arrowId);
      if (!route) return;
      const [x, y] = this.e.vp.toScreen(route.label[0], route.label[1]);
      wrap.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    };
    wrap.commit = (commit) => {
      if (!commit) return;
      const label = input.value.trim();
      const cur = this.model.docs.pages[this.e.pageId]?.arrows[arrowId];
      if (!cur) return;
      const patch: ArrowPatch = {};
      if ((cur.label ?? '') !== label) patch.label = label || undefined;
      if ((cur.style ?? 'flow') !== style) patch.style = style === 'flow' ? undefined : style;
      if (Object.keys(patch).length)
        this.apply(
          updateArrow(this.model.docs, this.e.pageId, arrowId, patch, 'human'),
          label ? `Arrow: “${label}”` : 'Changed an arrow',
        );
    };
    input.onkeydown = (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') this.closeEditor(true);
      if (ev.key === 'Escape') this.closeEditor(false);
    };
    this.editor = wrap;
    wrap.place();
    input.focus({ preventScroll: true });
    input.select();
    app.set({
      editing: { kind: 'label', id: arrowId },
      hint: `Enter saves · the label goes into pages/${this.e.pageId}.json`,
    });
    void created;
  }

  /** Inline editing of notes and texts (the element itself becomes editable). */
  editText(id: Id, created = false) {
    const it = this.page.items[id];
    if (!it || (it.kind !== 'note' && it.kind !== 'text')) return;
    this.closeEditor(true);
    const el = this.e.nodeOf(id);
    if (!el) return;
    const wrap = document.createElement('div') as HTMLDivElement & {
      place?: () => void;
      commit?: (c: boolean) => void;
    };
    wrap.className = 'ix-editor ix-text';
    if (it.kind === 'note') {
      const sw = document.createElement('div');
      sw.className = 'ix-swatch';
      for (const c of NOTE_COLORS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `note-${c}${(it.color ?? 'yellow') === c ? ' on' : ''}`;
        b.title = c;
        b.onpointerdown = (ev) => ev.preventDefault();
        b.onclick = () => {
          this.apply([{ doc: pageKey(this.e.pageId), path: ['items', id, 'color'], value: c }], 'Note colour');
          for (const x of sw.children) x.classList.toggle('on', x === b);
        };
        sw.appendChild(b);
      }
      wrap.appendChild(sw);
    }
    this.e.overlay.appendChild(wrap);
    el.contentEditable = 'plaintext-only';
    el.classList.add('editing');
    const original = it.text;
    el.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    wrap.place = () => {
      const r = this.e.rects.get(id);
      if (!r) return;
      const [x, y] = this.e.vp.toScreen(r.x, r.y);
      wrap.style.transform = `translate(${Math.round(x)}px, ${Math.round(y - 40)}px)`;
    };
    wrap.commit = (commit) => {
      el.contentEditable = 'false';
      el.classList.remove('editing');
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('blur', onBlur);
      const text = (el.innerText ?? '').replace(/\n$/, '');
      if (!commit) {
        el.textContent = original;
        if (created && !original)
          this.apply(removeItems(this.model.docs, this.e.pageId, [id]), 'Removed an empty note');
        return;
      }
      if (!text.trim()) {
        this.apply(
          removeItems(this.model.docs, this.e.pageId, [id]),
          it.kind === 'note' ? 'Removed an empty note' : 'Removed an empty text',
        );
        this.select([]);
        return;
      }
      if (text !== original)
        this.apply(
          [{ doc: pageKey(this.e.pageId), path: ['items', id, 'text'], value: text }],
          it.kind === 'note' ? 'Edited a note' : 'Edited a text',
        );
    };
    const onKey = (ev: KeyboardEvent) => {
      ev.stopPropagation();
      if (ev.key === 'Escape') this.closeEditor(!created);
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) this.closeEditor(true);
    };
    const onBlur = () => setTimeout(() => this.editor === wrap && this.closeEditor(true), 120);
    el.addEventListener('keydown', onKey);
    el.addEventListener('blur', onBlur);
    this.editor = wrap;
    wrap.place();
    app.set({ editing: { kind: it.kind, id }, hint: '⌘↩ saves · Esc cancels' });
  }

  renameSection(id: Id, created = false) {
    const it = this.page.items[id];
    if (!it || it.kind !== 'section') return;
    this.closeEditor(true);
    const wrap = document.createElement('div') as HTMLDivElement & {
      place?: () => void;
      commit?: (c: boolean) => void;
    };
    wrap.className = 'ix-editor ix-sectitle';
    const input = document.createElement('input');
    input.value = it.title;
    input.setAttribute('aria-label', 'Section title');
    wrap.appendChild(input);
    this.e.overlay.appendChild(wrap);
    wrap.place = () => {
      const r = this.e.rects.get(id);
      if (!r) return;
      const [x, y] = this.e.vp.toScreen(r.x, r.y);
      wrap.style.transform = `translate(${Math.round(x)}px, ${Math.round(y - 32)}px)`;
    };
    wrap.commit = (commit) => {
      const v = input.value.trim();
      if (commit && v && v !== it.title)
        this.apply([{ doc: pageKey(this.e.pageId), path: ['items', id, 'title'], value: v }], 'Renamed a section');
    };
    input.onkeydown = (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') this.closeEditor(true);
      if (ev.key === 'Escape') this.closeEditor(!created);
    };
    input.onblur = () => setTimeout(() => this.editor === wrap && this.closeEditor(true), 120);
    this.editor = wrap;
    wrap.place();
    input.focus({ preventScroll: true });
    input.select();
  }

  // ---------- double click, overlay clicks, context menu ----------

  private dbl(ev: MouseEvent) {
    if ((ev.target as Element).closest?.('[data-snd]')) return;
    const hit = this.hitAt(ev);
    if (hit.arrow) return this.editLabel(hit.arrow);
    if (hit.id) {
      const it = this.page.items[hit.id];
      if (it?.kind === 'note' || it?.kind === 'text') return this.editText(hit.id);
      if (it?.kind === 'section') return this.renameSection(hit.id);
      if (it?.kind === 'screen' || it?.kind === 'portal') {
        if (it.kind === 'portal' && it.target) return this.followPortal(it.target);
        this.e.fit([hit.id]);
      }
    }
  }

  followPortal(target: string) {
    const m = target.match(/^page:([^/]+)\/(.+)$/);
    if (m && m[1] !== this.e.pageId) {
      // another page: open it at the screen (the event this used to send had no listener, so nothing happened)
      const pid = app.get().project?.id;
      if (pid) navigate({ pid, page: m[1]!, focus: m[2]! });
      return;
    }
    const id = m ? m[2]! : target;
    if (this.e.rects.has(id)) {
      this.select([id]);
      this.e.fit([id]);
    }
  }

  private speakerClick(ev: MouseEvent) {
    const b = (ev.target as Element).closest?.('[data-snd]') as HTMLElement | null;
    if (!b) return;
    ev.stopPropagation();
    toggleScreenSound(b.dataset.snd!);
  }

  private overlayClick(ev: MouseEvent) {
    const btn = (ev.target as Element).closest('[data-act]') as HTMLElement | null;
    const title = (ev.target as Element).closest('.sec-title') as HTMLElement | null;
    if (!btn || !title) return;
    const id = title.dataset.id!;
    if (btn.dataset.act === 'focus') this.e.fit([id]);
    if (btn.dataset.act === 'png')
      void downloadPng(
        this.model.id,
        this.e.pageId,
        id,
        this.page.items[id]?.kind === 'section' ? (this.page.items[id] as { title: string }).title : id,
      );
  }

  private ctxEl?: HTMLDivElement | undefined;
  private closeContext() {
    this.ctxEl?.remove();
    this.ctxEl = undefined;
  }

  private context(ev: MouseEvent) {
    ev.preventDefault();
    this.closeContext();
    const hit = this.hitAt(ev);
    const [wx, wy] = this.world(ev);
    const items: ([string, () => void, string?] | 'sep')[] = [];
    if (hit.arrow) {
      const aid = hit.arrow;
      this.select([], [aid]);
      items.push(['Edit label', () => this.editLabel(aid), '↩']);
      for (const [sid, st] of Object.entries(arrowStylesOf(this.model.docs.project)))
        items.push([
          `Style: ${st.label}`,
          () =>
            this.apply(
              updateArrow(this.model.docs, this.e.pageId, aid, { style: sid === 'flow' ? undefined : sid }, 'human'),
              `Arrow style: ${st.label}`,
            ),
        ]);
      items.push('sep');
      items.push(['Reverse', () => this.apply(reverseArrow(this.model.docs, this.e.pageId, aid), 'Reversed an arrow')]);
      if (this.page.arrows[aid]?.waypoints)
        items.push([
          'Reset route',
          () =>
            this.apply(
              updateArrow(
                this.model.docs,
                this.e.pageId,
                aid,
                { waypoints: undefined, fromSide: undefined, toSide: undefined },
                'human',
              ),
              'Reset an arrow route',
            ),
        ]);
      items.push(['Delete', () => this.deleteSelection(), '⌫']);
    } else if (hit.id || hit.section) {
      const id = (hit.id ?? hit.section)!;
      if (!app.get().selection.includes(id)) this.select([id]);
      const it = this.page.items[id]!;
      items.push(['Zoom to', () => this.e.fit(app.get().selection), '⇧2']);
      if (it.kind === 'screen') {
        items.push([
          'Open the HTML file',
          () =>
            void api(`/api/p/${encodeURIComponent(this.model.id)}/open`, {
              method: 'POST',
              body: JSON.stringify({ file: this.model.screenOf(id, it)?.file ?? `screens/${id}.html` }),
            }),
        ]);
        items.push([
          'Show in Finder',
          () =>
            void api(`/api/p/${encodeURIComponent(this.model.id)}/open`, {
              method: 'POST',
              body: JSON.stringify({ file: this.model.screenOf(id, it)?.file ?? `screens/${id}.html`, reveal: true }),
            }),
        ]);
        items.push(['Connect from here', () => app.set({ tool: 'arrow' })]);
      }
      if (it.kind === 'note' || it.kind === 'text') items.push(['Edit', () => this.editText(id), '↩']);
      if (it.kind === 'section') {
        items.push(['Rename', () => this.renameSection(id)]);
        if (!hit.id) items.push(['Add a portal here…', () => this.pickPortal(undefined, wx, wy)]);
      }
      items.push('sep');
      items.push(['Duplicate', () => this.duplicate(), '⌘D']);
      items.push(['Copy', () => this.copy(), '⌘C']);
      items.push([it.kind === 'screen' ? 'Remove from page' : 'Delete', () => this.deleteSelection(), '⌫']);
    } else {
      items.push(['Paste here', () => void this.paste(wx, wy), '⌘V']);
      items.push(['Add a note here', () => this.createNote(wx, wy), 'N']);
      items.push(['Add a text here', () => this.createText(wx, wy), 'T']);
      items.push(['Add a portal here…', () => this.pickPortal(undefined, wx, wy)]);
      items.push('sep');
      items.push(['Select all', () => this.selectAll(), '⌘A']);
      items.push(['Zoom to fit', () => this.e.fitAll(), '⇧1']);
    }
    const menu = document.createElement('div');
    menu.className = 'menu ix-ctx';
    menu.setAttribute('role', 'menu');
    for (const x of items) {
      if (x === 'sep') {
        menu.appendChild(document.createElement('hr'));
        continue;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mi';
      b.setAttribute('role', 'menuitem');
      b.textContent = x[0];
      if (x[2]) {
        const r = document.createElement('span');
        r.className = 'r';
        r.textContent = x[2];
        b.appendChild(r);
      }
      b.onclick = () => {
        this.closeContext();
        x[1]();
      };
      menu.appendChild(b);
    }
    const rr = this.e.root.getBoundingClientRect();
    menu.style.left = `${Math.min(ev.clientX - rr.left, rr.width - 240)}px`;
    menu.style.top = `${Math.min(ev.clientY - rr.top, rr.height - items.length * 34 - 20)}px`;
    menu.onpointerdown = (e2) => e2.stopPropagation();
    this.e.overlay.appendChild(menu);
    this.ctxEl = menu;
    const off = (e2: Event) => {
      if (this.ctxEl && !this.ctxEl.contains(e2.target as Node)) {
        this.closeContext();
        window.removeEventListener('pointerdown', off, true);
      }
    };
    window.addEventListener('pointerdown', off, true);
  }

  // ---------- keyboard ----------

  private key(ev: KeyboardEvent) {
    if (isTyping() || this.editor) return;
    if (!this.e.page) return;
    const mod = ev.metaKey || ev.ctrlKey;
    const s = app.get();
    if (ev.key === 'Escape') {
      if (this.mode.k === 'drag' || this.mode.k === 'reattach' || this.mode.k === 'bend') {
        this.mode = { k: 'idle' };
        this.e.root.classList.remove('dragging');
        this.e.endPreview();
        return;
      }
      if (this.mode.k !== 'idle') {
        this.mode = { k: 'idle' };
        this.e.schedule();
        return;
      }
      this.closeContext();
      if (s.selection.length || s.arrowSel.length) this.select([]);
      if (s.tool !== 'select') app.set({ tool: 'select' });
      return;
    }
    if (mod && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      const r = ev.shiftKey ? this.model.redo() : this.model.undo();
      if (r)
        toast({
          kind: 'info',
          text: `${ev.shiftKey ? 'Redo' : 'Undo'}: ${r.summary}${r.skipped ? ` · ${r.skipped} change${r.skipped === 1 ? '' : 's'} kept because Claude changed them since` : ''}`,
        });
      else toast({ kind: 'info', text: ev.shiftKey ? 'Nothing to redo' : 'Nothing to undo' });
      return;
    }
    if (mod && ev.key.toLowerCase() === 'y') {
      ev.preventDefault();
      const r = this.model.redo();
      if (r) toast({ kind: 'info', text: `Redo: ${r.summary}` });
      return;
    }
    if (mod && ev.key.toLowerCase() === 'a') {
      ev.preventDefault();
      this.selectAll();
      return;
    }
    if (mod && ev.key.toLowerCase() === 'c') {
      this.copy();
      return;
    }
    if (mod && ev.key.toLowerCase() === 'v') {
      ev.preventDefault();
      void this.paste();
      return;
    }
    if (mod && ev.key.toLowerCase() === 'd') {
      ev.preventDefault();
      this.duplicate();
      return;
    }
    if ((ev.key === 'Backspace' || ev.key === 'Delete') && (s.selection.length || s.arrowSel.length)) {
      ev.preventDefault();
      this.deleteSelection();
      return;
    }
    if (ev.key === 'Enter') {
      if (s.arrowSel.length === 1) {
        ev.preventDefault();
        this.editLabel(s.arrowSel[0]!);
      } else if (s.selection.length === 1) {
        const it = this.page.items[s.selection[0]!];
        if (it?.kind === 'note' || it?.kind === 'text') {
          ev.preventDefault();
          this.editText(s.selection[0]!);
        } else if (it?.kind === 'section') {
          ev.preventDefault();
          this.renameSection(s.selection[0]!);
        }
      }
      return;
    }
    if (ev.key.startsWith('Arrow') && s.selection.length && !mod) {
      ev.preventDefault();
      const step = ev.shiftKey ? 10 : 1;
      const dx = ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0;
      const dy = ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0;
      this.nudge(dx, dy);
    }
  }

  private nudgeTimer = 0;
  private nudge(dx: number, dy: number) {
    const page = this.page;
    const ids = topLevel(app.get().selection, page.items);
    const moves = ids
      .map((id) => {
        const it = page.items[id];
        const r = this.e.rects.get(id);
        if (!it || !r) return undefined;
        const ox = it.x ?? r.x - (it.parent ? (this.e.rects.get(it.parent)?.x ?? 0) : 0);
        const oy = it.y ?? r.y - (it.parent ? (this.e.rects.get(it.parent)?.y ?? 0) : 0);
        return { id, x: ox + dx, y: oy + dy };
      })
      .filter(Boolean) as { id: Id; x: number; y: number }[];
    if (!moves.length) return;
    // a burst of nudges is one undo step
    const ops = moveItems(this.model.docs, this.e.pageId, moves, 'human');
    const now = Date.now();
    const merge =
      now - this.nudgeTimer < 800 && this.model.undoStack[this.model.undoStack.length - 1]?.summary === 'Nudged';
    this.nudgeTimer = now;
    const applied = this.model.apply(ops, 'Nudged', { undoable: !merge, page: this.e.pageId });
    if (merge) {
      const last = this.model.undoStack[this.model.undoStack.length - 1]!;
      last.ops = [...last.ops, ...applied];
    }
  }

  selectAll() {
    this.select(Object.keys(this.page.items).filter((id) => !this.page.items[id]!.archived));
  }

  deleteSelection() {
    const s = app.get();
    const page = this.page;
    if (s.arrowSel.length) {
      const ops: SetOp[] = s.arrowSel
        .filter((a) => page.arrows[a])
        .map((a) => ({ doc: pageKey(this.e.pageId), path: ['arrows', a], value: undefined }));
      this.apply(ops, s.arrowSel.length === 1 ? 'Deleted an arrow' : `Deleted ${s.arrowSel.length} arrows`);
      this.select([]);
      return;
    }
    const ids = s.selection.filter((id) => page.items[id]);
    if (!ids.length) return;
    const screens = ids.filter((id) => page.items[id]!.kind === 'screen').length;
    const heirs = removalHeirs(this.model.docs, this.e.pageId, ids);
    const done = this.apply(
      removeItems(this.model.docs, this.e.pageId, ids, (id) => this.e.rects.get(id)),
      screens
        ? `Removed ${screens} screen${screens === 1 ? '' : 's'} from the page`
        : `Deleted ${ids.length} item${ids.length === 1 ? '' : 's'}`,
    );
    this.select([]);
    // nothing applied (a built-in example): no toast claiming it happened
    if (screens && done.length)
      toast({
        kind: 'info',
        text: `${heirs.map(([id, heir]) => `${heir} takes ${id}'s place, the other options stay. `).join('')}The HTML file${screens === 1 ? ' stays' : 's stay'} in screens/. Undo with ⌘Z.`,
        action: { label: 'Undo', run: () => this.model.undo() },
      });
  }

  copy() {
    const ids = app.get().selection;
    if (!ids.length) return;
    clipboard = { project: this.model.id, page: this.e.pageId, ids: [...ids] };
    navigator.clipboard?.writeText(ids.join(', ')).catch(() => undefined);
    toast({ kind: 'ok', text: `Copied ${ids.length} item${ids.length === 1 ? '' : 's'}` });
  }

  async paste(wx?: number, wy?: number) {
    if (!clipboard || clipboard.project !== this.model.id) return;
    const src = this.model.docs.pages[clipboard.page];
    if (!src) return;
    const ids = clipboard.ids.filter((id) => src.items[id]);
    if (!ids.length) return;
    let dx = 40;
    let dy = 40;
    if (wx !== undefined && wy !== undefined) {
      const rs = ids
        .map((id) => (clipboard!.page === this.e.pageId ? this.e.rects.get(id) : undefined))
        .filter(Boolean) as Rect[];
      const b = union(rs);
      if (b) {
        dx = wx - b.x;
        dy = wy - b.y;
      }
    } else if (clipboard.page !== this.e.pageId) {
      dx = 0;
      dy = 0;
    }
    const r = duplicateItems(this.model.docs, clipboard.page, this.e.pageId, ids, dx, dy);
    this.apply(r.ops, `Pasted ${ids.length} item${ids.length === 1 ? '' : 's'}`);
    this.select(Object.values(r.idMap));
  }

  duplicate() {
    const ids = app.get().selection;
    if (!ids.length) return;
    const r = duplicateItems(this.model.docs, this.e.pageId, this.e.pageId, topLevel(ids, this.page.items), 40, 40);
    this.apply(r.ops, `Duplicated ${ids.length} item${ids.length === 1 ? '' : 's'}`);
    this.select(Object.values(r.idMap));
  }
}

// ---------- helpers ----------

function toggle(list: Id[], id: Id): Id[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}
function sameList(a: Id[], b: Id[]) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
function norm(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}
function contains(outer: Rect, inner: Rect | undefined): boolean {
  return (
    !!inner &&
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}
/** Drop items whose section (or anchor) is also selected: they move with it. */
function topLevel(ids: Id[], items: Record<Id, Item>): Id[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    let cur = items[id];
    const seen = new Set<Id>();
    while (cur) {
      const up = cur.parent ?? (cur.kind === 'note' ? cur.anchor : undefined);
      if (!up || seen.has(up)) return true;
      if (set.has(up)) return false;
      seen.add(up);
      cur = items[up];
    }
    return true;
  });
}
function sidePt(r: Rect, side: Side): [number, number] {
  if (side === 'left') return [r.x, r.y + r.h / 2];
  if (side === 'right') return [r.x + r.w, r.y + r.h / 2];
  if (side === 'top') return [r.x + r.w / 2, r.y];
  return [r.x + r.w / 2, r.y + r.h];
}
function setH(el: HTMLElement, kind: string, id: Id, title?: string) {
  el.dataset.h = kind;
  el.dataset.id = id;
  if (title) el.title = title;
}

async function downloadPng(pid: string, page: string, id: Id, name: string) {
  toast({ kind: 'info', text: 'Rendering the PNG…' });
  try {
    const r = await api<{ ok: boolean; text: string; data?: { png?: string } }>('/api/cmd/render', {
      method: 'POST',
      body: JSON.stringify({ args: ['--project', pid, '--page', page, '--section', id, '--base64'] }),
    });
    if (!r.ok || !r.data?.png) throw new Error(r.text);
    const a = document.createElement('a');
    a.href = `data:image/png;base64,${r.data.png}`;
    a.download = `${name.replace(/[^\w.-]+/g, '-')}.png`;
    a.click();
  } catch (e) {
    toast({ kind: 'warn', text: `PNG export failed: ${(e as Error).message}` });
  }
}
