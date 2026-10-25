import type { Rect } from './types.ts';

export const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

export function containsPoint(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h;
}

export function inflate(r: Rect, dx: number, dy = dx): Rect {
  return { x: r.x - dx, y: r.y - dy, w: r.w + 2 * dx, h: r.h + 2 * dy };
}

export function union(rects: Iterable<Rect>): Rect | undefined {
  let x1 = Number.POSITIVE_INFINITY;
  let y1 = Number.POSITIVE_INFINITY;
  let x2 = Number.NEGATIVE_INFINITY;
  let y2 = Number.NEGATIVE_INFINITY;
  let any = false;
  for (const r of rects) {
    any = true;
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w);
    y2 = Math.max(y2, r.y + r.h);
  }
  return any ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : undefined;
}

export function center(r: Rect): [number, number] {
  return [r.x + r.w / 2, r.y + r.h / 2];
}

/** Does the segment (axis-aligned) cross the rectangle's interior? */
export function segmentHits(x1: number, y1: number, x2: number, y2: number, r: Rect): boolean {
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  return maxX > r.x && minX < r.x + r.w && maxY > r.y && minY < r.y + r.h;
}

// ---------- snapping and guides ----------

export type Guide =
  | { type: 'align'; axis: 'x' | 'y'; pos: number; from: number; to: number }
  | { type: 'gap'; axis: 'x' | 'y'; value: number; segments: { a: number; b: number; at: number }[] };

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
}

/**
 * Snap a moving box (the bounding box of the selection, already offset by dx/dy) to the edges, centres and equal gaps
 * of the other boxes. `tol` is in world units (screen pixels / zoom).
 */
export function snapMove(moving: Rect, others: readonly Rect[], tol: number): SnapResult {
  const guides: Guide[] = [];
  let bestX: { d: number; pos: number; target: number } | undefined;
  let bestY: { d: number; pos: number; target: number } | undefined;
  const mx = [moving.x, moving.x + moving.w / 2, moving.x + moving.w];
  const my = [moving.y, moving.y + moving.h / 2, moving.y + moving.h];
  const near = others.filter((o) => Math.abs(o.x - moving.x) < 6000 && Math.abs(o.y - moving.y) < 6000);
  for (const o of near) {
    const ox = [o.x, o.x + o.w / 2, o.x + o.w];
    const oy = [o.y, o.y + o.h / 2, o.y + o.h];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        if ((i === 1) !== (j === 1)) continue; // centre only to centre, edges to edges
        const dX = ox[j]! - mx[i]!;
        if (Math.abs(dX) <= tol && (!bestX || Math.abs(dX) < Math.abs(bestX.d)))
          bestX = { d: dX, pos: ox[j]!, target: 0 };
        const dY = oy[j]! - my[i]!;
        if (Math.abs(dY) <= tol && (!bestY || Math.abs(dY) < Math.abs(bestY.d)))
          bestY = { d: dY, pos: oy[j]!, target: 0 };
      }
  }
  // equal gaps between the nearest neighbours on each axis
  const gapX = equalGap(moving, near, 'x', tol);
  const gapY = equalGap(moving, near, 'y', tol);
  let dx = 0;
  let dy = 0;
  if (gapX && (!bestX || Math.abs(gapX.d) <= Math.abs(bestX.d))) {
    dx = gapX.d;
    guides.push(gapX.guide);
  } else if (bestX) dx = bestX.d;
  if (gapY && (!bestY || Math.abs(gapY.d) <= Math.abs(bestY.d))) {
    dy = gapY.d;
    guides.push(gapY.guide);
  } else if (bestY) dy = bestY.d;
  const snapped = { x: moving.x + dx, y: moving.y + dy, w: moving.w, h: moving.h };
  if (bestX && dx === bestX.d) {
    const ys = near.filter((o) => [o.x, o.x + o.w / 2, o.x + o.w].some((v) => Math.abs(v - bestX!.pos) < 0.5));
    const all = [snapped, ...ys];
    guides.push({
      type: 'align',
      axis: 'x',
      pos: bestX.pos,
      from: Math.min(...all.map((r) => r.y)),
      to: Math.max(...all.map((r) => r.y + r.h)),
    });
  }
  if (bestY && dy === bestY.d) {
    const xs = near.filter((o) => [o.y, o.y + o.h / 2, o.y + o.h].some((v) => Math.abs(v - bestY!.pos) < 0.5));
    const all = [snapped, ...xs];
    guides.push({
      type: 'align',
      axis: 'y',
      pos: bestY.pos,
      from: Math.min(...all.map((r) => r.x)),
      to: Math.max(...all.map((r) => r.x + r.w)),
    });
  }
  return { dx, dy, guides };
}

function equalGap(
  m: Rect,
  others: readonly Rect[],
  axis: 'x' | 'y',
  tol: number,
): { d: number; guide: Guide } | undefined {
  const lo = axis === 'x' ? (r: Rect) => r.x : (r: Rect) => r.y;
  const hi = axis === 'x' ? (r: Rect) => r.x + r.w : (r: Rect) => r.y + r.h;
  const crossOverlap = (r: Rect) =>
    axis === 'x' ? r.y < m.y + m.h && m.y < r.y + r.h : r.x < m.x + m.w && m.x < r.x + r.w;
  const band = others.filter(crossOverlap);
  let before: Rect | undefined;
  let after: Rect | undefined;
  for (const o of band) {
    if (hi(o) <= lo(m) + tol && (!before || hi(o) > hi(before))) before = o;
    if (lo(o) >= hi(m) - tol && (!after || lo(o) < lo(after))) after = o;
  }
  if (!before || !after) return undefined;
  const space = lo(after) - hi(before) - (hi(m) - lo(m));
  if (space <= 0) return undefined;
  const target = hi(before) + space / 2;
  const d = target - lo(m);
  if (Math.abs(d) > tol) return undefined;
  const gap = Math.round(space / 2);
  const crossAt = (r: Rect) => (axis === 'x' ? r.y + r.h / 2 : r.x + r.w / 2);
  const at = (crossAt(m) + crossAt(before) + crossAt(after)) / 3;
  const ms = lo(m) + d;
  return {
    d,
    guide: {
      type: 'gap',
      axis,
      value: gap,
      segments: [
        { a: hi(before), b: ms, at },
        { a: ms + (hi(m) - lo(m)), b: lo(after), at },
      ],
    },
  };
}

/** Sort ids by reading order (top-to-bottom rows, then left-to-right). */
export function readingOrder<T extends { rect: Rect }>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const rowA = Math.round(a.rect.y / 200);
    const rowB = Math.round(b.rect.y / 200);
    return rowA - rowB || a.rect.x - b.rect.x;
  });
}
