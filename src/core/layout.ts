// Where every item sits. Positions in the files are relative to the parent section (notes: to their anchor);
// items without x/y are placed automatically, deterministically, the way a person would lay out a wireflow:
// a screen goes right of the screen that leads to it, proposals go under the screen they would replace.
import { inflate, intersects } from './geom.ts';
import type { Id, Item, PageDoc, Rect, Size } from './types.ts';

export const GAP_X = 280; // room for arrow labels between screens
export const GAP_Y = 180; // room for the next row's caption and banner
export const SECTION_PAD = 64;
export const SECTION_HEAD = 150; // space above the first row for captions and banners
export const SECTION_GAP = 320;
const NOTE_GAP = 12; // between notes stacked under one item
export const CAPTION_SPACE = 70; // caption + banner drawn above a screen

export type SizeOf = (id: Id, item: Item) => Size;

export interface Placement {
  /** Absolute rectangles of every item (page coordinates). */
  rects: Map<Id, Rect>;
  /** Positions chosen automatically (relative, as they would be written to the file). */
  auto: Map<Id, { x: number; y: number }>;
  /** Section sizes computed from their children (when not given). */
  sectionSizes: Map<Id, Size>;
}

/** Default sizes for the kinds that are not screens. */
export function defaultSize(item: Item): Size {
  switch (item.kind) {
    case 'section':
      return { w: item.w ?? 800, h: item.h ?? 600 };
    case 'note':
      return item.size === 'small'
        ? { w: item.w ?? 220, h: estimateTextHeight(item.text, (item.w ?? 220) - 20, 12, 1.35) + 14 }
        : { w: item.w ?? 260, h: estimateTextHeight(item.text, item.w ?? 260, 15, 1.45) + 28 };
    case 'text': {
      const size = item.size ?? 'h2';
      const px = size === 'h1' ? 64 : size === 'h2' ? 40 : size === 'h3' ? 26 : 16;
      const w = item.w ?? Math.max(120, Math.min(2400, item.text.length * px * 0.56));
      return { w, h: estimateTextHeight(item.text, w, px, 1.15) };
    }
    case 'portal':
      return { w: item.w ?? 300, h: item.h ?? 92 };
    case 'image':
      return { w: item.w, h: item.h ?? item.w };
    case 'screen':
      return { w: 393, h: 852 };
  }
}

/** Height of a screen's caption plus banner (drawn above the frame), matching the app's CSS: a 19 px caption line
 *  with 8 px below it, and a 15 px banner of at most two lines with 13 px padding. */
export function screenHeadHeight(bannerText: string | undefined, frameWidth: number): number {
  const caption = 32;
  if (bannerText === undefined) return caption;
  const perLine = Math.max(8, Math.floor((frameWidth - 24) / 8.4));
  const lines = Math.min(2, Math.max(1, Math.ceil(bannerText.length / perLine)));
  return caption + 13 + Math.ceil(lines * 19.5);
}

export function estimateTextHeight(text: string, width: number, px: number, lh: number): number {
  const charsPerLine = Math.max(8, Math.floor(width / (px * 0.55)));
  let lines = 0;
  for (const para of text.split('\n')) lines += Math.max(1, Math.ceil(para.length / charsPerLine));
  return Math.ceil(lines * px * lh);
}

function depthOf(page: PageDoc, id: Id): number {
  let d = 0;
  let cur = page.items[id]?.parent;
  const seen = new Set<Id>();
  while (cur && page.items[cur] && !seen.has(cur)) {
    seen.add(cur);
    d++;
    cur = page.items[cur]!.parent;
  }
  return d;
}

function validParent(page: PageDoc, id: Id): Id | undefined {
  const p = page.items[id]?.parent;
  if (!p || p === id) return undefined;
  const it = page.items[p];
  if (it?.kind !== 'section') return undefined;
  // reject cycles
  let cur: Id | undefined = p;
  const seen = new Set<Id>([id]);
  while (cur) {
    if (seen.has(cur)) return undefined;
    seen.add(cur);
    cur = page.items[cur]?.parent;
  }
  return p;
}

/** Compute absolute rectangles for a page, placing items that have no position. */
export function placePage(page: PageDoc, sizeOf: SizeOf): Placement {
  const auto = new Map<Id, { x: number; y: number }>();
  const sectionSizes = new Map<Id, Size>();
  const rel = new Map<Id, Rect>(); // relative rects (to parent / anchor)
  // archived items only show on the History page itself
  const items = Object.entries(page.items).filter(([, it]) => !it.archived || page.kind === 'history');
  const ids = new Set(items.map(([id]) => id));

  const sizeOfItem = (id: Id, it: Item): Size => {
    if (it.kind === 'section') return sectionSizes.get(id) ?? { w: it.w ?? 800, h: it.h ?? 600 };
    if (it.kind === 'screen') return sizeOf(id, it);
    const s = defaultSize(it);
    return it.kind === 'image' ? (sizeOf(id, it) ?? s) : s;
  };

  // groups: parent id ('' = page); anchored notes are handled after everything else
  const groups = new Map<string, [Id, Item][]>();
  const anchored: [Id, Item][] = [];
  for (const [id, it] of items) {
    if (it.kind === 'note' && it.anchor && ids.has(it.anchor) && it.anchor !== id) {
      anchored.push([id, it]);
      continue;
    }
    const p = validParent(page, id) ?? '';
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p)!.push([id, it]);
  }
  // notes hanging off an item: the ones put somewhere stay there, the others stack under the item and under each
  // other (they used to land on top of each other at the same spot)
  const anchoredBy = new Map<Id, [Id, Item][]>();
  for (const [id, it] of anchored) {
    const a = (it as Extract<Item, { kind: 'note' }>).anchor!;
    if (!anchoredBy.has(a)) anchoredBy.set(a, []);
    anchoredBy.get(a)!.push([id, it]);
  }
  const noteOffsets = (anchor: Id, anchorH: number): Map<Id, Rect> => {
    const out = new Map<Id, Rect>();
    const list = anchoredBy.get(anchor) ?? [];
    let bottom = anchorH + 40 - NOTE_GAP;
    for (const [id, it] of list)
      if (typeof it.x === 'number' && typeof it.y === 'number') {
        const s = sizeOfItem(id, it);
        out.set(id, { x: it.x, y: it.y, w: s.w, h: s.h });
        bottom = Math.max(bottom, it.y + s.h);
      }
    for (const [id, it] of list)
      if (!out.has(id)) {
        const s = sizeOfItem(id, it);
        const y = bottom + NOTE_GAP;
        out.set(id, { x: 0, y, w: s.w, h: s.h });
        bottom = y + s.h;
      }
    return out;
  };
  /** How far down an item reaches with the notes hanging off it (relative to its top). */
  const reach = (id: Id, h: number) => {
    let b = h;
    for (const r of noteOffsets(id, h).values()) b = Math.max(b, r.y + r.h);
    return b;
  };

  // deepest groups first so section sizes are known before their parent group is laid out
  const order = [...groups.keys()].sort((a, b) => (b ? depthOf(page, b) + 1 : 0) - (a ? depthOf(page, a) + 1 : 0));
  for (const g of order) {
    const members = groups.get(g)!;
    const placed: { id: Id; r: Rect; it: Item }[] = [];
    const pending: [Id, Item][] = [];
    for (const [id, it] of members) {
      const s = sizeOfItem(id, it);
      if (typeof it.x === 'number' && typeof it.y === 'number') {
        const r = { x: it.x, y: it.y, w: s.w, h: s.h };
        rel.set(id, r);
        placed.push({ id, r, it });
      } else pending.push([id, it]);
    }
    for (const [id, it] of flowOrder(page, pending)) {
      const s = sizeOfItem(id, it);
      const pos = autoPosition(page, g, id, it, s, placed, reach);
      const r = { x: pos.x, y: pos.y, w: s.w, h: s.h };
      auto.set(id, pos);
      rel.set(id, r);
      placed.push({ id, r, it });
    }
    pushApart(placed);
    if (g) {
      // a stored size is a minimum: the frame always holds its items and the notes hanging off them (options placed
      // under a screen, a screen dragged past the edge)
      const sec = page.items[g] as Extract<Item, { kind: 'section' }>;
      let w = 0;
      let h = 0;
      const here = new Map<Id, Rect>();
      for (const p of placed) {
        here.set(p.id, p.r);
        w = Math.max(w, p.r.x + p.r.w);
        h = Math.max(h, p.r.y + p.r.h);
      }
      for (const [aid, a] of here)
        for (const r of noteOffsets(aid, a.h).values()) {
          w = Math.max(w, a.x + r.x + r.w);
          h = Math.max(h, a.y + r.y + r.h);
        }
      sectionSizes.set(g, { w: Math.max(sec.w ?? 400, w + SECTION_PAD), h: Math.max(sec.h ?? 300, h + SECTION_PAD) });
    }
  }

  // absolute positions
  const rects = new Map<Id, Rect>();
  const absOf = (id: Id, guard = 0): Rect | undefined => {
    const done = rects.get(id);
    if (done) return done;
    const r = rel.get(id);
    if (!r || guard > 64) return undefined;
    const p = validParent(page, id);
    const base = p ? absOf(p, guard + 1) : undefined;
    const a = base ? { x: base.x + r.x, y: base.y + r.y, w: r.w, h: r.h } : { ...r };
    rects.set(id, a);
    return a;
  };
  for (const id of rel.keys()) absOf(id);
  const offsetsOf = new Map<Id, Map<Id, Rect>>();
  for (const [id, it] of anchored) {
    const note = it as Extract<Item, { kind: 'note' }>;
    const a = rects.get(note.anchor!);
    if (!a) continue;
    if (!offsetsOf.has(note.anchor!)) offsetsOf.set(note.anchor!, noteOffsets(note.anchor!, a.h));
    const r = offsetsOf.get(note.anchor!)!.get(id)!;
    if (typeof it.x !== 'number' || typeof it.y !== 'number') auto.set(id, { x: r.x, y: r.y });
    rects.set(id, { x: a.x + r.x, y: a.y + r.y, w: r.w, h: r.h });
  }
  return { rects, auto, sectionSizes };
}

/** A section that grew past its stored size pushes the sections that were beside it to the right (or below it, down),
 *  keeping the gap the person left, so a growing section never covers its neighbour. A section without a stored size
 *  (sized by what it holds) has no edge the person left: the sections that start right of it on the same band are its
 *  right neighbours, the ones that start below it and overlap it sideways are below, and they keep SECTION_GAP.
 *  Pushes cascade. Only the drawn positions move; the files keep what the person placed. */
function pushApart(placed: { id: Id; r: Rect; it: Item }[]) {
  const secs = placed.filter((p) => p.it.kind === 'section');
  if (secs.length < 2) return;
  const stored = new Map(
    secs.map((p) => {
      const it = p.it as Extract<Item, { kind: 'section' }>;
      return [p.id, { x: p.r.x, y: p.r.y, w: it.w, h: it.h, rw: p.r.w, rh: p.r.h }];
    }),
  );
  for (let round = 0; round < secs.length * 2; round++) {
    let moved = false;
    for (const a of secs)
      for (const b of secs) {
        if (a === b || !intersects(a.r, b.r)) continue;
        const sa = stored.get(a.id)!;
        const sb = stored.get(b.id)!;
        const [aw, ah, bw, bh] = [sa.w ?? sa.rw, sa.h ?? sa.rh, sb.w ?? sb.rw, sb.h ?? sb.rh];
        const right = sa.w !== undefined ? sb.x >= sa.x + sa.w : sb.x > sa.x && sb.y < sa.y + ah && sa.y < sb.y + bh;
        const below = sa.h !== undefined ? sb.y >= sa.y + sa.h : sb.y > sa.y && sb.x < sa.x + aw && sa.x < sb.x + bw;
        if (right) {
          const gap = sa.w !== undefined ? sb.x - (sa.x + sa.w) : SECTION_GAP;
          const x = a.r.x + a.r.w + gap;
          if (x > b.r.x) {
            b.r.x = x;
            moved = true;
          }
        } else if (below) {
          const gap = sa.h !== undefined ? sb.y - (sa.y + sa.h) : SECTION_GAP;
          const y = a.r.y + a.r.h + gap;
          if (y > b.r.y) {
            b.r.y = y;
            moved = true;
          }
        }
      }
    if (!moved) break;
  }
}

/** Unplaced items in flow order: entry screens first, then flow starts (screens nothing points at) and loose screens
 *  in file order, each followed by the screens it leads to (breadth first); everything else in file order. A screen
 *  without arrows keeps its place among the flow starts instead of going to the end (a picked option has none). */
export function flowOrder(page: PageDoc, pending: [Id, Item][]): [Id, Item][] {
  if (pending.length < 2) return pending;
  const want = new Map(pending);
  const out: [Id, Item][] = [];
  const done = new Set<Id>();
  const next = new Map<Id, Id[]>();
  const hasIn = new Set<Id>();
  for (const a of Object.values(page.arrows)) {
    if (a.from === a.to || !page.items[a.from] || !page.items[a.to]) continue;
    if (!next.has(a.from)) next.set(a.from, []);
    next.get(a.from)!.push(a.to);
    hasIn.add(a.to);
  }
  const emit = (id: Id) => {
    if (done.has(id)) return;
    done.add(id);
    const it = want.get(id);
    if (it) out.push([id, it]);
  };
  const walk = (roots: Id[]) => {
    const queue = [...roots];
    while (queue.length) {
      const id = queue.shift()!;
      if (done.has(id)) continue;
      emit(id);
      for (const n of next.get(id) ?? []) if (!done.has(n)) queue.push(n);
    }
  };
  const ids = Object.keys(page.items);
  // placed items are roots too, so screens that follow them come next
  walk(ids.filter((id) => (page.items[id] as { entry?: boolean }).entry));
  for (const id of ids) if (!hasIn.has(id) && (next.has(id) || want.has(id))) walk([id]);
  for (const [id] of pending) walk([id]);
  return out;
}

function autoPosition(
  page: PageDoc,
  group: string,
  id: Id,
  it: Item,
  s: Size,
  placed: { id: Id; r: Rect; it: Item }[],
  reach: (id: Id, h: number) => number = (_id, h) => h,
): { x: number; y: number } {
  const byId = new Map(placed.map((p) => [p.id, p]));
  const startX = group ? SECTION_PAD : 0;
  const startY = group ? SECTION_HEAD : 0;
  // what each placed item takes up, with the notes hanging off it
  const boxes = placed.map((p) => ({ ...p.r, h: Math.max(p.r.h, reach(p.id, p.r.h)) }));
  /** The first free spot at x, from y down: straight under whatever is in the way. Stepping by the item's own
   *  height left holes the size of a screen (~1100 px between two screens of a real section). */
  const freeY = (x: number, y: number, w: number) => {
    let yy = y;
    for (let i = 0; i < 200; i++) {
      const pad = inflate({ x, y: yy, w, h: s.h }, GAP_X / 2 - 1, GAP_Y / 2 - 1);
      const hit = boxes.filter((b) => intersects(pad, b));
      if (!hit.length) return yy;
      yy = Math.max(...hit.map((b) => b.y + b.h)) + GAP_Y;
    }
    return yy;
  };
  const down = (x: number, y: number) => ({ x, y: freeY(x, y, s.w) });
  if (it.kind === 'section') {
    if (group) {
      // sections inside a section sit side by side, in file order, so a parent reads left to right like the rows of
      // the page (they used to stack into one tall column, and at x 0 on the parent's own edge)
      const secs = placed.filter((p) => p.it.kind === 'section');
      if (secs.length) {
        const last = secs.reduce((a, b) => (b.r.x + b.r.w > a.r.x + a.r.w ? b : a));
        return { x: last.r.x + last.r.w + SECTION_GAP / 2, y: last.r.y };
      }
      const bottom = placed.reduce((m, p) => Math.max(m, p.r.y + p.r.h), startY - SECTION_GAP / 2);
      return { x: startX, y: placed.length ? bottom + SECTION_GAP / 2 : startY };
    }
    const bottom = placed.reduce((m, p) => Math.max(m, p.r.y + p.r.h), -SECTION_GAP);
    return { x: 0, y: bottom + SECTION_GAP };
  }
  if (it.kind === 'screen' && it.proposalFor && byId.has(it.proposalFor)) {
    // options sit in a row under the screen they would replace, so arrows to them never cross each other's boxes.
    // The row is placed as one block: under the screen and the notes hanging off it, and below any other row that
    // is already in the way (two neighbours' rows used to interleave, and the later options piled up in a column)
    const t = byId.get(it.proposalFor)!.r;
    const peers = placed.filter((p) => p.it.kind === 'screen' && p.it.proposalFor === it.proposalFor);
    if (peers.length) {
      const last = peers.reduce((a, b) => (b.r.x + b.r.w > a.r.x + a.r.w ? b : a));
      return down(last.r.x + last.r.w + GAP_X, last.r.y);
    }
    const n = Object.values(page.items).filter(
      (x) => x.kind === 'screen' && !x.archived && x.proposalFor === it.proposalFor,
    ).length;
    const w = n * s.w + (n - 1) * GAP_X;
    return { x: t.x, y: freeY(t.x, t.y + reach(it.proposalFor, t.h) + GAP_Y, w) };
  }
  if (it.kind === 'screen' || it.kind === 'portal') {
    const incoming = Object.values(page.arrows).find((a) => a.to === id && byId.has(a.from) && a.from !== id);
    if (incoming) {
      const src = byId.get(incoming.from)!.r;
      return down(src.x + src.w + GAP_X, src.y);
    }
  }
  if (it.kind === 'screen' || it.kind === 'portal' || it.kind === 'image') {
    const row = placed.filter((p) => p.it.kind === 'screen' || p.it.kind === 'portal' || p.it.kind === 'image');
    if (!row.length) return { x: startX, y: startY };
    // the start of the group while it is free: one item placed further down (a person moved one screen) made the
    // whole flow start next to it, so everything else jumped down and right
    if (freeY(startX, startY, s.w) === startY) return { x: startX, y: startY };
    const top = Math.min(...row.map((p) => p.r.y));
    const right = Math.max(...row.filter((p) => p.r.y < top + 400).map((p) => p.r.x + p.r.w));
    return down(right + GAP_X, top);
  }
  // notes and texts go under everything in the group
  const bottom = placed.length ? Math.max(...placed.map((p) => p.r.y + p.r.h)) : startY - 100;
  return { x: startX, y: bottom + 100 };
}
