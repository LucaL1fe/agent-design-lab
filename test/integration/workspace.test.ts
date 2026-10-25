import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyOps,
  moveItems,
  newPageDoc,
  newProjectDoc,
  setStatus,
  stringifyPage,
  stringifyProject,
} from '../../src/core/index.ts';
import { resolveWorkspace } from '../../src/node/paths.ts';
import { WorkspaceService } from '../../src/node/store/workspace.ts';

const dirs: string[] = [];
const services: WorkspaceService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adl-ws-'));
  dirs.push(root);
  const pdir = path.join(root, 'demo');
  fs.mkdirSync(path.join(pdir, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(pdir, 'screens'), { recursive: true });
  fs.mkdirSync(path.join(pdir, 'styles'), { recursive: true });
  const project = newProjectDoc('Demo');
  fs.writeFileSync(path.join(pdir, 'project.json'), stringifyProject(project as never));
  const page = newPageDoc('Source of truth');
  page.items = { A: { kind: 'screen', x: 0, y: 0, status: 'new' }, B: { kind: 'screen', x: 700, y: 0, status: 'new' } };
  page.arrows = { 'A>B': { from: 'A', to: 'B', label: 'next' } };
  fs.writeFileSync(path.join(pdir, 'pages', 'truth.json'), stringifyPage(page as never));
  fs.writeFileSync(path.join(pdir, 'styles', 'app.css'), 'body{margin:0;color:#111}');
  for (const id of ['A', 'B'])
    fs.writeFileSync(
      path.join(pdir, 'screens', `${id}.html`),
      `<!doctype html><html><head><title>${id} title</title><link rel="stylesheet" href="../styles/app.css"></head><body><h1>Screen ${id}</h1></body></html>`,
    );
  return { root, pdir };
}

async function service(root: string) {
  const s = new WorkspaceService(resolveWorkspace({ workspace: root }));
  s.writeDelay = 20;
  s.minWriteGap = 0;
  services.push(s);
  await s.load();
  s.watch();
  return s;
}

// watcher events usually arrive at once; under load the 5 s reconcile scan is the safety net, so wait past it
async function until(fn: () => boolean, ms = 8000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('WorkspaceService', () => {
  it('loads projects, pages and compiled screens', async () => {
    const { root } = fixture();
    const s = await service(root);
    const st = s.projects.get('demo')!;
    expect(st.docs.project.name).toBe('Demo');
    expect(Object.keys(st.docs.pages.truth!.items)).toEqual(['A', 'B']);
    expect(st.screens.get('A')?.compiled?.title).toBe('A title');
    expect(st.screens.get('A')?.compiled?.sheets).toHaveLength(1);
    expect(st.problems.filter((p) => p.level === 'error')).toEqual([]);
  });

  it("applies a person's change and writes a canonical file", async () => {
    const { root, pdir } = fixture();
    const s = await service(root);
    const st = s.projects.get('demo')!;
    const r = s.apply('demo', moveItems(st.docs, 'truth', [{ id: 'A', x: 10, y: 20 }], 'human'), {
      actor: 'human',
      summary: 'moved A',
    });
    expect(r.ok).toBe(true);
    expect(r.revs['page:truth']).toBe(1);
    await s.flush();
    const text = fs.readFileSync(path.join(pdir, 'pages', 'truth.json'), 'utf8');
    expect(text).toContain('"rev": 1');
    expect(text).toContain('"A": {"kind": "screen", "x": 10, "y": 20, "status": "new", "pinned": true}');
  });

  it("merges a stale agent write without losing the person's drag", async () => {
    const { root, pdir } = fixture();
    const s = await service(root);
    const st = s.projects.get('demo')!;
    const file = path.join(pdir, 'pages', 'truth.json');
    const stale = JSON.parse(fs.readFileSync(file, 'utf8')); // rev 0, as the agent read it
    s.apply('demo', moveItems(st.docs, 'truth', [{ id: 'A', x: 10, y: 20 }], 'human'), { actor: 'human' });
    await s.flush();
    // agent edits its stale copy: approves B and adds C
    const agentDocs = applyOps(
      { project: st.docs.project, pages: { truth: stale } },
      setStatus({ project: st.docs.project, pages: { truth: stale } }, 'truth', ['B'], 'approved'),
    ).docs;
    const theirs = agentDocs.pages.truth!;
    theirs.items.C = { kind: 'screen', status: 'new' };
    const events: string[] = [];
    s.on('tx', (e) => events.push(e.actor));
    fs.writeFileSync(file, JSON.stringify(theirs, null, 2));
    await until(() => (st.docs.pages.truth!.items as Record<string, unknown>).C !== undefined);
    const items = st.docs.pages.truth!.items;
    expect(items.A).toMatchObject({ x: 10, y: 20, pinned: true });
    expect(items.B).toMatchObject({ status: 'approved' });
    expect(events).toContain('agent');
  });

  it('keeps the last good version when an agent writes broken JSON, then picks up the fix', async () => {
    const { root, pdir } = fixture();
    const s = await service(root);
    const st = s.projects.get('demo')!;
    const file = path.join(pdir, 'pages', 'truth.json');
    const good = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, good.replace('"next"', '"next",'));
    await until(() => st.problems.some((p) => p.code === 'invalid-file'), 6000);
    expect(st.docs.pages.truth!.arrows['A>B']!.label).toBe('next');
    fs.writeFileSync(file, good.replace('"next"', '"go on"'));
    await until(() => st.docs.pages.truth!.arrows['A>B']!.label === 'go on', 6000);
    expect(st.problems.some((p) => p.code === 'invalid-file')).toBe(false);
  });

  it('recompiles screens when their HTML or a stylesheet changes', async () => {
    const { root, pdir } = fixture();
    const s = await service(root);
    const st = s.projects.get('demo')!;
    const changed: string[] = [];
    s.on('screens', (e) => changed.push(...e.changed.map((c: { id: string }) => c.id)));
    fs.writeFileSync(path.join(pdir, 'screens', 'C.html'), '<!doctype html><title>C</title><body>new</body>');
    await until(() => changed.includes('C'));
    expect(st.screens.get('C')?.compiled?.title).toBe('C');
    changed.length = 0;
    fs.writeFileSync(path.join(pdir, 'styles', 'app.css'), 'body{margin:0;color:red}');
    await until(() => changed.includes('A') && changed.includes('B'));
  });

  it('ignores its own writes', async () => {
    const { root } = fixture();
    const s = await service(root);
    const st = s.projects.get('demo')!;
    let agentTx = 0;
    s.on('tx', (e) => {
      if (e.actor === 'agent') agentTx++;
    });
    s.apply('demo', setStatus(st.docs, 'truth', ['A'], 'approved'), { actor: 'human' });
    await s.flush();
    await new Promise((r) => setTimeout(r, 400));
    expect(agentTx).toBe(0);
  });
});

describe('several agents at once', () => {
  it('two agents that read the same version and both write the page keep each other’s changes', async () => {
    const { root, pdir } = fixture();
    const s = await service(root);
    const st = s.projects.get('demo')!;
    const file = path.join(pdir, 'pages', 'truth.json');
    // both agents read the file before either writes (no hooks: the server does not know who writes)
    const a = JSON.parse(fs.readFileSync(file, 'utf8'));
    const b = JSON.parse(fs.readFileSync(file, 'utf8'));
    a.items.S20 = { kind: 'screen', status: 'new' };
    a.items.A.banner = 'from agent A';
    b.items.S30 = { kind: 'screen', status: 'new' };
    b.items.B.banner = 'from agent B';
    fs.writeFileSync(file, JSON.stringify(a, null, 2));
    await until(() => !!st.docs.pages.truth!.items.S20);
    fs.writeFileSync(file, JSON.stringify(b, null, 2));
    await until(() => !!st.docs.pages.truth!.items.S30);
    const items = st.docs.pages.truth!.items as Record<string, { banner?: string }>;
    expect(Object.keys(items).sort()).toEqual(['A', 'B', 'S20', 'S30']);
    expect(items.A!.banner).toBe('from agent A');
    expect(items.B!.banner).toBe('from agent B');
  });

  it('with the hooks reporting who writes: agents keep each other’s work and each builds on its own last write', async () => {
    const { root, pdir } = fixture();
    const s = await service(root);
    const st = s.projects.get('demo')!;
    const file = path.join(pdir, 'pages', 'truth.json');
    const b = JSON.parse(fs.readFileSync(file, 'utf8')); // agent B reads now, writes much later
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.items.S20 = { kind: 'screen' };
    s.noteWriter(file, 'session-A');
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    await until(() => !!st.docs.pages.truth!.items.S20);
    // the same agent removes what it just added (its file still has the rev it first read)
    delete doc.items.S20;
    doc.items.S21 = { kind: 'screen' };
    s.noteWriter(file, 'session-A');
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    await until(() => !!st.docs.pages.truth!.items.S21);
    expect(st.docs.pages.truth!.items.S20).toBeUndefined();
    // agent B, from its old read, adds S30: agent A's S21 stays
    b.items.S30 = { kind: 'screen' };
    s.noteWriter(file, 'session-B');
    fs.writeFileSync(file, JSON.stringify(b, null, 2));
    await until(() => !!st.docs.pages.truth!.items.S30);
    expect(Object.keys(st.docs.pages.truth!.items).sort()).toEqual(['A', 'B', 'S21', 'S30']);
  });
});
