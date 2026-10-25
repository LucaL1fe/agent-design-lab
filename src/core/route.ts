// Orthogonal arrow routing for wireflows: straight or Z-shaped when the corridor is free, otherwise over the top in a
// stacked "band" (like hand-drawn wireflows), proposals go down, back-arrows go over the top. Deterministic.
import { segmentHits } from './geom.ts';
import type { Arrow, Id, Rect, Side } from './types.ts';

export type Pt = [number, number];

export interface Route {
  id: Id;
  points: Pt[];
  /** Label anchor: centre of the label's bottom edge. */
  label: Pt;
  /** Orientation of the segment the label sits on. */
  labelAxis: 'h' | 'v';
  fromSide: Side;
  toSide: Side;
}

export interface RouteInput {
  id: Id;
  arrow: Arrow;
  from: Rect;
  to: Rect;
  /** Vertical offset inside the source where the arrow leaves (e.g. an anchored element), page coordinates. */
  fromY?: number;
  /** Space above the source/target that belongs to it (a screen's caption and banner): arrows attached at the
   *  top end above it instead of cutting through the text. */
  fromHead?: number;
  toHead?: number;
}

export interface RouteOptions {
  /** Boxes the arrows should not cross (screens, portals), already inflated by the caption space above them. */
  obstacles: Map<Id, Rect>;
  /** Space reserved above every box for caption and banner. */
  headroom?: number;
  bandGap?: number;
  bandStep?: number;
  /** Boxes labels should not sit on (notes, texts). */
  labelAvoid?: Rect[];
}

const STUB = 26;

function sidePoint(r: Rect, side: Side, offset?: number): Pt {
  switch (side) {
    case 'left':
      return [r.x, offset ?? r.y + r.h / 2];
    case 'right':
      return [r.x + r.w, offset ?? r.y + r.h / 2];
    case 'top':
      return [offset ?? r.x + r.w / 2, r.y];
    case 'bottom':
      return [offset ?? r.x + r.w / 2, r.y + r.h];
  }
}

/** Where two facing sides attach, like Figma's connectors: the middle of each side, or one shared height (a straight
 *  line) when the sides overlap by at least 40 % of the shorter one. Works the same for x along top/bottom sides. */
function facing(a0: number, aLen: number, b0: number, bLen: number): [number, number] {
  const lo = Math.max(a0, b0);
  const hi = Math.min(a0 + aLen, b0 + bLen);
  if (hi - lo >= Math.max(24, Math.min(aLen, bLen) * 0.4)) {
    const m = Math.round((lo + hi) / 2);
    return [m, m];
  }
  return [Math.round(a0 + aLen / 2), Math.round(b0 + bLen / 2)];
}

function blocked(points: Pt[], obstacles: Map<Id, Rect>, skip: Set<Id>): boolean {
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1]!;
    const [x2, y2] = points[i]!;
    for (const [id, r] of obstacles) {
      if (skip.has(id)) continue;
      if (segmentHits(x1, y1, x2, y2, r)) return true;
    }
  }
  return false;
}

function dedupe(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 0.5 && Math.abs(last[1] - p[1]) < 0.5) continue;
    out.push(p);
  }
  // drop collinear middle points
  for (let i = out.length - 2; i > 0; i--) {
    const [a, b, c] = [out[i - 1]!, out[i]!, out[i + 1]!];
    if ((a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1])) out.splice(i, 1);
  }
  return out;
}

/** Label sits on the longest horizontal segment (or the longest vertical one when there is none). */
/** Approximate box of a label drawn at `p` (above a horizontal line, right of a vertical one). */
function labelBox(p: Pt, axis: 'h' | 'v', text = ''): Rect {
  const w = Math.min(260, Math.max(40, text.length * 7.5 + 12));
  return axis === 'v' ? { x: p[0] + 4, y: p[1] - 12, w, h: 24 } : { x: p[0] - w / 2, y: p[1] - 26, w, h: 24 };
}

/** Where the label goes: the preferred segment's middle, or the nearest free spot along the arrow when that is
 *  covered by a note, a text or another label. */
function labelPos(points: Pt[], avoid: Rect[] = [], text = 'x'.repeat(18)): { at: Pt; axis: 'h' | 'v' } {
  const first = preferredLabel(points);
  if (!avoid.length) return first;
  const box = (p: Pt, axis: 'h' | 'v'): Rect => labelBox(p, axis, text);
  const free = (p: Pt, axis: 'h' | 'v') => {
    const b = box(p, axis);
    return !avoid.some((r) => b.x < r.x + r.w && r.x < b.x + b.w && b.y < r.y + r.h && r.y < b.y + b.h);
  };
  if (free(first.at, first.axis)) return first;
  const segs: { a: Pt; b: Pt; axis: 'h' | 'v'; len: number; pref: boolean }[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const axis = Math.abs(a[1] - b[1]) < 0.5 ? 'h' : 'v';
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    segs.push({ a, b, axis, len, pref: mid[0] === first.at[0] && mid[1] === first.at[1] });
  }
  segs.sort((x, y) => Number(y.pref) - Number(x.pref) || y.len - x.len);
  for (const sg of segs) {
    if (sg.len < 40) continue;
    for (const t of [0.5, 0.62, 0.38, 0.75, 0.25, 0.88, 0.12]) {
      const p: Pt = [sg.a[0] + (sg.b[0] - sg.a[0]) * t, sg.a[1] + (sg.b[1] - sg.a[1]) * t];
      if (free(p, sg.axis)) return { at: p, axis: sg.axis };
    }
  }
  return first;
}

function preferredLabel(points: Pt[]): { at: Pt; axis: 'h' | 'v' } {
  let best: { len: number; at: Pt; axis: 'h' | 'v' } | undefined;
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1]!;
    const [x2, y2] = points[i]!;
    if (Math.abs(y1 - y2) < 0.5) {
      const len = Math.abs(x2 - x1);
      // later segments (closer to the target) win near-ties, so fanned-out labels sit next to their own targets
      if (!best || best.axis === 'v' || len >= best.len * 0.9)
        best = { len: Math.max(len, best?.axis === 'h' ? best.len : 0), at: [(x1 + x2) / 2, y1], axis: 'h' };
    } else if (!best || (best.axis === 'v' && Math.abs(y2 - y1) > best.len)) {
      best = { len: Math.abs(y2 - y1), at: [x1, (y1 + y2) / 2], axis: 'v' };
    }
  }
  return best ? { at: best.at, axis: best.axis } : { at: points[0] ?? [0, 0], axis: 'h' };
}

interface Band {
  x1: number;
  x2: number;
  level: number;
}

/** Route every arrow of a page. Arrows are processed in id order so the result never depends on map order. */
export function routeAll(inputs: RouteInput[], opts: RouteOptions): Map<Id, Route> {
  const out = new Map<Id, Route>();
  const head = opts.headroom ?? 70;
  const bandGap = opts.bandGap ?? 34;
  const bandStep = opts.bandStep ?? 22;
  const bands: Band[] = [];
  // obstacles grown upwards by the caption/banner space so straight routes never cut through a caption
  const obs = new Map<Id, Rect>(
    [...opts.obstacles].map(([k, r]) => [k, { x: r.x, y: r.y - head, w: r.w, h: r.h + head }]),
  );
  const sorted = [...inputs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const avoid: Rect[] = [...(opts.labelAvoid ?? [])];

  // arrows leaving the same right side, for staggering where they bend
  const outRight = new Map<Id, RouteInput[]>();
  for (const r of sorted) {
    if (r.arrow.from === r.arrow.to) continue;
    if (r.to.x >= r.from.x + r.from.w + 24) {
      const k = r.arrow.from;
      if (!outRight.has(k)) outRight.set(k, []);
      outRight.get(k)!.push(r);
    }
  }
  for (const list of outRight.values()) list.sort((a, b) => a.to.y - b.to.y || a.from.y - b.from.y);

  for (const input of sorted) {
    const { arrow, from: A, to: B, id } = input;
    const ha = input.fromHead ?? 0;
    const hb = input.toHead ?? 0;
    const skip = new Set<Id>([arrow.from, arrow.to]);
    /** A side's attachment point; top attachments sit above the caption and banner. */
    const at = (r: Rect, side: Side, h: number, offset?: number): Pt => {
      const p = sidePoint(r, side, offset);
      return side === 'top' ? [p[0], p[1] - h] : p;
    };
    let points: Pt[];
    let fromSide: Side;
    let toSide: Side;

    if (arrow.waypoints?.length) {
      fromSide = arrow.fromSide ?? 'right';
      toSide = arrow.toSide ?? 'left';
      const start = at(A, fromSide, ha, input.fromY);
      const end = at(B, toSide, hb);
      const pts: Pt[] = [start];
      for (const w of arrow.waypoints) {
        const last = pts[pts.length - 1]!;
        pts.push([w[0], last[1]], [w[0], w[1]]);
      }
      const last = pts[pts.length - 1]!;
      if (toSide === 'left' || toSide === 'right') pts.push([last[0], end[1]], end);
      else pts.push([end[0], last[1]], end);
      points = dedupe(pts);
    } else if (arrow.from === arrow.to) {
      // loop back into the same screen
      fromSide = 'right';
      toSide = 'top';
      const y1 = A.y + Math.min(Math.max(A.h * 0.25, 60), 220);
      const xr = A.x + A.w + 40;
      const yt = A.y - Math.max(head, ha) - 18;
      const xe = A.x + A.w * 0.72;
      points = [
        [A.x + A.w, y1],
        [xr, y1],
        [xr, yt],
        [xe, yt],
        [xe, A.y - ha],
      ];
    } else {
      // options hang under the screen they would replace: their links leave from the bottom, or go straight across
      const proposal = arrow.style === 'proposal';
      fromSide = arrow.fromSide ?? (proposal && B.y >= A.y + A.h ? 'bottom' : autoFromSide(A, B));
      toSide = arrow.toSide ?? opposite(fromSide, A, B);
      if (fromSide === 'right' && toSide === 'left') {
        const outs = outRight.get(arrow.from) ?? [];
        const [fy, y2] = facing(A.y, A.h, B.y, B.h);
        const y1 = input.fromY ?? fy;
        const x1 = A.x + A.w;
        const x2 = B.x;
        let pts: Pt[];
        if (Math.abs(y1 - y2) < 1)
          pts = [
            [x1, y1],
            [x2, y1],
          ];
        else {
          // fan-out from one screen: bend close to the source, staggered per arrow (like hand-drawn wireflows)
          const i = Math.max(0, outs.indexOf(input));
          const n = outs.length;
          const mx = n > 1 ? Math.round(Math.min(x1 + 40 + (n - 1 - i) * 22, x2 - 30)) : Math.round(x1 + (x2 - x1) / 2);
          pts = [
            [x1, y1],
            [mx, y1],
            [mx, y2],
            [x2, y2],
          ];
        }
        if (blocked(pts, obs, skip))
          pts = bandRoute(A, B, y1, y2, x1, x2, opts.obstacles, skip, bands, head, bandGap, bandStep);
        points = dedupe(pts);
      } else if (
        fromSide === 'left' &&
        toSide === 'right' &&
        (arrow.fromSide === 'left' || proposal) &&
        B.x + B.w <= A.x
      ) {
        // a side set on purpose, or an option to the left: straight across (back arrows go over the top)
        const [fy, y2] = facing(A.y, A.h, B.y, B.h);
        const y1 = input.fromY ?? fy;
        const x1 = A.x;
        const x2 = B.x + B.w;
        const mx = Math.round(x2 + (x1 - x2) / 2);
        const pts: Pt[] =
          Math.abs(y1 - y2) < 1
            ? [
                [x1, y1],
                [x2, y1],
              ]
            : [
                [x1, y1],
                [mx, y1],
                [mx, y2],
                [x2, y2],
              ];
        points = dedupe(pts);
      } else if (fromSide === 'bottom' || fromSide === 'top') {
        const [ax, bx] = fromSide === toSide ? [undefined, undefined] : facing(A.x, A.w, B.x, B.w);
        const a = at(A, fromSide, ha, ax);
        const b = at(B, toSide, hb, bx);
        if (Math.abs(a[0] - b[0]) < 1) points = [a, b];
        else {
          const my = Math.round((a[1] + b[1]) / 2);
          let pts: Pt[] = [a, [a[0], my], [b[0], my], b];
          if (blocked(pts, obs, skip)) {
            // halfway down is taken (a row of other options can fill the middle): turn at the first level between
            // the two where neither the turn nor the drops cross a screen
            const lo = Math.min(a[1], b[1]) + 16;
            const hi = Math.max(a[1], b[1]) - 16;
            for (let yy = lo; yy <= hi; yy += 8) {
              const cand: Pt[] = [a, [a[0], yy], [b[0], yy], b];
              if (!blocked(cand, obs, skip)) {
                pts = cand;
                break;
              }
            }
          }
          points = dedupe(pts);
        }
        if (fromSide === 'top' && toSide === 'top') {
          const x1 = a[0];
          const x2 = b[0];
          const top = Math.min(A.y, B.y);
          const level = takeBand(bands, Math.min(x1, x2), Math.max(x1, x2));
          const yb =
            Math.min(
              bandY(Math.min(x1, x2), Math.max(x1, x2), top, opts.obstacles, skip, head, bandGap),
              Math.min(A.y - ha, B.y - hb) - 18,
            ) -
            level * bandStep;
          points = dedupe([a, [x1, yb], [x2, yb], b]);
        }
      } else {
        // left → right (backwards): over the top
        const a = at(A, 'top', ha);
        const b = at(B, 'top', hb);
        fromSide = 'top';
        toSide = 'top';
        const lo = Math.min(a[0], b[0]);
        const hi = Math.max(a[0], b[0]);
        const level = takeBand(bands, lo, hi);
        const yb =
          Math.min(bandY(lo, hi, Math.min(A.y, B.y), opts.obstacles, skip, head, bandGap), Math.min(a[1], b[1]) - 18) -
          level * bandStep;
        points = dedupe([a, [a[0], yb], [b[0], yb], b]);
      }
    }
    const lp = labelPos(points, avoid, arrow.label || undefined);
    // later labels also keep off this one
    if (arrow.label) avoid.push(labelBox(lp.at, lp.axis, arrow.label));
    out.set(id, { id, points, label: lp.at, labelAxis: lp.axis, fromSide, toSide });
  }
  return out;
}

function opposite(s: Side, A: Rect, B: Rect): Side {
  if (s === 'right') return 'left';
  if (s === 'left') return 'right';
  if (s === 'bottom') return 'top';
  return B.y + B.h <= A.y ? 'bottom' : 'top';
}

function autoFromSide(A: Rect, B: Rect): Side {
  if (B.x >= A.x + A.w + 24) return 'right';
  if (A.x >= B.x + B.w + 24) return 'left';
  if (B.y >= A.y + A.h) return 'bottom';
  return 'top';
}

function takeBand(bands: Band[], x1: number, x2: number): number {
  let level = 0;
  while (bands.some((b) => b.level === level && b.x1 < x2 + 40 && x1 < b.x2 + 40)) level++;
  bands.push({ x1, x2, level });
  return level;
}

function bandY(
  x1: number,
  x2: number,
  top: number,
  obstacles: Map<Id, Rect>,
  skip: Set<Id>,
  head: number,
  gap: number,
): number {
  let y = top;
  for (const [id, r] of obstacles) {
    if (skip.has(id)) continue;
    if (r.x < x2 && x1 < r.x + r.w && Math.abs(r.y - top) < 1500) y = Math.min(y, r.y);
  }
  return Math.round(y - head - gap);
}

function bandRoute(
  A: Rect,
  B: Rect,
  y1: number,
  y2: number,
  x1: number,
  x2: number,
  obstacles: Map<Id, Rect>,
  skip: Set<Id>,
  bands: Band[],
  head: number,
  gap: number,
  step: number,
): Pt[] {
  const a = x1 + STUB;
  const b = x2 - STUB;
  const level = takeBand(bands, a, b);
  const yb = bandY(a, b, Math.min(A.y, B.y), obstacles, skip, head, gap) - level * step;
  return [
    [x1, y1],
    [a, y1],
    [a, yb],
    [b, yb],
    [b, y2],
    [x2, y2],
  ];
}

/** SVG path with rounded corners. */
export function pathD(points: Pt[], radius = 12): string {
  if (!points.length) return '';
  let d = `M${points[0]![0]} ${points[0]![1]}`;
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    const prev = points[i - 1]!;
    const next = points[i + 1];
    if (!next) {
      d += ` L${p[0]} ${p[1]}`;
      break;
    }
    const inLen = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    const outLen = Math.hypot(next[0] - p[0], next[1] - p[1]);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const ax = p[0] - ((p[0] - prev[0]) / (inLen || 1)) * r;
    const ay = p[1] - ((p[1] - prev[1]) / (inLen || 1)) * r;
    const bx = p[0] + ((next[0] - p[0]) / (outLen || 1)) * r;
    const by = p[1] + ((next[1] - p[1]) / (outLen || 1)) * r;
    d += ` L${round(ax)} ${round(ay)} Q${p[0]} ${p[1]} ${round(bx)} ${round(by)}`;
  }
  return d;
}

const round = (n: number) => Math.round(n * 10) / 10;

/** Triangle arrowhead at the end of the route, pointing along the last segment. */
export function headD(points: Pt[], size = 10): string {
  if (points.length < 2) return '';
  const b = points[points.length - 1]!;
  const a = points[points.length - 2]!;
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const w = size * 0.55;
  const hx = b[0] - Math.cos(ang) * size;
  const hy = b[1] - Math.sin(ang) * size;
  return `M${round(b[0])} ${round(b[1])} L${round(hx - Math.sin(ang) * w)} ${round(hy + Math.cos(ang) * w)} L${round(hx + Math.sin(ang) * w)} ${round(hy - Math.cos(ang) * w)}Z`;
}

/** Shorten the last segment so the line does not poke through the arrowhead. */
export function trimEnd(points: Pt[], by: number): Pt[] {
  if (points.length < 2) return points;
  const out = points.map((p) => [p[0], p[1]] as Pt);
  const b = out[out.length - 1]!;
  const a = out[out.length - 2]!;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len <= by) return out;
  out[out.length - 1] = [b[0] - ((b[0] - a[0]) / len) * by, b[1] - ((b[1] - a[1]) / len) * by];
  return out;
}

/** Distance from a point to a route, for hit testing. */
export function distanceToRoute(points: Pt[], x: number, y: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1]!;
    const [x2, y2] = points[i]!;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2));
    best = Math.min(best, Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)));
  }
  return best;
}
