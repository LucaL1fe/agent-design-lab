import { describe, expect, it } from 'vitest';
import {
  addArrow,
  addStatus,
  applyOps,
  approve,
  countStatuses,
  countsText,
  type Docs,
  HISTORY_PAGE,
  invertOps,
  jsonEqual,
  merge3,
  mergePage,
  moveItems,
  newPageDoc,
  newProjectDoc,
  type PageDoc,
  parseJson,
  pickProposal,
  placePage,
  portalsTo,
  rejectProposal,
  removalHeirs,
  removeItems,
  resolveFrame,
  restoreFromHistory,
  routeAll,
  SECTION_GAP,
  safeInverse,
  setStatus,
  stringifyPage,
  stringifyProject,
  validateRefs,
} from '../../src/core/index.ts';

const phone = { w: 390, h: 844 };
const sizeOf = () => phone;

function demo(): Docs {
  const project = newProjectDoc('Demo');
  const page: PageDoc = newPageDoc('Source of truth');
  page.items = {
    library: { kind: 'section', title: 'FLOW · Library', x: 0, y: 0, w: 1800, h: 1200 },
    S1: { kind: 'screen', parent: 'library', x: 64, y: 150, status: 'approved' },
    S4: { kind: 'screen', parent: 'library', x: 734, y: 150, status: 'approved' },
    S6: { kind: 'screen', parent: 'library', x: 1404, y: 150, status: 'to-decide', banner: 'too harsh?' },
    S6a: { kind: 'screen', parent: 'library', status: 'new', banner: 'option A', proposalFor: 'S6' },
    S6b: { kind: 'screen', parent: 'library', status: 'new', banner: 'option B', proposalFor: 'S6' },
  };
  page.arrows = {
    'S1>S4': { from: 'S1', to: 'S4', label: 'taps 80' },
    'S4>S6': { from: 'S4', to: 'S6', label: 'says no' },
    'S6>S6a': { from: 'S6', to: 'S6a', label: 'option A', style: 'proposal' },
    'S6>S6b': { from: 'S6', to: 'S6b', label: 'option B', style: 'proposal' },
  };
  return { project, pages: { truth: page } };
}

describe('canonical json', () => {
  it('is stable, ordered and one item per line', () => {
    const d = demo();
    const a = stringifyPage(d.pages.truth as never);
    const b = stringifyPage(JSON.parse(a));
    expect(a).toBe(b);
    expect(a).toContain('\n    "S1": {"kind": "screen", "parent": "library", "x": 64, "y": 150, "status": "approved"}');
    expect(a.indexOf('"items"')).toBeGreaterThan(a.indexOf('"name"'));
    const p = stringifyProject(d.project as never);
    expect(stringifyProject(JSON.parse(p))).toBe(p);
  });
  it('rounds geometry', () => {
    const page = newPageDoc('x');
    page.items.a = { kind: 'screen', x: 10.6, y: -3.2 };
    expect(stringifyPage(page as never)).toContain('"x": 11, "y": -3');
  });
  it('reports where a broken file breaks', () => {
    const r = parseJson('{\n  "adl": 1,\n  "rev": ,\n}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.line).toBe(3);
  });
});

describe('ops', () => {
  it('apply then invert gives the original', () => {
    const d = demo();
    const ops = approve(d, 'truth', ['S6']);
    const r = applyOps(d, ops);
    expect((r.docs.pages.truth!.items.S6 as { status?: string }).status).toBe('approved');
    expect((r.docs.pages.truth!.items.S6 as { banner?: string }).banner).toBeUndefined();
    const back = applyOps(r.docs, invertOps(r.ops));
    expect(jsonEqual(back.docs, d)).toBe(true);
  });
  it('safe undo skips fields someone else changed since', () => {
    const d = demo();
    const mine = applyOps(d, setStatus(d, 'truth', ['S6'], 'needs-fix', 'fix the colour'));
    const theirs = applyOps(mine.docs, setStatus(mine.docs, 'truth', ['S6'], 'to-decide'));
    const inv = safeInverse(theirs.docs, mine.ops);
    expect(inv.skipped.map((o) => o.path.join('.'))).toEqual(['items.S6.status']);
    const after = applyOps(theirs.docs, inv.ops).docs.pages.truth!.items.S6 as { status?: string; banner?: string };
    expect(after.status).toBe('to-decide');
    expect(after.banner).toBe('too harsh?');
  });
});

describe('merge', () => {
  it('keeps both sides when they changed different things', () => {
    const base = demo().pages.truth!;
    const ours = applyOps(demo(), moveItems(demo(), 'truth', [{ id: 'S1', x: 100, y: 200 }], 'human')).docs.pages
      .truth!;
    const theirs = applyOps(demo(), setStatus(demo(), 'truth', ['S4'], 'needs-fix', 'wrong font')).docs.pages.truth!;
    const m = mergePage(base, ours, theirs);
    const v = m.value as PageDoc;
    expect(v.items.S1).toMatchObject({ x: 100, y: 200, pinned: true });
    expect(v.items.S4).toMatchObject({ status: 'needs-fix', banner: 'wrong font' });
    expect(m.conflicts).toEqual([]);
  });
  it('a stale agent write never undoes a human drag', () => {
    const base = demo().pages.truth!;
    const ours = applyOps(demo(), moveItems(demo(), 'truth', [{ id: 'S1', x: 100, y: 200 }], 'human')).docs.pages
      .truth!;
    const theirs = structuredClone(base);
    (theirs.items.S1 as { x: number }).x = 999; // agent also moved it
    const v = mergePage(base, ours, theirs).value as PageDoc;
    expect(v.items.S1).toMatchObject({ x: 100, y: 200 });
  });
  it('agent wins other conflicts', () => {
    const r = merge3({ a: 1 }, { a: 2 }, { a: 3 });
    expect(r.value).toEqual({ a: 3 });
    expect(r.conflicts).toHaveLength(1);
  });
});

describe('layout', () => {
  it('places proposals in a row under the screen they would replace', () => {
    const d = demo();
    const pl = placePage(d.pages.truth!, sizeOf);
    const s6 = pl.rects.get('S6')!;
    const a = pl.rects.get('S6a')!;
    const b = pl.rects.get('S6b')!;
    expect(a.x).toBe(s6.x);
    expect(a.y).toBeGreaterThan(s6.y + s6.h);
    // a row, so the dashed arrows from S6 never cross another option's box
    expect(b.y).toBe(a.y);
    expect(b.x).toBeGreaterThan(a.x + a.w);
  });
  it('places a screen right of the screen that leads to it', () => {
    const page = newPageDoc('p');
    page.items = { A: { kind: 'screen', x: 0, y: 0 }, B: { kind: 'screen' } };
    page.arrows = { 'A>B': { from: 'A', to: 'B', label: 'next' } };
    const r = placePage(page, sizeOf).rects.get('B')!;
    expect(r.x).toBe(390 + 280);
    expect(r.y).toBe(0);
  });
  it('a screen that has to move down goes straight under what is in the way (and its notes), not in steps of its height', () => {
    // regression from a real section: the start led to screens of different heights, each stepped down by its
    // own height + gap from the start's top, which left holes of up to ~1100 px between two screens
    const page = newPageDoc('p');
    page.items = {
      S: { kind: 'screen', x: 0, y: 0 },
      A: { kind: 'screen' },
      B: { kind: 'screen' },
      C: { kind: 'screen' },
      n: { kind: 'note', text: 'about B', anchor: 'B' },
    };
    page.arrows = {
      'S>A': { from: 'S', to: 'A', label: 'a' },
      'S>B': { from: 'S', to: 'B', label: 'b' },
      'S>C': { from: 'S', to: 'C', label: 'c' },
    };
    const tall = { w: 390, h: 1306 };
    const pl = placePage(page, (id) => (id === 'B' ? tall : phone));
    const [a, b, c, n] = ['A', 'B', 'C', 'n'].map((id) => pl.rects.get(id)!);
    expect(a).toMatchObject({ x: 670, y: 0 });
    expect(b).toMatchObject({ x: 670, y: 844 + 180 }); // under A, not 1306 + 180 down
    expect(n.y).toBeGreaterThan(b.y + b.h);
    expect(c).toMatchObject({ x: 670, y: n.y + n.h + 180 }); // under B's note
  });
  it('one screen placed further down does not move the start of the flow', () => {
    // regression from a real section: after one screen was moved next to another, the start (nothing leads
    // there) was put to the right of the moved screen and every other screen followed it down
    const page = newPageDoc('p');
    page.items = {
      sec: { kind: 'section', title: 'S', x: 0, y: 0 },
      A: { kind: 'screen', parent: 'sec' },
      B: { kind: 'screen', parent: 'sec' },
      Z: { kind: 'screen', parent: 'sec', x: 2000, y: 4000 },
    };
    page.arrows = { 'A>B': { from: 'A', to: 'B', label: 'next' }, 'A>Z': { from: 'A', to: 'Z', label: 'z' } };
    const pl = placePage(page, sizeOf);
    expect(pl.rects.get('A')).toMatchObject({ x: 64, y: 150 });
    expect(pl.rects.get('B')).toMatchObject({ x: 64 + 390 + 280, y: 150 });
    expect(pl.rects.get('Z')).toMatchObject({ x: 2000, y: 4000 });
  });
  it('sections inside a section sit side by side inside its padding, not in one tall column at its edge', () => {
    // regression from a real canvas: five groups inside one section stacked into one 18 000 px column at x 0
    const page = newPageDoc('p');
    page.items = {
      area: { kind: 'section', title: 'Area', x: 0, y: 0 },
      g1: { kind: 'section', title: 'Group 1', parent: 'area' },
      g2: { kind: 'section', title: 'Group 2', parent: 'area' },
      A: { kind: 'screen', parent: 'g1' },
      B: { kind: 'screen', parent: 'g2' },
      C: { kind: 'screen', parent: 'g2' },
    };
    page.arrows = { 'B>C': { from: 'B', to: 'C', label: 'next' } };
    const pl = placePage(page, sizeOf);
    const [f, g1, g2] = ['area', 'g1', 'g2'].map((id) => pl.rects.get(id)!);
    expect(g1).toMatchObject({ x: f!.x + 64, y: f!.y + 150 });
    expect(g2!.y).toBe(g1!.y);
    expect(g2!.x).toBeGreaterThan(g1!.x + g1!.w);
    expect(f!.x + f!.w).toBeGreaterThanOrEqual(g2!.x + g2!.w); // the parent still wraps both
  });
  it('wraps sections around their children when they have no size', () => {
    const page = newPageDoc('p');
    page.items = {
      s: { kind: 'section', title: 'S', x: 100, y: 100 },
      A: { kind: 'screen', parent: 's', x: 64, y: 150 },
    };
    const pl = placePage(page, sizeOf);
    expect(pl.rects.get('s')).toMatchObject({ x: 100, y: 100, w: 64 + 390 + 64, h: 150 + 844 + 64 });
    expect(pl.rects.get('A')).toMatchObject({ x: 164, y: 250 });
  });
  it('notes hanging off one screen stack under each other instead of landing on the same spot', () => {
    const page = newPageDoc('p');
    page.items = {
      A: { kind: 'screen', x: 0, y: 0 },
      n1: { kind: 'note', text: 'from A1: tap', size: 'small', anchor: 'A', x: 0, y: 858 },
      n2: { kind: 'note', text: 'a longer second note', anchor: 'A' },
      n3: { kind: 'note', text: 'a third one', anchor: 'A' },
    };
    const pl = placePage(page, sizeOf);
    const [r1, r2, r3] = ['n1', 'n2', 'n3'].map((id) => pl.rects.get(id)!);
    expect(r1!.y).toBe(858); // put there by hand: stays
    expect(r2!.y).toBeGreaterThanOrEqual(r1!.y + r1!.h);
    expect(r3!.y).toBeGreaterThanOrEqual(r2!.y + r2!.h);
  });
  it('options go in one row under the screen and below its notes, and a neighbour row never splits it', () => {
    const page = newPageDoc('p');
    page.items = {
      A: { kind: 'screen', x: 0, y: 0 },
      B: { kind: 'screen', x: 670, y: 0 },
      n: { kind: 'note', text: 'a rule about A', anchor: 'A' },
      A1: { kind: 'screen', proposalFor: 'A' },
      A2: { kind: 'screen', proposalFor: 'A' },
      A3: { kind: 'screen', proposalFor: 'A' },
      B1: { kind: 'screen', proposalFor: 'B' },
      B2: { kind: 'screen', proposalFor: 'B' },
    };
    const pl = placePage(page, sizeOf);
    const r = (id: string) => pl.rects.get(id)!;
    // A's row: below A's note, one row, left to right
    expect(r('A1').y).toBeGreaterThan(r('n').y + r('n').h);
    expect([r('A2').y, r('A3').y]).toEqual([r('A1').y, r('A1').y]);
    expect(r('A2').x).toBeGreaterThan(r('A1').x + r('A1').w);
    // B's row (its screen sits above A's row): one row too, below A's row instead of interleaving with it
    expect(r('B2').y).toBe(r('B1').y);
    expect(r('B1').y).toBeGreaterThanOrEqual(r('A1').y + r('A1').h);
    expect(r('B2').x).toBeGreaterThan(r('B1').x + r('B1').w);
  });
  it('a screen without arrows keeps its place among the flows when a section is laid out again', () => {
    const page = newPageDoc('p');
    page.items = {
      s: { kind: 'section', title: 'S', x: 0, y: 0 },
      B1a: { kind: 'screen', parent: 's' },
      B2: { kind: 'screen', parent: 's' },
      B2a: { kind: 'screen', parent: 's', proposalFor: 'B2' },
      B3: { kind: 'screen', parent: 's' },
      B4: { kind: 'screen', parent: 's' },
    };
    page.arrows = { 'B2>B2a': { from: 'B2', to: 'B2a', label: 'proposed version', style: 'proposal' } };
    const pl = placePage(page, sizeOf);
    const xs = ['B1a', 'B2', 'B3', 'B4'].map((id) => pl.rects.get(id)!.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(pl.rects.get('B2a')!.x).toBe(pl.rects.get('B2')!.x);
  });
  it('a section that grows pushes the sections beside and below it, keeping their gaps', () => {
    const page = newPageDoc('p');
    page.items = {
      a: { kind: 'section', title: 'A', x: 0, y: 0, w: 600, h: 1000 },
      A1: { kind: 'screen', parent: 'a', x: 64, y: 100 },
      A2: { kind: 'screen', parent: 'a', x: 600, y: 100 }, // past the stored width: a grows to 600 + 390 + 64
      b: { kind: 'section', title: 'B', x: 800, y: 0, w: 600, h: 1000 },
      c: { kind: 'section', title: 'C', x: 1600, y: 0, w: 600, h: 1000 },
      d: { kind: 'section', title: 'D', x: 0, y: 1300, w: 600, h: 600 },
    };
    const pl = placePage(page, sizeOf);
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => pl.rects.get(id)!);
    expect(a!.w).toBe(1054);
    expect(b!.x).toBe(a!.x + a!.w + 200); // the gap of 200 stays
    expect(c!.x).toBe(b!.x + b!.w + 200); // pushed along
    expect(d!.y).toBe(1300); // a did not grow downwards: d stays
    expect(page.items.b!.x).toBe(800); // the file keeps what the person placed
  });
  it('a section sized by what it holds (no stored size) pushes its neighbours too', () => {
    // a flow laid out in one row: the section has no w/h and grows to the right past the section that was beside it
    const page = newPageDoc('p');
    page.items = {
      a: { kind: 'section', title: 'A', x: 0, y: 0 },
      A1: { kind: 'screen', parent: 'a' },
      A2: { kind: 'screen', parent: 'a' },
      A3: { kind: 'screen', parent: 'a' },
      A4: { kind: 'screen', parent: 'a' },
      b: { kind: 'section', title: 'B', x: 900, y: 0, w: 600, h: 1000 },
      c: { kind: 'section', title: 'C', x: 1700, y: 0, w: 600, h: 1000 },
      d: { kind: 'section', title: 'D', x: 0, y: 3000, w: 600, h: 600 },
    };
    page.arrows = {
      'A1>A2': { from: 'A1', to: 'A2' },
      'A2>A3': { from: 'A2', to: 'A3' },
      'A3>A4': { from: 'A3', to: 'A4' },
    };
    const pl = placePage(page, sizeOf);
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => pl.rects.get(id)!);
    expect(a!.w).toBeGreaterThan(900);
    expect(b!.x).toBe(a!.x + a!.w + SECTION_GAP); // beside it on the same band: pushed right
    expect(c!.x).toBe(b!.x + b!.w + 200); // and the one after keeps its gap
    expect(d!.y).toBe(3000); // below, but a did not reach it
    expect(page.items.b!.x).toBe(900);
  });
  it('a stored section size is a minimum: options placed under a screen and its chips stay inside', () => {
    const page = newPageDoc('p');
    page.items = {
      s: { kind: 'section', title: 'S', x: 0, y: 0, w: 1200, h: 1000 },
      A: { kind: 'screen', parent: 's', x: 64, y: 100 },
      Aa: { kind: 'screen', parent: 's', proposalFor: 'A' },
      n: { kind: 'note', text: 'from A1', anchor: 'Aa' },
    };
    page.arrows = { 'A>Aa': { from: 'A', to: 'Aa', label: 'option A', style: 'proposal' } };
    const pl = placePage(page, sizeOf);
    const sec = pl.rects.get('s')!;
    for (const id of ['A', 'Aa', 'n']) {
      const r = pl.rects.get(id)!;
      expect(r.x + r.w).toBeLessThanOrEqual(sec.x + sec.w);
      expect(r.y + r.h).toBeLessThanOrEqual(sec.y + sec.h);
    }
    expect(sec.w).toBe(1200); // wide enough already: unchanged
  });
});

describe('routing', () => {
  const route = (page: PageDoc) => {
    const pl = placePage(page, sizeOf);
    const obstacles = new Map([...pl.rects].filter(([id]) => page.items[id]!.kind === 'screen'));
    return routeAll(
      Object.entries(page.arrows).map(([id, arrow]) => ({
        id,
        arrow,
        from: pl.rects.get(arrow.from)!,
        to: pl.rects.get(arrow.to)!,
      })),
      { obstacles },
    );
  };
  it('draws a straight line between screens in a row', () => {
    const page = newPageDoc('p');
    page.items = { A: { kind: 'screen', x: 0, y: 0 }, B: { kind: 'screen', x: 670, y: 0 } };
    page.arrows = { 'A>B': { from: 'A', to: 'B', label: 'go' } };
    const r = route(page).get('A>B')!;
    expect(r.points).toHaveLength(2);
    expect(r.points[0]![1]).toBe(r.points[1]![1]);
  });
  it('goes over the top when another screen is in the way', () => {
    const page = newPageDoc('p');
    page.items = {
      A: { kind: 'screen', x: 0, y: 0 },
      M: { kind: 'screen', x: 670, y: 0 },
      B: { kind: 'screen', x: 1340, y: 0 },
    };
    page.arrows = { 'A>B': { from: 'A', to: 'B', label: 'skip' } };
    const r = route(page).get('A>B')!;
    const top = Math.min(...r.points.map((p) => p[1]));
    expect(top).toBeLessThan(-70);
    expect(r.labelAxis).toBe('h');
  });
  it('attaches at the middle of a side, like Figma: a straight line through the middle of screens in a row', () => {
    const page = newPageDoc('p');
    page.items = { A: { kind: 'screen', x: 0, y: 0 }, B: { kind: 'screen', x: 670, y: 0 } };
    page.arrows = { 'A>B': { from: 'A', to: 'B' } };
    const r = route(page).get('A>B')!;
    expect(r.points).toEqual([
      [390, 422],
      [670, 422],
    ]);
  });
  it('screens that only partly face each other still get a straight line; far apart ones bend middle to middle', () => {
    const A = { x: 0, y: 0, w: 390, h: 844 };
    const r = (b: typeof A) =>
      routeAll([{ id: 'A>B', arrow: { from: 'A', to: 'B' }, from: A, to: b }], { obstacles: new Map() }).get('A>B')!;
    // a portal next to the top of a phone: straight, at the portal's middle
    expect(r({ x: 600, y: 0, w: 300, h: 92 }).points).toEqual([
      [390, 46],
      [600, 46],
    ]);
    // a phone 100 px lower: straight through the middle of the shared span
    expect(r({ x: 600, y: 100, w: 390, h: 844 }).points).toEqual([
      [390, 472],
      [600, 472],
    ]);
    // a phone almost a whole screen lower: from A's middle to B's middle
    const far = r({ x: 600, y: 800, w: 390, h: 844 }).points;
    expect(far[0]).toEqual([390, 422]);
    expect(far[far.length - 1]).toEqual([600, 1222]);
  });
  it('arrows leaving the same side start at the same point and split', () => {
    const A = { x: 0, y: 0, w: 390, h: 844 };
    const inputs = [
      { id: 'A>B', arrow: { from: 'A', to: 'B' }, from: A, to: { x: 670, y: 0, w: 390, h: 844 } },
      { id: 'A>C', arrow: { from: 'A', to: 'C' }, from: A, to: { x: 670, y: 1100, w: 390, h: 844 } },
    ];
    const routes = routeAll(inputs, { obstacles: new Map() });
    expect(routes.get('A>B')!.points[0]).toEqual([390, 422]);
    expect(routes.get('A>C')!.points[0]).toEqual([390, 422]);
  });
  it('is deterministic', () => {
    const d = demo();
    expect(JSON.stringify([...route(d.pages.truth!)])).toBe(JSON.stringify([...route(d.pages.truth!)]));
  });
});

describe('proposals and history', () => {
  it('"Use instead of S6" swaps the proposal in and archives the rest', () => {
    const d = demo();
    const r = pickProposal(d, 'truth', 'S6a', 'human');
    const after = applyOps(d, r.ops).docs;
    const t = after.pages.truth!;
    expect(t.items.S6).toBeUndefined();
    expect(t.items.S6b).toBeUndefined();
    expect(t.items.S6a).toMatchObject({ x: 1404, y: 150, parent: 'library', status: 'new' });
    expect(t.items.S6a).not.toHaveProperty('proposalFor');
    expect(t.arrows['S4>S6a']).toMatchObject({ from: 'S4', to: 'S6a', label: 'says no' });
    expect(Object.keys(t.arrows).sort()).toEqual(['S1>S4', 'S4>S6a']);
    const h = after.pages[HISTORY_PAGE]!;
    expect(h.kind).toBe('history');
    expect(h.items.S6?.archived).toMatchObject({ reason: 'replaced', replacedBy: 'S6a', from: 'truth' });
    expect(h.items.S6b?.archived?.reason).toBe('not picked');
    expect(after.project.pages).toContain(HISTORY_PAGE);
    // undo restores everything exactly
    const back = applyOps(after, invertOps(r.ops)).docs;
    expect(jsonEqual(back, d)).toBe(true);
  });
  it('a pick does not repeat an arrow the option already has: its own arrow wins, an undo brings the other back', () => {
    // regression from a real canvas: a screen led to the original and to its option with two different labels; the
    // pick moved the original's arrow onto the option, so two arrows ran between the same two screens
    const d = demo();
    d.pages.truth!.arrows['S4>S6a'] = { from: 'S4', to: 'S6a', label: 'says no, kindly' };
    const r = pickProposal(d, 'truth', 'S6a', 'human');
    const after = applyOps(d, r.ops).docs;
    const between = Object.values(after.pages.truth!.arrows).filter((a) => a.from === 'S4' && a.to === 'S6a');
    expect(between).toEqual([{ from: 'S4', to: 'S6a', label: 'says no, kindly' }]);
    expect(after.pages[HISTORY_PAGE]!.items.S6?.archived?.handover?.merged).toEqual([
      { id: 'S4>S6', arrow: { from: 'S4', to: 'S6a', label: 'says no' } },
    ]);
    // restoring the original undoes the pick: both arrows are where they were before
    const t = applyOps(after, restoreFromHistory(after, 'S6').ops).docs.pages.truth!;
    expect(t.arrows['S4>S6']).toMatchObject({ from: 'S4', to: 'S6', label: 'says no' });
    expect(Object.values(t.arrows).filter((a) => a.from === 'S4' && a.to === 'S6a')).toEqual([
      { from: 'S4', to: 'S6a', label: 'says no, kindly' },
    ]);
    expect(jsonEqual(applyOps(after, invertOps(r.ops)).docs, d)).toBe(true);
  });
  it('picking an option of an option puts it in the place of that option in the chain, then it can replace the original', () => {
    const d = demo();
    d.pages.truth!.items.S6c = { kind: 'screen', parent: 'library', status: 'new', proposalFor: 'S6a' };
    d.pages.truth!.items.S6d = { kind: 'screen', parent: 'library', status: 'new', proposalFor: 'S6a' };
    d.pages.truth!.arrows['S6a>S6c'] = { from: 'S6a', to: 'S6c', label: 'wider', style: 'proposal' };
    d.pages.truth!.arrows['S6a>S6d'] = { from: 'S6a', to: 'S6d', label: 'widest', style: 'proposal' };
    const once = applyOps(d, pickProposal(d, 'truth', 'S6c', 'human').ops).docs;
    const t = once.pages.truth!;
    expect(t.items.S6a).toBeUndefined();
    expect(t.items.S6d).toBeUndefined();
    expect(t.items.S6c).toMatchObject({ proposalFor: 'S6' });
    expect(t.arrows['S6>S6c']).toMatchObject({ style: 'proposal' });
    once.pages.truth!.items.n6 = { kind: 'note', text: 'Library, after a skip', anchor: 'S6' };
    // portals that stand for the replaced screen, on its page and on another page
    once.pages.truth!.items.pp = { kind: 'portal', text: 'Library', target: 'S6' };
    const other = newPageDoc('Other');
    other.items = { po: { kind: 'portal', text: 'Library', target: 'page:truth/S6' } };
    once.pages.other = other;
    const after2 = applyOps(once, pickProposal(once, 'truth', 'S6c', 'human').ops).docs;
    const twice = after2.pages.truth!;
    expect(twice.items.n6).toMatchObject({ anchor: 'S6c' }); // the note on the replaced screen moves to the pick
    expect(twice.items.pp).toMatchObject({ target: 'S6c' }); // and portals still arrive
    expect(after2.pages.other!.items.po).toMatchObject({ target: 'page:truth/S6c' });
    expect(twice.items.S6).toBeUndefined();
    expect(twice.items.S6c).not.toHaveProperty('proposalFor');
    expect(twice.arrows['S4>S6c']).toMatchObject({ label: 'says no' });
  });
  it('restoring the screen a pick replaced undoes the pick: the pick is its option again and hands everything back', () => {
    // regression from a real canvas: a pick made by mistake could not be taken back; restoring the original left the
    // pick in its place holding the original's arrows, and the original came back with none
    const d = demo();
    const t0 = d.pages.truth!;
    t0.items.n6 = { kind: 'note', text: 'Library, after a skip', anchor: 'S6' };
    t0.items.pp = { kind: 'portal', text: 'Library', target: 'S6' };
    const other = newPageDoc('Other');
    other.items = { po: { kind: 'portal', text: 'Library', target: 'page:truth/S6' } };
    d.pages.other = other;
    const picked = applyOps(d, pickProposal(d, 'truth', 'S6a', 'human').ops).docs;
    expect(picked.pages[HISTORY_PAGE]!.items.S6?.archived?.handover).toMatchObject({
      arrows: ['S4>S6a'],
      notes: ['n6'],
    });
    const back = applyOps(picked, restoreFromHistory(picked, 'S6').ops).docs;
    const t = back.pages.truth!;
    expect(t.items.S6).toMatchObject({ kind: 'screen', x: 1404, y: 150, parent: 'library' });
    expect(t.items.S6a).toMatchObject({ proposalFor: 'S6', parent: 'library' });
    expect(t.items.S6a).not.toHaveProperty('x');
    expect(t.arrows['S4>S6']).toMatchObject({ label: 'says no' });
    expect(t.arrows['S4>S6a']).toBeUndefined();
    expect(t.arrows['S6>S6a']).toMatchObject({ from: 'S6', to: 'S6a', style: 'proposal' });
    expect(t.items.n6).toMatchObject({ anchor: 'S6' });
    expect(t.items.pp).toMatchObject({ target: 'S6' });
    expect(back.pages.other!.items.po).toMatchObject({ target: 'page:truth/S6' });
    // the option that was not picked comes back as an option of the original, linked from it again
    const all = applyOps(back, restoreFromHistory(back, 'S6b').ops).docs.pages.truth!;
    expect(all.items.S6b).toMatchObject({ proposalFor: 'S6' });
    expect(all.arrows['S6>S6b']).toBeDefined();
    expect(all.arrows['S6a>S6b']).toBeUndefined();
    expect(validateRefs(back.project, back.pages).filter((p) => p.code.startsWith('dangling'))).toEqual([]);
  });
  it('a pick recorded before handovers were kept is undone too: the pick hands back its arrows and portals', () => {
    const d = demo();
    d.pages.truth!.items.pp = { kind: 'portal', text: 'Library', target: 'S6' };
    const picked = applyOps(d, pickProposal(d, 'truth', 'S6a', 'human').ops).docs;
    delete picked.pages[HISTORY_PAGE]!.items.S6!.archived!.handover;
    const t = applyOps(picked, restoreFromHistory(picked, 'S6').ops).docs.pages.truth!;
    expect(t.items.S6a).toMatchObject({ proposalFor: 'S6' });
    expect(t.arrows['S4>S6']).toMatchObject({ label: 'says no' });
    expect(Object.values(t.arrows).filter((a) => a.from === 'S6a' || a.to === 'S6a')).toEqual([]);
    expect(t.items.pp).toMatchObject({ target: 'S6' });
  });
  it('adl list: the History page counts its screens (all archived) and says what happened to them', async () => {
    const { historyText, screenCount } = await import('../../src/node/commands/session.ts');
    const d = demo();
    const picked = applyOps(d, pickProposal(d, 'truth', 'S6a', 'human').ops).docs;
    const h = picked.pages[HISTORY_PAGE]!;
    expect(screenCount(h)).toBe(2);
    expect(historyText(h)).toBe('1 replaced · 1 not picked');
    expect(screenCount(picked.pages.truth!)).toBe(screenCount(d.pages.truth!) - 2);
    const rejected = applyOps(d, rejectProposal(d, 'truth', 'S6b', 'human')).docs;
    expect(historyText(rejected.pages[HISTORY_PAGE]!)).toBe('1 rejected');
  });
  it('restore puts a rejected proposal back with its arrow', () => {
    const d = demo();
    const rej = applyOps(d, rejectProposal(d, 'truth', 'S6b', 'human')).docs;
    expect(rej.pages.truth!.items.S6b).toBeUndefined();
    const res = restoreFromHistory(rej, 'S6b');
    const after = applyOps(rej, res.ops).docs;
    expect(after.pages.truth!.items.S6b).toMatchObject({ kind: 'screen', status: 'new', proposalFor: 'S6' });
    expect(after.pages.truth!.arrows['S6>S6b']).toBeDefined();
    expect(after.pages[HISTORY_PAGE]!.items.S6b).toBeUndefined();
  });
  it('notes on a rejected screen go to History with it and come back on restore', () => {
    // regression from a real canvas: rejecting a screen left its note on the page, anchored to nothing
    // (validate: anchor "…" does not exist)
    const d = demo();
    d.pages.truth!.items.nb = { kind: 'note', text: 'harsh?', anchor: 'S6b', x: 0, y: 860 };
    const rej = applyOps(d, rejectProposal(d, 'truth', 'S6b', 'human')).docs;
    expect(rej.pages.truth!.items.nb).toBeUndefined();
    expect(rej.pages[HISTORY_PAGE]!.items.nb).toMatchObject({ kind: 'note', anchor: 'S6b', x: 0, y: 860 });
    const broken = ['dangling-anchor', 'dangling-parent'];
    expect(validateRefs(rej.project, rej.pages).filter((p) => broken.includes(p.code))).toEqual([]);
    const back = applyOps(rej, restoreFromHistory(rej, 'S6b').ops).docs;
    expect(back.pages.truth!.items.nb).toMatchObject({ kind: 'note', anchor: 'S6b', parent: 'library', x: 0, y: 860 });
    expect(back.pages[HISTORY_PAGE]!.items.nb).toBeUndefined();
  });
  it('a portal only the rejected screen led to goes to History with it and comes back on restore', () => {
    // regression from a real canvas: picking one option sent another to History, but its portal stayed on the page,
    // led to by nothing
    const d = demo();
    const t = d.pages.truth!;
    t.items.pp = { kind: 'portal', parent: 'library', text: 'Library', target: 'S1' };
    t.items.pq = { kind: 'portal', parent: 'library', text: 'Library', target: 'S1' };
    t.arrows['S6b>pp'] = { from: 'S6b', to: 'pp', label: 'Library' };
    t.arrows['S6b>pq'] = { from: 'S6b', to: 'pq', label: 'Library' };
    t.arrows['S4>pq'] = { from: 'S4', to: 'pq', label: 'also' };
    const rej = applyOps(d, rejectProposal(d, 'truth', 'S6b', 'human')).docs;
    expect(rej.pages.truth!.items.pp).toBeUndefined();
    expect(rej.pages[HISTORY_PAGE]!.items.pp?.archived).toMatchObject({ reason: 'went with S6b', from: 'truth' });
    expect(rej.pages.truth!.items.pq).toBeDefined(); // S4 still leads there
    const back = applyOps(rej, restoreFromHistory(rej, 'S6b').ops).docs;
    expect(back.pages.truth!.items.pp).toMatchObject({ kind: 'portal', target: 'S1', parent: 'library' });
    expect(back.pages.truth!.arrows['S6b>pp']).toMatchObject({ label: 'Library' });
    expect(back.pages[HISTORY_PAGE]!.items.pp).toBeUndefined();
  });
  it('a rejected option on History is not a dangling proposal', () => {
    const d = demo();
    const rej = applyOps(d, rejectProposal(d, 'truth', 'S6b', 'human')).docs;
    expect(rej.pages[HISTORY_PAGE]!.items.S6b).toMatchObject({ proposalFor: 'S6' });
    expect(validateRefs(rej.project, rej.pages).filter((p) => p.code === 'dangling-proposal')).toEqual([]);
  });
  it('removing a screen removes its arrows', () => {
    const d = demo();
    const after = applyOps(d, removeItems(d, 'truth', ['S4'])).docs.pages.truth!;
    expect(Object.keys(after.arrows)).toEqual(['S6>S6a', 'S6>S6b']);
  });
  it('removing a screen that has options: the first takes its place, the others stay its options', () => {
    // regression from a real canvas: deleting a screen with 7 options left them with proposalFor pointing at it
    // (errors in validate) and nothing leading to them any more
    const d = demo();
    d.pages.truth!.items.n6 = { kind: 'note', text: 'pick one', anchor: 'S6' };
    expect(removalHeirs(d, 'truth', ['S6'])).toEqual([['S6', 'S6a']]);
    const ops = removeItems(d, 'truth', ['S6']);
    const after = applyOps(d, ops).docs;
    const t = after.pages.truth!;
    expect(t.items.S6).toBeUndefined();
    expect(t.items.S6a).toMatchObject({ x: 1404, y: 150, parent: 'library', status: 'new' });
    expect(t.items.S6a).not.toHaveProperty('proposalFor');
    expect(t.items.S6b).toMatchObject({ proposalFor: 'S6a' });
    expect(t.items.n6).toMatchObject({ anchor: 'S6a' });
    expect(t.arrows['S4>S6a']).toMatchObject({ label: 'says no' });
    expect(t.arrows['S6a>S6b']).toMatchObject({ label: 'option B', style: 'proposal' });
    expect(Object.keys(t.arrows).sort()).toEqual(['S1>S4', 'S4>S6a', 'S6a>S6b']);
    expect(validateRefs(after.project, after.pages).filter((p) => p.code === 'dangling-proposal')).toEqual([]);
    expect(jsonEqual(applyOps(after, invertOps(ops)).docs, d)).toBe(true);
    // the screen and its first option removed together: the next option takes the place
    const both = applyOps(d, removeItems(d, 'truth', ['S6', 'S6a'])).docs.pages.truth!;
    expect(both.items.S6b).toMatchObject({ x: 1404, y: 150 });
    expect(both.items.S6b).not.toHaveProperty('proposalFor');
    expect(Object.keys(both.arrows).sort()).toEqual(['S1>S4', 'S4>S6b']);
    // an option of a removed option takes that option's place in the chain (and the link that led there)
    d.pages.truth!.items.S6c = { kind: 'screen', parent: 'library', status: 'new', proposalFor: 'S6a' };
    d.pages.truth!.arrows['S6a>S6c'] = { from: 'S6a', to: 'S6c', label: 'wider', style: 'proposal' };
    const chain = applyOps(d, removeItems(d, 'truth', ['S6a'])).docs.pages.truth!;
    expect(chain.items.S6c).toMatchObject({ proposalFor: 'S6' });
    expect(chain.arrows['S6>S6c']).toMatchObject({ label: 'option A', style: 'proposal' });
    expect(chain.arrows['S6a>S6c']).toBeUndefined();
  });
});

describe('how screens are reached (portals, completeness)', () => {
  const pages = () => {
    const truth = newPageDoc('Truth');
    truth.items = {
      sec: { kind: 'section', title: 'Area' },
      A: { kind: 'screen', entry: true },
      B: { kind: 'screen' },
      C: { kind: 'screen', parent: 'sec' },
      D: { kind: 'screen' },
      p1: { kind: 'portal', text: 'Settings\nopens C', target: 'C' },
      p2: { kind: 'portal', text: 'Nowhere' },
      p3: { kind: 'portal', text: 'The area', target: 'sec' },
    };
    truth.arrows = {
      'A>B': { from: 'A', to: 'B', label: 'next' },
      'B>p1': { from: 'B', to: 'p1', label: 'gear' },
    };
    const other = newPageDoc('Other');
    other.items = {
      X: { kind: 'screen', entry: true },
      q: { kind: 'portal', text: 'Back to C', target: 'page:truth/C' },
    };
    other.arrows = { 'X>q': { from: 'X', to: 'q', label: 'back' } };
    return { truth, other };
  };
  it('portalsTo lists every portal standing for a screen, on any page, with what leads into it', () => {
    const ps = pages();
    const via = portalsTo(ps, 'truth', 'C');
    expect(via.map((v) => [v.page, v.id, v.text, v.from])).toEqual([
      ['truth', 'p1', 'Settings', ['B']],
      ['other', 'q', 'Back to C', ['X']],
    ]);
    expect(portalsTo(ps, 'truth', 'B')).toEqual([]);
  });
  it('validate: screens nothing leads to, portals without a target or pointing at a non-screen', () => {
    const d = demo();
    const ps = pages();
    const probs = validateRefs(d.project, ps);
    const codes = (code: string) => probs.filter((p) => p.code === code).map((p) => p.id);
    expect(codes('unreached')).toEqual(['D']); // A is a start, B has an arrow, C is reached through portals
    expect(codes('portal-no-target')).toEqual(['p2']);
    expect(codes('portal-not-screen')).toEqual(['p3']);
  });
});

describe('statuses, frames, validation', () => {
  it('adds a custom status with a readable id', () => {
    const d = demo();
    const r = addStatus(d, { label: 'Test on a small phone', color: '#8DB6FF', role: 'review', createdBy: 'human' });
    expect(r.id).toBe('test-on-a-small-phone');
  });
  it('counts statuses per section', () => {
    const d = demo();
    expect(countsText(countStatuses(d.project, d.pages.truth!, 'library'))).toBe('2 approved · 2 new · 1 to decide');
  });
  it('resolves frames', () => {
    expect(resolveFrame('390x844')).toEqual({ w: 390, h: 844 });
    expect(resolveFrame('1440xauto')).toEqual({ w: 1440, h: 'auto' });
    expect(resolveFrame('iphone-16')?.w).toBe(393);
    expect(resolveFrame('nope')).toBeUndefined();
  });
  it('finds dangling references', () => {
    const d = demo();
    d.pages.truth!.arrows['X>S1'] = { from: 'X', to: 'S1', label: 'x' };
    (d.pages.truth!.items.S1 as { status?: string }).status = 'nonsense';
    const codes = validateRefs(d.project, d.pages).map((p) => p.code);
    expect(codes).toContain('dangling-arrow');
    expect(codes).toContain('unknown-status');
  });
  it('arrows get readable ids', () => {
    const d = demo();
    expect(addArrow(d, 'truth', 'S1', 'S4').id).toBe('S1>S4#2');
  });
});

describe('routing around captions and notes', () => {
  const A = { x: 0, y: 0, w: 390, h: 844 };
  const B = { x: 0, y: 1100, w: 390, h: 844 };
  const arrow = { from: 'A', to: 'B', label: 'proposed version' };
  it('an arrow into the top of a screen ends above its caption and banner', async () => {
    const { routeAll } = await import('../../src/core/route.ts');
    const r = routeAll([{ id: 'A>B', arrow, from: A, to: B, toHead: 90 }], { obstacles: new Map() }).get('A>B')!;
    expect(r.points[r.points.length - 1]![1]).toBe(1100 - 90);
  });
  it('labels move off notes that cover the middle of the arrow', async () => {
    const { routeAll } = await import('../../src/core/route.ts');
    const note = { x: 0, y: 930, w: 300, h: 60 };
    const plain = routeAll([{ id: 'A>B', arrow, from: A, to: B }], { obstacles: new Map() }).get('A>B')!;
    expect(plain.label[1]).toBeGreaterThan(note.y);
    expect(plain.label[1]).toBeLessThan(note.y + note.h);
    const r = routeAll([{ id: 'A>B', arrow, from: A, to: B }], { obstacles: new Map(), labelAvoid: [note] }).get(
      'A>B',
    )!;
    const box = { y: r.label[1] - 12, h: 24 };
    expect(box.y >= note.y + note.h || box.y + box.h <= note.y).toBe(true);
  });
  it('an arrow to a screen on the left goes over the top, unless its sides were set to left → right', async () => {
    const { routeAll } = await import('../../src/core/route.ts');
    const R = { x: 600, y: 0, w: 390, h: 844 };
    const back = { from: 'R', to: 'A', label: 'option E' };
    const over = routeAll([{ id: 'R>A', arrow: back, from: R, to: A }], { obstacles: new Map() }).get('R>A')!;
    expect(over.fromSide).toBe('top');
    const side = { ...back, fromSide: 'left' as const, toSide: 'right' as const };
    const r = routeAll([{ id: 'R>A', arrow: side, from: R, to: A }], { obstacles: new Map() }).get('R>A')!;
    expect(r.points).toEqual([
      [600, 422],
      [390, 422],
    ]);
  });
  it('option links fan out from the bottom to a row below, and go straight to an option on the left', async () => {
    const { routeAll } = await import('../../src/core/route.ts');
    const S = { x: 550, y: 0, w: 390, h: 844 };
    const row = [0, 550, 1100, 1650].map((x) => ({ x, y: 1100, w: 390, h: 844 }));
    const inputs = row.map((r, i) => ({
      id: `S>O${i}`,
      arrow: { from: 'S', to: `O${i}`, label: `option ${i}`, style: 'proposal' },
      from: S,
      to: r,
    }));
    const left = { x: 0, y: 0, w: 390, h: 844 };
    inputs.push({ id: 'S>L', arrow: { from: 'S', to: 'L', label: 'option L', style: 'proposal' }, from: S, to: left });
    const out = routeAll(inputs, { obstacles: new Map() });
    for (let i = 0; i < row.length; i++) {
      const r = out.get(`S>O${i}`)!;
      expect([r.fromSide, r.toSide]).toEqual(['bottom', 'top']);
      // nothing goes above the source screen
      expect(Math.min(...r.points.map((p) => p[1]))).toBe(844);
    }
    expect(out.get('S>L')!.points).toEqual([
      [550, 422],
      [390, 422],
    ]);
  });
  it('an option link that goes down turns where it crosses no screen, not always halfway', async () => {
    const { routeAll } = await import('../../src/core/route.ts');
    const S = { x: 600, y: 0, w: 390, h: 844 };
    const T = { x: 0, y: 2300, w: 390, h: 844 };
    const O = { x: 300, y: 1100, w: 390, h: 844 }; // another option row sits between them
    const r = routeAll(
      [{ id: 'S>T', arrow: { from: 'S', to: 'T', label: 'option', style: 'proposal' }, from: S, to: T }],
      { obstacles: new Map([['O', O]]) },
    ).get('S>T')!;
    expect([r.fromSide, r.toSide]).toEqual(['bottom', 'top']);
    // every horizontal stretch stays clear of O (and of the room for its caption above it)
    for (let i = 1; i < r.points.length; i++) {
      const [x1, y1] = r.points[i - 1]!;
      const [x2, y2] = r.points[i]!;
      if (y1 !== y2) continue;
      const crossesX = Math.max(x1, x2) > O.x && Math.min(x1, x2) < O.x + O.w;
      expect(crossesX && y1 > O.y - 70 && y1 < O.y + O.h).toBe(false);
    }
  });
  it('a two-line banner makes the head taller than a caption alone', async () => {
    const { screenHeadHeight } = await import('../../src/core/layout.ts');
    expect(screenHeadHeight(undefined, 390)).toBe(32);
    expect(screenHeadHeight('NEW', 390)).toBeLessThan(
      screenHeadHeight('NOT APPROVED · S6 · orange instead of red: pick one', 390),
    );
  });
});
