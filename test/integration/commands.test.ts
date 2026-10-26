// The command registry as agents use it: without a server (files written directly), through a running server (the
// canvas sees every change), the hook script, and `adl setup`.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setStatus } from '../../src/core/actions.ts';
import { pageKey } from '../../src/core/ops.ts';
import { commands, parseArgs } from '../../src/node/commands/registry.ts';
import '../../src/node/commands/index.ts';
import { mergeHooks, upsertSection } from '../../src/node/commands/setup.ts';
import { type RunningServer, startServer } from '../../src/node/server/server.ts';

const repo = path.resolve(import.meta.dirname, '..', '..');

async function run(cmd: string, argv: string[], cwd: string, server?: RunningServer) {
  const c = commands.get(cmd);
  if (!c) throw new Error(`no command ${cmd}`);
  try {
    return await c.run(parseArgs(argv), { cwd, ...(server ? { server } : {}) });
  } catch (e) {
    return { ok: false, text: (e as Error).message };
  }
}

const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

describe('commands without a server', () => {
  let ws: string;
  let pdir: string;
  const page = () => readJson(path.join(pdir, 'pages', 'truth.json'));
  beforeAll(async () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'adl-cmd-'));
    const r = await run('init', ['Habit', 'app'], ws);
    expect(r.ok).toBe(true);
    pdir = path.join(ws, 'habit-app');
    for (const id of ['H1', 'H2', 'H3'])
      expect((await run('screen', ['new', id, '--title', `Title ${id}`], pdir)).ok).toBe(true);
  });
  afterAll(() => fs.rmSync(ws, { recursive: true, force: true }));

  it('init writes a complete project', () => {
    for (const f of ['project.json', 'pages/truth.json', 'styles/tokens.css', 'styles/components.css', 'brief.md'])
      expect(fs.existsSync(path.join(pdir, f)), f).toBe(true);
    expect(fs.readFileSync(path.join(pdir, 'screens', 'H1.html'), 'utf8')).toContain('../styles/tokens.css');
  });

  it('add places screens and chains labelled arrows', async () => {
    expect((await run('add', ['H1', '--entry'], pdir)).ok).toBe(true);
    const r = await run('add', ['H2', 'H3', '--after', 'H1', '--chain', '--label', 'tap +', '--label', 'save'], pdir);
    expect(r.text).toBe('2 screens, 2 arrows: "tap +", "save"');
    const p = page();
    expect(p.items.H1).toMatchObject({ kind: 'screen', entry: true, status: 'new' });
    expect(p.arrows['H1>H2']).toMatchObject({ label: 'tap +' });
    expect(p.arrows['H2>H3']).toMatchObject({ label: 'save' });
  });

  it('--entry marks every screen added side by side, but only the start of a chain', async () => {
    expect((await run('add', ['E1', 'E2', '--entry'], pdir)).ok).toBe(true);
    expect(page().items.E1.entry).toBe(true);
    expect(page().items.E2.entry).toBe(true);
    expect((await run('add', ['E3', 'E4', '--chain', '--entry', '--label', 'next'], pdir)).ok).toBe(true);
    expect(page().items.E3.entry).toBe(true);
    expect(page().items.E4.entry).toBeUndefined();
    expect((await run('remove', ['E1', 'E2', 'E3', 'E4'], pdir)).ok).toBe(true);
  });

  it('a chain without --after labels its arrows in order', async () => {
    // regression: labels were counted per screen, so the first arrow got the second label
    expect((await run('add', ['C1', 'C2', 'C3', '--chain', '--label', 'one', '--label', 'two'], pdir)).ok).toBe(true);
    expect(page().arrows['C1>C2'].label).toBe('one');
    expect(page().arrows['C2>C3'].label).toBe('two');
    expect((await run('remove', ['C1', 'C2', 'C3'], pdir)).ok).toBe(true);
  });

  it('proposals get "option A/B" arrows and proposalFor; planned screens are reported', async () => {
    const r = await run('add', ['H2a', 'H2b', '--after', 'H2', '--style', 'proposal'], pdir);
    expect(r.text).toContain('"option A", "option B"');
    expect(r.text).toContain('Planned');
    expect(page().items.H2a).toMatchObject({ proposalFor: 'H2' });
    expect(page().arrows['H2>H2b']).toMatchObject({ style: 'proposal', label: 'option B' });
  });

  it('link updates an existing arrow instead of drawing a second one, and parses triggers', async () => {
    const r = await run('link', ['H1', 'H2', '--label', 'tap plus', '--trigger', 'tap #plus'], pdir);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('(updated)');
    expect(r.text).toContain('has no element with data-adl-anchor="plus"');
    const arrows = Object.values(page().arrows).filter((a: any) => a.from === 'H1' && a.to === 'H2');
    expect(arrows).toEqual([{ from: 'H1', to: 'H2', label: 'tap plus', trigger: { on: 'tap', el: 'plus' } }]);
    const auto = await run('link', ['H3', 'H1', '--style', 'loop', '--label', 'again', '--trigger', 'auto 1.5s'], pdir);
    expect(auto.ok).toBe(true);
    expect(page().arrows['H3>H1'].trigger).toEqual({ on: 'auto', after: 1500 });
    expect((await run('link', ['H1', 'H2', '--trigger', 'wiggle'], pdir)).text).toContain('Unknown trigger');
  });

  it('status sets status and banner, banner only, and makes new statuses', async () => {
    expect((await run('status', ['H2', 'needs-fix', '--banner', 'save is too small'], pdir)).text).toBe(
      'H2 → Needs a fix: “save is too small”',
    );
    expect((await run('status', ['H2', '--banner', 'save button too small'], pdir)).ok).toBe(true);
    expect(page().items.H2).toMatchObject({ status: 'needs-fix', banner: 'save button too small' });
    expect((await run('status', ['H3', 'Needs a fix'], pdir)).ok).toBe(true); // by label
    expect((await run('status', ['H3', 'nope'], pdir)).text).toContain('No status "nope"');
    const r = await run('status', ['H3', 'Test on a small phone', '--create', '--color', '#8DB6FF'], pdir);
    expect(r.ok).toBe(true);
    const proj = readJson(path.join(pdir, 'project.json'));
    const def = proj.statuses.find((s: any) => s.label === 'Test on a small phone');
    expect(def).toMatchObject({ role: 'review', createdBy: 'agent', color: '#8DB6FF' });
    expect(page().items.H3.status).toBe(def.id);
    expect((await run('status', ['H3', 'approved'], pdir)).text).toContain('banner removed');
  });

  it('note, section, page and patch', async () => {
    expect((await run('note', ['use', 'the', 'brand', 'green', '--on', 'H3'], pdir)).ok).toBe(true);
    const note = Object.values(page().items).find((i: any) => i.kind === 'note') as any;
    expect(note).toMatchObject({ text: 'use the brand green', anchor: 'H3', by: 'agent' });
    expect((await run('section', ['Onboarding', 'H1', 'H2', 'H3'], pdir)).ok).toBe(true);
    expect(page().items.H1.parent).toBe('Onboarding');
    expect((await run('section', ['rename', 'Onboarding', 'First', 'run'], pdir)).ok).toBe(true);
    expect(page().items.Onboarding.title).toBe('First run');
    const pg = await run('page', ['new', 'Design', 'system'], pdir);
    expect(pg.text).toContain('design-system');
    expect(readJson(path.join(pdir, 'project.json')).pages).toEqual(['truth', 'design-system']);
    expect(fs.existsSync(path.join(pdir, 'pages', 'design-system.json'))).toBe(true);
    expect((await run('add', ['DS1', '--page', 'design-system'], pdir)).ok).toBe(true);
    expect(readJson(path.join(pdir, 'pages', 'design-system.json')).items.DS1).toBeDefined();
    expect((await run('patch', ['truth', '{"items":{"H1":{"title":"Today","entry":null}}}'], pdir)).ok).toBe(true);
    expect(page().items.H1).toMatchObject({ title: 'Today' });
    expect(page().items.H1.entry).toBeUndefined();
    expect((await run('patch', ['truth', '{oops'], pdir)).text).toContain('not valid JSON');
  });

  it('portal: a box standing for a screen elsewhere, on this page or another one', async () => {
    const r = await run('portal', ['--to', 'H3', '--after', 'H1', '--label', 'skip ahead'], pdir);
    expect(r.ok).toBe(true);
    const id = (r.data as { id: string }).id;
    expect(page().items[id]).toMatchObject({ kind: 'portal', target: 'H3', text: 'Title H3\n→ H3' });
    expect(Object.values(page().arrows)).toContainEqual({ from: 'H1', to: id, label: 'skip ahead' });
    const far = await run('portal', ['--to', 'DS1'], pdir);
    expect((far.data as { target: string }).target).toBe('page:design-system/DS1');
    expect((await run('portal', ['--to', 'NOPE'], pdir)).text).toContain('"NOPE" is on no page');
    // the arrow into a portal keeps its trigger (regression: --trigger was silently dropped on a real canvas)
    const tapped = await run(
      'portal',
      ['--to', 'H3', '--after', 'H1', '--label', 'see all', '--trigger', 'tap see-all'],
      pdir,
    );
    const tid = (tapped.data as { id: string }).id;
    expect(Object.values(page().arrows)).toContainEqual({
      from: 'H1',
      to: tid,
      label: 'see all',
      trigger: { on: 'tap', el: 'see-all' },
    });
    expect(tapped.text).toContain('H1 has no element with data-adl-anchor="see-all"');
    expect((await run('portal', ['--to', 'H3', '--trigger', 'tap x'], pdir)).text).toContain('need --after');
    expect((await run('remove', [id, tid, (far.data as { id: string }).id], pdir)).ok).toBe(true);
  });

  it('pick sends the original and the other option to History; history --restore brings one back', async () => {
    const r = await run('pick', ['H2a'], pdir);
    expect(r.text).toBe('H2a is used instead of H2. On the History page now: H2, H2b');
    expect(page().items.H2).toBeUndefined();
    expect(page().arrows['H1>H2a']).toMatchObject({ label: 'tap plus' });
    const h = await run('history', [], pdir);
    expect(h.text).toMatch(/H2 {2}replaced by H2a/);
    expect((await run('history', ['--restore', 'H2b'], pdir)).ok).toBe(true);
    // regression: the restored option pointed at H2, which had been replaced by H2a
    expect(page().items.H2b).toMatchObject({ proposalFor: 'H2a' });
    expect(page().arrows['H2a>H2b']).toMatchObject({ label: 'option B', style: 'proposal' });
  });

  it('reject sends every proposal it is given to History; pick refuses a second id instead of ignoring it', async () => {
    expect((await run('add', ['H3a', 'H3b', '--after', 'H3', '--style', 'proposal'], pdir)).ok).toBe(true);
    const many = await run('pick', ['H3a', 'H3b'], pdir);
    expect(many.ok).toBe(false);
    expect(page().items.H3).toBeDefined();
    // regression: only the first id was rejected, the second stayed on the page without a word
    const r = await run('reject', ['H3a', 'H3b'], pdir);
    expect(r.text).toBe('H3a, H3b are on the History page');
    expect(page().items.H3a).toBeUndefined();
    expect(page().items.H3b).toBeUndefined();
    expect(page().items.H3).toBeDefined();
    expect((await run('history', [], pdir)).text).toMatch(/H3b {2}rejected/);
    expect((await run('reject', ['H9z'], pdir)).ok).toBe(false);
  });

  it('validate, show and context', async () => {
    const v = await run('validate', [], pdir);
    expect(v.text).toMatch(/^ok · 5 screens · 4 arrows · 1 problem\n/);
    expect(v.text).toContain('H1 has no element with data-adl-anchor="plus"');
    expect(v.text).toContain('H2a is planned');
    const s = await run('show', ['H3'], pdir);
    expect(s.text).toContain('screens/H3.html');
    expect(s.text).toContain('note ');
    const c = await run('context', [], pdir);
    expect(c.text).toContain('Project “Habit app”');
    expect(c.text).toContain('Pages: truth (source of truth), design-system');
    expect(fs.existsSync(path.join(pdir, '.adl', 'agent-seen.json'))).toBe(true);
  });

  it('remove unplaces a screen and keeps its file; layout keeps pinned items', async () => {
    expect((await run('remove', ['H2b'], pdir)).ok).toBe(true);
    expect(page().items.H2b).toBeUndefined();
    const p = page();
    p.items.H3 = { ...p.items.H3, x: 5, y: 6, pinned: true };
    p.items.H1 = { ...p.items.H1, x: 7, y: 8 };
    fs.writeFileSync(path.join(pdir, 'pages', 'truth.json'), JSON.stringify(p));
    expect((await run('layout', ['Onboarding'], pdir)).text).toBe('Re-laid out 1 item');
    expect(page().items.H3).toMatchObject({ x: 5, y: 6 });
    expect(page().items.H1.x).toBeUndefined();
    // --all moves the pinned one too and lets the section fit its content (its stored size is only a minimum)
    const q = page();
    q.items.Onboarding = { ...q.items.Onboarding, w: 9000, h: 9000 };
    fs.writeFileSync(path.join(pdir, 'pages', 'truth.json'), JSON.stringify(q));
    expect((await run('layout', ['Onboarding', '--all'], pdir)).text).toBe(
      'Re-laid out 1 item; the section fits its content again',
    );
    expect(page().items.H3.x).toBeUndefined();
    expect(page().items.Onboarding.w).toBeUndefined();
    expect(page().items.Onboarding.h).toBeUndefined();
  });

  it("render uses the screen's own frame and captures tall screens whole", async () => {
    // regressions from the design eval: <meta name="adl:frame"> was ignored, and renders stopped at 1200 px
    fs.writeFileSync(
      path.join(pdir, 'screens', 'W1.html'),
      '<!doctype html><meta name="adl:frame" content="600x700"><title>Wide</title><body style="margin:0;background:#123">wide</body>',
    );
    fs.writeFileSync(
      path.join(pdir, 'screens', 'W2.html'),
      '<!doctype html><meta name="adl:frame" content="390xauto"><title>Long</title><body style="margin:0"><div style="height:2000px;background:linear-gradient(red,blue)">long</div></body>',
    );
    const r = await run('render', ['W1', 'W2'], pdir);
    expect(r.ok).toBe(true);
    const { PNG } = await import('pngjs');
    const size = (id: string) => {
      const png = PNG.sync.read(fs.readFileSync(path.join(pdir, '.adl', 'renders', `${id}.png`)));
      return [png.width, png.height];
    };
    expect(size('W1')).toEqual([600, 700]);
    expect(size('W2')).toEqual([390, 2000]);
  }, 60000);

  it('render paints the bottom of a screen taller than the window, not a copy of its top', async () => {
    // regressions from tall screens on a real canvas: the window grew after the screen was drawn, and the last ~87 px
    // showed the screen's top again (390x1263, 390x1601); one capture beyond the window came out as repeated,
    // zoomed-in tiles (390x1333 at 2x). Blue top, green middle, red bottom, checked at both edges
    const band = (h: number, frame: string) =>
      `<!doctype html><meta name="adl:frame" content="${frame}"><title>Bands</title><body style="margin:0">` +
      `<div style="position:relative;width:390px;height:${h}px;background:#777">` +
      '<div style="position:absolute;left:0;top:0;width:390px;height:120px;background:#2156e0"></div>' +
      `<div style="position:absolute;left:0;top:${Math.round(h / 2) - 60}px;width:390px;height:120px;background:#21e05a"></div>` +
      '<div style="position:absolute;left:0;bottom:0;width:390px;height:120px;background:#e0212b"></div></div></body>';
    const cases = [
      ['B1', 1263, '390x1263'],
      ['B2', 1333, '390x1333'],
      ['B3', 1601, '390x1601'],
      ['B4', 2500, '390xauto'],
    ] as const;
    for (const [id, h, frame] of cases) fs.writeFileSync(path.join(pdir, 'screens', `${id}.html`), band(h, frame));
    expect((await run('render', [...cases.map((c) => c[0]), '--scale', '2'], pdir)).ok).toBe(true);
    const { PNG } = await import('pngjs');
    for (const [id, h] of cases) {
      const png = PNG.sync.read(fs.readFileSync(path.join(pdir, '.adl', 'renders', `${id}.png`)));
      expect([png.width, png.height], id).toEqual([780, h * 2]);
      const rgb = (x: number, y: number) => {
        const i = (y * png.width + x) * 4;
        return [png.data[i], png.data[i + 1], png.data[i + 2]];
      };
      for (const x of [6, 390, 774]) {
        expect(rgb(x, 20), `${id} top x=${x}`).toEqual([0x21, 0x56, 0xe0]);
        expect(rgb(x, h), `${id} middle x=${x}`).toEqual([0x21, 0xe0, 0x5a]);
        for (const y of [png.height - 4, png.height - 200])
          expect(rgb(x, y), `${id} x=${x} y=${y}`).toEqual([0xe0, 0x21, 0x2b]);
      }
    }
  }, 60000);

  it('a big page picture is taken in tiles: far corners are painted, not left grey', async () => {
    // regression: one giant screenshot left most of a large page unpainted (seen on a real 166-screen page at
    // --max-width 4000; Chrome rasters only part of it). Two screens far apart: both corners must be painted.
    for (const [id, c] of [
      ['F1', '#e0212b'],
      ['F2', '#2156e0'],
    ])
      fs.writeFileSync(
        path.join(pdir, 'screens', `${id}.html`),
        `<!doctype html><meta name="adl:frame" content="400x400"><title>${id}</title><body style="margin:0"><div style="width:400px;height:400px;background:${c}"></div></body>`,
      );
    expect((await run('add', ['F1', 'F2'], pdir)).ok).toBe(true);
    expect(
      (
        await run(
          'patch',
          ['truth', JSON.stringify({ items: { F1: { x: 0, y: 4000 }, F2: { x: 6000, y: 7000 } } })],
          pdir,
        )
      ).ok,
    ).toBe(true);
    const r = await run('render', ['--canvas', '--max-width', '5000'], pdir);
    expect(r.ok).toBe(true);
    expect((r as { data?: { tiles?: number } }).data?.tiles).toBeGreaterThan(4);
    const { PNG } = await import('pngjs');
    const png = PNG.sync.read(fs.readFileSync(path.join(pdir, '.adl', 'renders', 'truth-canvas.png')));
    const count = (rgb: [number, number, number]) => {
      let n = 0;
      for (let i = 0; i < png.data.length; i += 4)
        if (
          Math.abs(png.data[i]! - rgb[0]) + Math.abs(png.data[i + 1]! - rgb[1]) + Math.abs(png.data[i + 2]! - rgb[2]) <
          24
        )
          n++;
      return n;
    };
    expect(png.width).toBeGreaterThan(9000);
    // both screens are about 400 × 400 at the picture's zoom (×2): far more than 50 000 pixels each
    expect(count([0xe0, 0x21, 0x2b])).toBeGreaterThan(50000);
    expect(count([0x21, 0x56, 0xe0])).toBeGreaterThan(50000);
    expect((await run('remove', ['F1', 'F2'], pdir)).ok).toBe(true);
  }, 180000);

  it('validate points at colours written by hand instead of tokens', async () => {
    fs.writeFileSync(
      path.join(pdir, 'screens', 'L1.html'),
      '<!doctype html><title>Lint</title><link rel="stylesheet" href="../styles/tokens.css"><style>.a{color:#3B6CF6}.b{background:#123456}svg path{fill:#ff0000}</style><body><p class="a" style="border-color:#abcdef">x</p></body>',
    );
    fs.writeFileSync(path.join(pdir, 'screens', 'L2.html'), '<!doctype html><title>No tokens</title><body>x</body>');
    const v = await run('validate', [], pdir);
    expect(v.text).toContain('L1: use the tokens: #3b6cf6 is var(--color-accent)');
    expect(v.text).toContain('L2: does not link ../styles/tokens.css');
    expect(v.text).not.toContain('#ff0000'); // illustration fills are fine
  });

  it('activity summaries name who did it', async () => {
    const r1 = await run('status', ['H3', 'needs-fix', '--banner', 'by hand', '--actor', 'human'], pdir);
    const r2 = await run('status', ['H3', 'changed'], pdir);
    expect([r1.text, r2.text]).toEqual(['H3 → Needs a fix: “by hand”', 'H3 → Changed']);
    const log = fs
      .readFileSync(path.join(pdir, '.adl', 'activity.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const [a, b] = log.slice(-2);
    expect([a.actor, a.summary]).toEqual(['human', 'You set H3 to Needs a fix']);
    expect([b.actor, b.summary]).toEqual(['agent', 'Claude set H3 to Changed']);
  });

  it('errors are plain sentences', async () => {
    expect((await run('add', ['bad id!'], pdir)).text).toContain('not a valid id');
    expect((await run('link', ['H1', 'NOPE'], pdir)).text).toContain('"NOPE" is not on page "truth"');
    expect((await run('show', ['NOPE'], pdir)).text).toContain('"NOPE" is on no page');
    expect((await run('init', ['Habit', 'app'], ws)).text).toContain('already');
  });
});

describe('commands through a running server', () => {
  let ws: string;
  let s: RunningServer;
  beforeAll(async () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'adl-cmds-'));
    s = await startServer({ workspace: ws, port: 4640, quiet: true });
  });
  afterAll(async () => {
    await s?.close();
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('init through the server makes the project appear at once', async () => {
    const r = await run('init', ['Bakery'], ws, s);
    expect(r.ok).toBe(true);
    expect(s.service.projects.has('bakery')).toBe(true);
  });

  it('changes are transactions the canvas receives, with the agent as actor', async () => {
    const seen: { actor: string }[] = [];
    s.service.on('tx', (e) => seen.push(e));
    expect((await run('add', ['B1', 'B2', '--chain', '--label', 'Order'], ws, s)).ok).toBe(true);
    expect(seen.length).toBe(1);
    expect(seen[0]!.actor).toBe('agent');
    expect(s.service.projects.get('bakery')!.docs.pages.truth!.arrows['B1>B2']).toBeDefined();
  });

  it('a command right after a screen edit sees the edit (the server catches up with the disk first)', async () => {
    // regression from a real canvas: a chip was removed from the file, and `adl render` straight after drew the
    // screen with the chip (the CLI hands commands to the server, whose watcher had not seen the edit yet)
    const st = s.service.projects.get('bakery')!;
    const file = path.join(st.dir, 'screens', 'B1.html');
    const page = (title: string) => `<!doctype html><title>${title}</title><body>${title}</body>`;
    fs.writeFileSync(file, page('Old title'));
    await expect.poll(() => s.service.projects.get('bakery')!.screens.get('B1')?.compiled?.title).toBe('Old title');
    const show = async () => {
      const r = await fetch(`${s.url}/api/cmd/show`, {
        method: 'POST',
        headers: { 'x-adl-token': s.token, 'content-type': 'application/json' },
        body: JSON.stringify({ args: ['B1'] }),
      });
      return ((await r.json()) as { text: string }).text;
    };
    fs.writeFileSync(file, page('New title'));
    expect(await show()).toContain('“New title”');
    // a new screen file is there at once too
    fs.writeFileSync(path.join(st.dir, 'screens', 'B9.html'), page('Brand new'));
    const r = await fetch(`${s.url}/api/cmd/add`, {
      method: 'POST',
      headers: { 'x-adl-token': s.token, 'content-type': 'application/json' },
      body: JSON.stringify({ args: ['B9'] }),
    });
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
    expect(s.service.projects.get('bakery')!.screens.get('B9')?.compiled?.title).toBe('Brand new');
  });

  it('context tells the agent what the person changed since its last look, then marks it seen', async () => {
    const st = s.service.projects.get('bakery')!;
    await run('context', [], ws, s);
    const ops = setStatus(st.docs, 'truth', ['B2'], 'needs-fix', 'price is missing');
    s.service.apply('bakery', ops, { actor: 'human', summary: 'Approve' });
    s.service.apply(
      'bakery',
      [
        { doc: pageKey('truth'), path: ['items', 'B1', 'x'], value: 40 },
        { doc: pageKey('truth'), path: ['items', 'B1', 'y'], value: 0 },
      ],
      { actor: 'human', summary: 'Moved B1' },
    );
    const peek = await run('context', ['--peek'], ws, s);
    expect(peek.text).toContain('Changed by the person since your last look');
    expect(peek.text).toContain('B2: New → Needs a fix: “price is missing”');
    expect(peek.text).toContain('moved B1');
    expect(peek.text).toContain('To do (1)');
    const c = await run('context', ['--hook'], ws, s);
    expect(c.text).toContain('B2: New → Needs a fix');
    expect(s.presence.seen?.bakery).toBeDefined();
    const again = await run('context', ['--hook'], ws, s);
    expect(again.text).not.toContain('Changed by the person');
  });

  it('the hook script posts presence and prints the context for a prompt', async () => {
    const st = s.service.projects.get('bakery')!;
    s.service.apply('bakery', setStatus(st.docs, 'truth', ['B1'], 'missing', 'add a sold-out state'), {
      actor: 'human',
      summary: 'Status',
    });
    // async: the server runs in this process and must keep answering while the hook waits for it
    const hook = (event: string, input: object) =>
      new Promise<{ status: number | null; stdout: string }>((resolve) => {
        const p = spawn(process.execPath, [path.join(repo, 'hooks', 'adl-hook.mjs'), event]);
        let stdout = '';
        p.stdout.on('data', (d) => {
          stdout += d;
        });
        p.on('close', (status) => resolve({ status, stdout }));
        p.stdin.end(JSON.stringify({ cwd: st.dir, session_id: 'sess-1', ...input }));
      });
    const start = await hook('SessionStart', { source: 'startup' });
    expect(start.status).toBe(0);
    expect(start.stdout).toContain(`Agent Design Lab is running: http://localhost:${s.port}`);
    expect(s.presence.state).toBe('connected');
    const prompt = await hook('UserPromptSubmit', { prompt: 'fix it' });
    expect(prompt.status).toBe(0);
    expect(prompt.stdout).toContain('B1: New → Missing: “add a sold-out state”');
    const write = await hook('PreToolUse', {
      tool_name: 'Write',
      tool_input: { file_path: path.join(st.dir, 'screens', 'B1.html') },
    });
    expect(write.status).toBe(0);
    expect(s.presence).toMatchObject({ state: 'writing', text: 'writing B1.html' });
    await hook('Stop', {});
    expect(s.presence.state).toBe('idle');
  });

  it('several agents: each is told about the person’s changes, and the pill lists them all', async () => {
    const st = s.service.projects.get('bakery')!;
    const post = (body: object) =>
      fetch(`http://127.0.0.1:${s.port}/api/agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-adl-token': s.token },
        body: JSON.stringify(body),
      });
    // both sessions start (the SessionStart hook peeks), then the person changes something
    await run('context', ['--hook', '--peek', '--session', 'A'], ws, s);
    await run('context', ['--hook', '--peek', '--session', 'B'], ws, s);
    s.service.apply('bakery', setStatus(st.docs, 'truth', ['B2'], 'to-decide', 'two colours?'), {
      actor: 'human',
      summary: 'Status',
    });
    const a = await run('context', ['--hook', '--session', 'A'], ws, s);
    expect(a.text).toContain('B2: Needs a fix → To decide');
    // agent A looked; agent B still gets the same change on its next prompt
    const b = await run('context', ['--hook', '--session', 'B'], ws, s);
    expect(b.text).toContain('B2: Needs a fix → To decide');
    const again = await run('context', ['--hook', '--session', 'B'], ws, s);
    expect(again.text).not.toContain('B2:');
    await post({ session: 'A', name: 'Checkout', state: 'writing', text: 'writing B3.html' });
    await post({ session: 'B', name: 'Copy', state: 'running', text: 'running adl render' });
    const mine = () => (s.presence.agents ?? []).filter((x) => x.session === 'A' || x.session === 'B');
    expect(mine().map((x) => x.name)).toEqual(['Copy', 'Checkout']);
    await post({ session: 'B', state: 'none' });
    expect(mine().map((x) => x.session)).toEqual(['A']);
  });

  it('the hook tells the server which agent writes a file', async () => {
    const st = s.service.projects.get('bakery')!;
    const file = path.join(st.dir, 'pages', 'truth.json');
    const hook = spawnSync(process.execPath, [path.join(repo, 'hooks', 'adl-hook.mjs'), 'PreToolUse'], {
      input: JSON.stringify({ cwd: st.dir, session_id: 'sess-W', tool_name: 'Write', tool_input: { file_path: file } }),
      encoding: 'utf8',
    });
    expect(hook.status).toBe(0);
  });

  it('the hook stays silent and exits 0 when nothing runs for the folder', () => {
    // a fresh folder: the temp dir itself holds other tests' running workspaces
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'adl-nohook-'));
    const r = spawnSync(process.execPath, [path.join(repo, 'hooks', 'adl-hook.mjs'), 'UserPromptSubmit'], {
      input: JSON.stringify({ cwd: empty }),
      encoding: 'utf8',
    });
    fs.rmSync(empty, { recursive: true, force: true });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});

describe('workspace paths', () => {
  it('a workspace reached through a symlink resolves to its real path (finds the same running server)', async () => {
    // regression: macOS /tmp is a symlink to /private/tmp; the CLI missed the server registered under the other name
    const { resolveWorkspace } = await import('../../src/node/paths.ts');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adl-real-'));
    const link = `${dir}-link`;
    fs.symlinkSync(dir, link);
    expect(resolveWorkspace({ workspace: link }).root).toBe(fs.realpathSync(dir));
    expect(resolveWorkspace({ cwd: link }).root).toBe(fs.realpathSync(dir));
    fs.rmSync(link);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('setup', () => {
  it('adds a section to CLAUDE.md once and replaces it on later runs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adl-setup-'));
    const f = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(f, '# My app\n\nOur rules.\n');
    expect(upsertSection(f, '<!-- agent-design-lab:start -->\nA\n<!-- agent-design-lab:end -->')).toBe('updated');
    expect(upsertSection(f, '<!-- agent-design-lab:start -->\nB\n<!-- agent-design-lab:end -->')).toBe('updated');
    const text = fs.readFileSync(f, 'utf8');
    expect(text).toBe('# My app\n\nOur rules.\n\n<!-- agent-design-lab:start -->\nB\n<!-- agent-design-lab:end -->\n');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('merges hooks into existing settings without touching anything else', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adl-setup-'));
    const f = path.join(dir, 'settings.json');
    fs.writeFileSync(
      f,
      JSON.stringify({
        permissions: { allow: ['Bash(ls)'] },
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
      }),
    );
    expect(mergeHooks(f, (e) => `node x/adl-hook.mjs ${e}`)).toBe('updated');
    expect(mergeHooks(f, (e) => `node x/adl-hook.mjs ${e}`)).toBe('unchanged');
    const s = readJson(f);
    expect(s.permissions).toEqual({ allow: ['Bash(ls)'] });
    expect(s.hooks.Stop).toHaveLength(2);
    expect(s.hooks.Stop[0].hooks[0].command).toBe('say done');
    expect(s.hooks.PreToolUse[0].matcher).toBe('Write|Edit|MultiEdit|Bash');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sets up a folder end to end', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adl-setup-'));
    const r = await run('setup', [], dir);
    expect(r.ok).toBe(true);
    for (const f of [
      'adl.json',
      'design',
      '.claude/skills/agent-design-lab/SKILL.md',
      '.claude/hooks/adl-hook.mjs',
      '.claude/settings.json',
      'CLAUDE.md',
      'AGENTS.md',
      '.gitignore',
    ])
      expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toContain('Designs for this project live in `design`');
    const again = await run('setup', [], dir);
    expect(again.text).toContain('CLAUDE.md (unchanged)');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('copy without a server', () => {
  it('copies the built-in example into the workspace under a new name', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'adl-copy-'));
    const r = await run('copy', ['example-still', 'My meditation app'], ws);
    expect(r).toMatchObject({ ok: true, data: { id: 'my-meditation-app' } });
    expect(readJson(path.join(ws, 'my-meditation-app', 'project.json')).name).toBe('My meditation app');
    expect(fs.existsSync(path.join(ws, 'my-meditation-app', 'screens', 'S1.html'))).toBe(true);
    expect((await run('copy', ['nope'], ws)).text).toContain('No project "nope"');
    fs.rmSync(ws, { recursive: true, force: true });
  });
});
