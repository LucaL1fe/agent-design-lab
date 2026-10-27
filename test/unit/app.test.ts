// Pure helpers of the canvas engine (no DOM).
import { describe, expect, it } from 'vitest';
import { clampK, KEEP_VISIBLE, keepInView, stickyTitle } from '../../src/app/engine/viewport.ts';

describe('keepInView', () => {
  // a page shaped like an L in a 1400 × 800 window with a 64 px toolbar: a wide band of sections on top, a tall
  // column on the left; the bottom right of its bounding box (35 000 × 46 000) is empty
  const top = { x: 0, y: 2000, w: 35000, h: 4000 };
  const left = { x: 0, y: 6000, w: 9000, h: 40000 };
  const page = [top, left];
  const W = 1400;
  const H = 800;
  const T = 64;
  const shown = (v: { x: number; y: number; k: number }, r: { x: number; y: number; w: number; h: number }) => {
    const w = Math.min(r.x * v.k + v.x + r.w * v.k, W) - Math.max(r.x * v.k + v.x, 0);
    const h = Math.min(r.y * v.k + v.y + r.h * v.k, H) - Math.max(r.y * v.k + v.y, T);
    return w > 0 && h > 0 ? Math.min(w, h) : 0;
  };
  it('leaves a view that shows an item alone', () => {
    const v = { x: 200, y: 100, k: 0.02 };
    expect(keepInView(v, page, W, H, T)).toBe(v);
    // empty space between items is fine while something is on screen
    const between = { x: -300, y: -900, k: 0.5 };
    expect(shown(between, top)).toBeGreaterThan(0);
    expect(keepInView(between, page, W, H, T)).toBe(between);
  });
  it('a fling at a far zoom stops with an item still on screen, also into the empty corner of an L', () => {
    // regression from a real canvas: x -4775 at 2 % put the whole page left of the window, saved and restored on
    // every visit, so the canvas opened empty; a first fix kept 120 px of the bounding box, which on that page was
    // its empty corner
    for (const v of [
      { x: -4775, y: -205, k: 0.02 },
      { x: -579, y: -205, k: 0.02 },
      { x: 90000, y: 0, k: 0.02 },
      { x: 0, y: -99999, k: 0.5 },
      { x: 0, y: 5000, k: 1 },
      { x: -12000, y: -12000, k: 1 },
    ]) {
      const kept = keepInView(v, page, W, H, T);
      // all of an item that is smaller than the margin on screen, else the margin
      const need = (r: typeof top) => Math.min(KEEP_VISIBLE, r.w * v.k, r.h * v.k);
      expect(page.some((r) => shown(kept, r) >= need(r) - 0.001)).toBe(true);
    }
  });
  it('moves as little as it can: to the nearest item', () => {
    const v = keepInView({ x: -12000, y: -12000, k: 1 }, page, W, H, T);
    expect(shown(v, left)).toBeGreaterThan(0);
  });
  it('an item smaller than the margin stays fully on screen; no items, no limit', () => {
    const tiny = { x: 1000, y: 1000, w: 390, h: 844 };
    const v = keepInView({ x: -9000, y: -9000, k: 0.1 }, [tiny], W, H, T);
    expect(tiny.x * v.k + v.x).toBeGreaterThanOrEqual(0);
    expect(tiny.y * v.k + v.y).toBeGreaterThanOrEqual(T);
    const free = { x: -9000, y: -9000, k: 0.1 };
    expect(keepInView(free, [], W, H, T)).toBe(free);
    expect(keepInView(free, undefined, W, H, T)).toBe(free);
  });
  it('the farthest zoom fits a page of a few hundred screens', () => {
    expect(clampK((H - T - 80) / 46000)).toBeCloseTo((H - T - 80) / 46000);
  });
});

describe('stickyTitle', () => {
  it('sits on the section when it is fully on screen', () => {
    expect(stickyTitle(200, 500)).toEqual({ left: 200, room: 500 });
  });
  it('sticks to the left edge while the section runs off-screen', () => {
    expect(stickyTitle(-300, 1000)).toEqual({ left: 8, room: 692 });
  });
  it('never gets more room than the visible part of its own section', () => {
    // regression: a sticky title kept the full section width and ran over the next section's title
    const { left, room } = stickyTitle(-400, 520);
    expect(left + room).toBe(120);
    expect(room).toBeLessThanOrEqual(120);
  });
});

describe('search', async () => {
  const { normMap, searchProject } = await import('../../src/app/state/search.ts');
  const { newPageDoc, newProjectDoc } = await import('../../src/core/actions.ts');
  it('maps normalized positions back to the original text (emoji variation selectors, accents)', () => {
    const s = 'Night Mode 📱️ Add or remove songs Café';
    const { n, map } = normMap(s);
    const at = n.indexOf('songs');
    expect(s.slice(map[at]!, map[at + 5]!)).toBe('songs');
    const c = n.indexOf('cafe');
    expect(s.slice(map[c]!, map[c + 4]!)).toBe('Café');
  });
  it('finds ids, captions, banners, words inside screens, notes and arrow labels; exact ids first', () => {
    const project = newProjectDoc('P');
    const page = newPageDoc('Truth');
    page.items = {
      S4: { kind: 'screen', title: 'Not enough songs' },
      T3: { kind: 'screen', banner: 'too many songs?' },
      B2: { kind: 'screen' },
      n1: { kind: 'note', text: 'Show the songs bigger', anchor: 'S4' },
      songs: { kind: 'screen' },
    };
    page.arrows = { 'S4>T3': { from: 'S4', to: 'T3', label: 'save songs' } };
    const hits = searchProject(
      { docs: { project, pages: { truth: page } }, screens: {} } as never,
      { B2: 'Sleep mode plays 30 songs' },
      'Songs',
    );
    expect(hits[0]!.id).toBe('songs');
    expect(hits.map((h: { kind: string; id: string }) => `${h.kind}:${h.id}`)).toEqual([
      'screen:songs',
      'screen:S4',
      'screen:T3',
      'screen:B2',
      'note:n1',
      'arrow:S4',
    ]);
    expect(hits.find((h: { id: string }) => h.id === 'B2')!.snippet![1]).toBe('songs');
  });
});
