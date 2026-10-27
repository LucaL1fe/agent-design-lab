// Pure helpers of the canvas engine (no DOM).
import { describe, expect, it } from 'vitest';
import { clampK, KEEP_VISIBLE, keepInView, stickyTitle } from '../../src/app/engine/viewport.ts';

describe('keepInView', () => {
  // a page of 35 000 × 46 000 in a 1400 × 800 window with a 64 px toolbar
  const content = { x: 0, y: 0, w: 35000, h: 46000 };
  const onScreen = (v: { x: number; y: number; k: number }) => ({
    x1: content.x * v.k + v.x,
    x2: (content.x + content.w) * v.k + v.x,
    y1: content.y * v.k + v.y,
    y2: (content.y + content.h) * v.k + v.y,
  });
  it('leaves a view that shows the content alone', () => {
    const v = { x: 200, y: 100, k: 0.02 };
    expect(keepInView(v, content, 1400, 800, 64)).toBe(v);
  });
  it('a fling at a far zoom stops with some of the content still on screen', () => {
    // regression from a real canvas: x -4775 at 2 % put the whole page left of the window, saved and restored on
    // every visit, so the canvas opened empty
    for (const v of [
      { x: -4775, y: -205, k: 0.02 },
      { x: 90000, y: 0, k: 0.02 },
      { x: 0, y: -99999, k: 0.5 },
      { x: 0, y: 5000, k: 1 },
    ]) {
      const r = onScreen(keepInView(v, content, 1400, 800, 64));
      expect(Math.min(r.x2, 1400) - Math.max(r.x1, 0)).toBeGreaterThanOrEqual(KEEP_VISIBLE - 0.001);
      expect(Math.min(r.y2, 800) - Math.max(r.y1, 64)).toBeGreaterThanOrEqual(KEEP_VISIBLE - 0.001);
    }
  });
  it('content smaller than the margin stays fully on screen; no content, no limit', () => {
    const tiny = { x: 1000, y: 1000, w: 390, h: 844 };
    const v = keepInView({ x: -9000, y: -9000, k: 0.1 }, tiny, 1400, 800, 64);
    expect(tiny.x * v.k + v.x).toBeGreaterThanOrEqual(0);
    expect(tiny.y * v.k + v.y).toBeGreaterThanOrEqual(64);
    const free = { x: -9000, y: -9000, k: 0.1 };
    expect(keepInView(free, undefined, 1400, 800, 64)).toBe(free);
  });
  it('the farthest zoom fits a page of a few hundred screens', () => {
    expect(clampK((800 - 64 - 80) / 46000)).toBeCloseTo((800 - 64 - 80) / 46000);
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
