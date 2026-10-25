// Pure helpers of the canvas engine (no DOM).
import { describe, expect, it } from 'vitest';
import { stickyTitle } from '../../src/app/engine/viewport.ts';

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
