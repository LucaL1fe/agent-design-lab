import type { Id, Rect } from '../../core/types.ts';

/** Uniform grid index: cheap inserts and viewport queries for thousands of boxes. */
export class GridIndex {
  private cells = new Map<string, Set<Id>>();
  private rects = new Map<Id, Rect>();
  private readonly size: number;
  constructor(size = 1024) {
    this.size = size;
  }
  clear() {
    this.cells.clear();
    this.rects.clear();
  }
  private keys(r: Rect): string[] {
    const s = this.size;
    const x1 = Math.floor(r.x / s);
    const y1 = Math.floor(r.y / s);
    const x2 = Math.floor((r.x + r.w) / s);
    const y2 = Math.floor((r.y + r.h) / s);
    const out: string[] = [];
    for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) out.push(`${x},${y}`);
    return out;
  }
  set(id: Id, r: Rect) {
    this.remove(id);
    this.rects.set(id, r);
    for (const k of this.keys(r)) {
      let c = this.cells.get(k);
      if (!c) {
        c = new Set();
        this.cells.set(k, c);
      }
      c.add(id);
    }
  }
  remove(id: Id) {
    const r = this.rects.get(id);
    if (!r) return;
    for (const k of this.keys(r)) this.cells.get(k)?.delete(id);
    this.rects.delete(id);
  }
  query(r: Rect): Id[] {
    const out = new Set<Id>();
    for (const k of this.keys(r)) {
      const c = this.cells.get(k);
      if (!c) continue;
      for (const id of c) {
        const b = this.rects.get(id)!;
        if (b.x < r.x + r.w && r.x < b.x + b.w && b.y < r.y + r.h && r.y < b.y + b.h) out.add(id);
      }
    }
    return [...out];
  }
  /** Items whose box contains the point, topmost (last inserted) first. */
  at(x: number, y: number): Id[] {
    const k = `${Math.floor(x / this.size)},${Math.floor(y / this.size)}`;
    const c = this.cells.get(k);
    if (!c) return [];
    return [...c].filter((id) => {
      const b = this.rects.get(id)!;
      return x >= b.x && y >= b.y && x <= b.x + b.w && y <= b.y + b.h;
    });
  }
  get(id: Id) {
    return this.rects.get(id);
  }
}
