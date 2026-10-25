import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyOps,
  type Docs,
  diffDoc,
  type Item,
  intersects,
  invertOps,
  jsonEqual,
  merge3,
  mergePage,
  newPageDoc,
  newProjectDoc,
  type PageDoc,
  pageKey,
  placePage,
  stringifyPage,
} from '../../src/core/index.ts';

const RUNS = Number(process.env.FC_RUNS ?? 2000);
const ids = fc.constantFrom('A', 'B', 'C', 'D', 'E', 'n1', 's1');
const coord = fc.integer({ min: -3000, max: 3000 });
const itemArb: fc.Arbitrary<Item> = fc.oneof(
  fc.record({
    kind: fc.constant('screen' as const),
    x: coord,
    y: coord,
    status: fc.constantFrom('new', 'approved', 'to-decide'),
    banner: fc.string({ maxLength: 12 }),
  }),
  fc.record({ kind: fc.constant('note' as const), x: coord, y: coord, text: fc.string({ maxLength: 30 }) }),
  fc.record({ kind: fc.constant('text' as const), x: coord, y: coord, text: fc.string({ maxLength: 20 }) }),
);
const pageArb: fc.Arbitrary<PageDoc> = fc
  .record({
    items: fc.dictionary(ids, itemArb, { maxKeys: 7 }),
    arrows: fc.dictionary(
      fc.constantFrom('A>B', 'B>C', 'C>A', 'A>D'),
      fc.record({ from: ids, to: ids, label: fc.string({ maxLength: 10 }) }),
      { maxKeys: 4 },
    ),
  })
  .map((r) => ({ ...newPageDoc('P'), ...r }));

const opArb = fc.oneof(
  fc.record({
    doc: fc.constant(pageKey('p')),
    path: fc.tuple(fc.constant('items'), ids).map((t) => [...t]),
    value: fc.option(itemArb, { nil: undefined }),
  }),
  fc.record({
    doc: fc.constant(pageKey('p')),
    path: fc.tuple(fc.constant('items'), ids, fc.constantFrom('x', 'y', 'status', 'banner')).map((t) => [...t]),
    value: fc.option(fc.oneof(coord, fc.string({ maxLength: 8 })), { nil: undefined }),
  }),
  fc.record({
    doc: fc.constant('project' as const),
    path: fc.constant(['name']),
    value: fc.string({ minLength: 1, maxLength: 8 }),
  }),
);

const docsOf = (page: PageDoc): Docs => ({ project: newProjectDoc('X'), pages: { p: page } });

describe('properties', () => {
  it('apply → invert restores the documents exactly', () => {
    fc.assert(
      fc.property(pageArb, fc.array(opArb, { maxLength: 25 }), (page, ops) => {
        const d = docsOf(page);
        const r = applyOps(d, ops);
        const back = applyOps(r.docs, invertOps(r.ops));
        return jsonEqual(back.docs, d);
      }),
      { numRuns: RUNS },
    );
  });

  it('diffDoc produces ops that turn a into b', () => {
    fc.assert(
      fc.property(pageArb, pageArb, (a, b) => {
        const ops = diffDoc(pageKey('p'), a, b);
        return jsonEqual(applyOps(docsOf(a), ops).docs.pages.p, b);
      }),
      { numRuns: RUNS },
    );
  });

  it('canonical JSON round-trips', () => {
    fc.assert(
      fc.property(pageArb, (page) => {
        const s = stringifyPage(page as never);
        return jsonEqual(JSON.parse(s), JSON.parse(JSON.stringify(page))) && stringifyPage(JSON.parse(s)) === s;
      }),
      { numRuns: RUNS },
    );
  });

  it('merge laws: unchanged sides, equal sides, disjoint changes', () => {
    fc.assert(
      fc.property(pageArb, pageArb, (b, x) => {
        expect(merge3(b, b, x).value).toEqual(merge3(b, b, x).value);
        return (
          jsonEqual(merge3(b, b, x).value, x) &&
          jsonEqual(merge3(b, x, b).value, x) &&
          jsonEqual(merge3(b, x, x).value, x) &&
          merge3(b, x, x).conflicts.length === 0
        );
      }),
      { numRuns: RUNS },
    );
  });

  it('changes to different items never conflict and both survive', () => {
    fc.assert(
      fc.property(pageArb, opArb, opArb, (b, o1, o2) => {
        if (o1.doc !== pageKey('p') || o2.doc !== pageKey('p')) return true;
        if (o1.path[1] === o2.path[1]) return true;
        const d = docsOf(b);
        const ours = applyOps(d, [o1]).docs.pages.p!;
        const theirs = applyOps(d, [o2]).docs.pages.p!;
        const m = mergePage(b, ours, theirs);
        const both = applyOps(applyOps(d, [o1]).docs, [o2]).docs.pages.p!;
        return m.conflicts.length === 0 && jsonEqual(m.value, both);
      }),
      { numRuns: RUNS },
    );
  });

  it('pinned geometry survives any agent rewrite', () => {
    fc.assert(
      fc.property(pageArb, coord, coord, pageArb, (b, x, y, theirs) => {
        if (!b.items.A || (b.items.A.x === x && b.items.A.y === y)) return true; // the person must actually have moved it
        const ours = structuredClone(b);
        ours.items.A = { ...ours.items.A, x, y, pinned: true } as Item;
        if (theirs.items.A) theirs.items.A = { ...theirs.items.A, kind: ours.items.A.kind } as Item;
        const v = mergePage(b, ours, theirs).value as PageDoc;
        if (!v.items?.A || !theirs.items.A) return true;
        // fields the person changed keep the person's value
        return (b.items.A.x === x || v.items.A.x === x) && (b.items.A.y === y || v.items.A.y === y);
      }),
      { numRuns: RUNS },
    );
  });

  it('auto-placed screens never overlap', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }),
        fc.array(fc.tuple(fc.nat(29), fc.nat(29)), { maxLength: 30 }),
        (n, links) => {
          const page = newPageDoc('p');
          for (let i = 0; i < n; i++) page.items[`S${i}`] = { kind: 'screen' };
          page.items.S0 = { kind: 'screen', x: 0, y: 0 };
          for (const [a, b] of links)
            if (a < n && b < n && a !== b) page.arrows[`S${a}>S${b}`] = { from: `S${a}`, to: `S${b}`, label: 'x' };
          const rects = [...placePage(page, () => ({ w: 390, h: 844 })).rects.values()];
          for (let i = 0; i < rects.length; i++)
            for (let j = i + 1; j < rects.length; j++) if (intersects(rects[i]!, rects[j]!)) return false;
          return true;
        },
      ),
      { numRuns: Math.min(RUNS, 500) },
    );
  });
});

describe('undo/redo', () => {
  it('undo then redo returns to the after-state, undo after redo to the before-state', async () => {
    const { safeInverse } = await import('../../src/core/ops.ts');
    fc.assert(
      fc.property(pageArb, fc.array(opArb, { maxLength: 15 }), (page, ops) => {
        const d0 = docsOf(page);
        const r = applyOps(d0, ops);
        const undo = applyOps(r.docs, safeInverse(r.docs, r.ops).ops);
        const redo = applyOps(undo.docs, safeInverse(undo.docs, undo.ops).ops);
        const undo2 = applyOps(redo.docs, safeInverse(redo.docs, redo.ops).ops);
        return jsonEqual(undo.docs, d0) && jsonEqual(redo.docs, r.docs) && jsonEqual(undo2.docs, d0);
      }),
      { numRuns: RUNS },
    );
  });
});
