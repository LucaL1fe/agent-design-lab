// The build check: states, captures, flows, counts, validation and the canonical file order.
import { describe, expect, it } from 'vitest';
import { describeChanges } from '../../src/core/describe.ts';
import {
  addCapture,
  applyOps,
  buildCountsText,
  captureDevices,
  captureFor,
  clearBuild,
  countBuild,
  countFlows,
  type Docs,
  flowsThrough,
  newPageDoc,
  newProjectDoc,
  type PageDoc,
  parseBuildState,
  parseJson,
  progressText,
  removeCapture,
  setBuild,
  setFlow,
  setFlowBuild,
  shownCapture,
  stringifyPage,
  usesBuild,
  validatePageDoc,
  validateRefs,
} from '../../src/core/index.ts';

function docs(): Docs {
  const page = newPageDoc('Source of truth');
  page.items = {
    sec: { kind: 'section', title: 'Home', x: 0, y: 0 },
    inner: { kind: 'section', title: 'Inner', parent: 'sec', x: 0, y: 0 },
    home: { kind: 'screen', parent: 'sec', x: 0, y: 0 },
    edit: { kind: 'screen', parent: 'inner', x: 500, y: 0 },
    done: { kind: 'screen', x: 1000, y: 0 },
    tip: { kind: 'note', text: 'hello', x: 0, y: 900 },
  };
  return { project: newProjectDoc('Notes'), pages: { truth: page } };
}

const apply = (d: Docs, ops: ReturnType<typeof setBuild>) => applyOps(d, ops).docs;
const truth = (d: Docs) => d.pages.truth as PageDoc;

describe('build states', () => {
  it('reads loose words', () => {
    expect(parseBuildState('matching')).toBe('matching');
    expect(parseBuildState('Done')).toBe('matching');
    expect(parseBuildState('deviates')).toBe('deviating');
    expect(parseBuildState('in-progress')).toBe('wip');
    expect(parseBuildState('nope')).toBeUndefined();
  });

  it('sets a state, keeps the note unless given, and stamps who and when', () => {
    let d = docs();
    d = apply(d, setBuild(d, 'truth', ['home', 'edit'], 'deviating', 'the button is grey', 'agent'));
    const b = (truth(d).items.home as { build: { state: string; note: string; by: string; at: string } }).build;
    expect(b).toMatchObject({ state: 'deviating', note: 'the button is grey', by: 'agent' });
    expect(Number.isNaN(Date.parse(b.at))).toBe(false);
    d = apply(d, setBuild(d, 'truth', ['home'], 'matching', undefined, 'human'));
    expect(truth(d).items.home).toMatchObject({
      build: { state: 'matching', note: 'the button is grey', by: 'human' },
    });
    d = apply(d, setBuild(d, 'truth', ['home'], 'matching', '', 'human'));
    expect((truth(d).items.home as { build: { note?: string } }).build.note).toBeUndefined();
  });

  it('ignores items that are not screens and leaves the check with clearBuild', () => {
    let d = docs();
    d = apply(d, setBuild(d, 'truth', ['tip', 'home'], 'wip', undefined, 'agent'));
    expect((truth(d).items.tip as Record<string, unknown>).build).toBeUndefined();
    d = apply(d, clearBuild(d, 'truth', ['home']));
    expect((truth(d).items.home as Record<string, unknown>).build).toBeUndefined();
  });

  it('counts per state, per section with nested sections, and the progress text', () => {
    let d = docs();
    expect(usesBuild(truth(d))).toBe(false);
    d = apply(d, setBuild(d, 'truth', ['home', 'done'], 'matching', undefined, 'agent'));
    d = apply(d, setBuild(d, 'truth', ['edit'], 'blocked', 'needs a server', 'agent'));
    expect(usesBuild(truth(d))).toBe(true);
    const all = countBuild(truth(d));
    expect(progressText(all)).toBe('2/3 matching');
    expect(buildCountsText(all)).toBe('2 matching · 1 blocked');
    expect(progressText(countBuild(truth(d), 'sec'))).toBe('1/2 matching');
    expect(progressText(countBuild(truth(d), 'inner'))).toBe('0/1 matching');
    expect(progressText([])).toBe('');
  });
});

describe('captures', () => {
  it('adds one capture per device and kind, a new one replaces the old', () => {
    let d = docs();
    d = apply(
      d,
      addCapture(d, 'truth', 'home', { device: 'phone', kind: 'image', src: 'captures/home/a.webp' }, 'agent'),
    );
    d = apply(
      d,
      addCapture(d, 'truth', 'home', { device: 'phone', kind: 'video', src: 'captures/home/a.mp4' }, 'agent'),
    );
    d = apply(
      d,
      addCapture(d, 'truth', 'home', { device: 'phone', kind: 'image', src: 'captures/home/b.webp' }, 'agent'),
    );
    const b = (truth(d).items.home as { build: Parameters<typeof captureFor>[0] }).build;
    expect(b?.state).toBe('todo');
    expect(b?.captures).toHaveLength(2);
    expect(captureFor(b, 'phone', 'image')?.src).toBe('captures/home/b.webp');
    // a video shows the motion, so it wins
    expect(shownCapture(b, 'phone')?.kind).toBe('video');
    expect(shownCapture(b, 'tablet')).toBeUndefined();
    expect(captureDevices(truth(d))).toEqual(['phone']);
    d = apply(d, removeCapture(d, 'truth', 'home', 'phone', 'video'));
    expect(
      shownCapture((truth(d).items.home as { build: Parameters<typeof captureFor>[0] }).build, 'phone')?.kind,
    ).toBe('image');
  });

  it('keeps the state when a capture arrives', () => {
    let d = docs();
    d = apply(d, setBuild(d, 'truth', ['home'], 'matching', undefined, 'agent'));
    d = apply(
      d,
      addCapture(d, 'truth', 'home', { device: 'tablet', kind: 'image', src: 'captures/home/t.webp' }, 'agent'),
    );
    expect(truth(d).items.home).toMatchObject({ build: { state: 'matching' } });
  });

  it('refuses a capture on something that is not a screen', () => {
    const d = docs();
    expect(() => addCapture(d, 'truth', 'tip', { device: 'phone', kind: 'image', src: 'x.png' }, 'agent')).toThrow(
      /not a screen/,
    );
  });
});

describe('flows', () => {
  it('adds a flow, sets its state, and finds the flows through a screen', () => {
    let d = docs();
    d = apply(d, setFlow(d, 'truth', 'write', { title: 'Write a note', steps: ['home', 'edit', 'done'] }));
    d = apply(d, setFlowBuild(d, 'truth', 'write', 'deviating', 'no undo', 'agent'));
    expect(truth(d).flows?.write).toMatchObject({
      title: 'Write a note',
      build: { state: 'deviating', note: 'no undo' },
    });
    expect(flowsThrough(truth(d), 'edit')).toEqual(['write']);
    expect(progressText(countFlows(truth(d)))).toBe('0/1 matching');
    d = apply(d, setFlow(d, 'truth', 'write', undefined));
    expect(truth(d).flows?.write).toBeUndefined();
  });

  it('throws for a state on a flow that does not exist', () => {
    const d = docs();
    expect(() => setFlowBuild(d, 'truth', 'nope', 'matching', undefined, 'agent')).toThrow(/No flow/);
  });
});

describe('validation and files', () => {
  it('warns about a deviation without a reason and about unknown flow steps', () => {
    let d = docs();
    d = apply(d, setBuild(d, 'truth', ['home'], 'deviating', undefined, 'agent'));
    d = apply(d, setFlow(d, 'truth', 'write', { title: 'Write', steps: ['home', 'gone', 'tip'] }));
    const codes = validateRefs(d.project, d.pages).map((p) => `${p.code}:${p.id}`);
    expect(codes).toContain('build-needs-note:home');
    expect(codes).toContain('flow-unknown-step:write');
    expect(codes).toContain('flow-step-not-screen:write');
  });

  it('schema-checks build fields and flows', () => {
    const page = { ...truth(docs()) } as Record<string, unknown>;
    const items = page.items as Record<string, Record<string, unknown>>;
    items.home = { ...items.home, build: { state: 'great' } };
    expect(validatePageDoc('truth', page).length).toBeGreaterThan(0);
    items.home = {
      ...items.home,
      build: { state: 'matching', captures: [{ device: 'phone', kind: 'gif', src: 'a' }] },
    };
    expect(validatePageDoc('truth', page).length).toBeGreaterThan(0);
    items.home = { ...items.home, build: { state: 'matching' } };
    page.flows = { f: { title: 'F', steps: ['home'] } };
    expect(validatePageDoc('truth', page)).toEqual([]);
  });

  it('writes build after the screen fields and flows after the arrows, and reads them back', () => {
    let d = docs();
    d = apply(d, setBuild(d, 'truth', ['home'], 'matching', undefined, 'agent'));
    d = apply(d, setFlow(d, 'truth', 'write', { title: 'Write', steps: ['home', 'edit'] }));
    const text = stringifyPage(truth(d) as never);
    const homeLine = text.split('\n').find((l) => l.includes('"home": {'))!;
    expect(homeLine.indexOf('"build"')).toBeGreaterThan(homeLine.indexOf('"y"'));
    expect(text.indexOf('"flows"')).toBeGreaterThan(text.indexOf('"arrows"'));
    expect(text).toContain('"write": {"title": "Write", "steps": ["home", "edit"]}');
    const back = parseJson<PageDoc>(text);
    expect(back.ok && back.value.flows?.write?.steps).toEqual(['home', 'edit']);
    expect(stringifyPage((back.ok ? back.value : {}) as never)).toBe(text);
  });

  it('describes build changes in plain words for the agent', () => {
    const before = docs();
    let after = apply(before, setBuild(before, 'truth', ['home'], 'blocked', 'needs the server', 'human'));
    const ops = setFlow(after, 'truth', 'write', { title: 'Write', steps: ['home'] });
    const lines1 = describeChanges(
      before,
      after,
      setBuild(before, 'truth', ['home'], 'blocked', 'needs the server', 'human'),
    );
    expect(lines1.join('\n')).toContain('home: build Blocked: “needs the server”');
    const prev = after;
    after = apply(after, ops);
    expect(describeChanges(prev, after, ops).join('\n')).toContain('new flow write “Write”');
  });
});
