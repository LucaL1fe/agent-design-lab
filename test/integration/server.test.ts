import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { newPageDoc, newProjectDoc, setStatus, stringifyPage, stringifyProject } from '../../src/core/index.ts';
import { resolveWorkspace } from '../../src/node/paths.ts';
import { type RunningServer, startServer } from '../../src/node/server/server.ts';
import { SnapshotService } from '../../src/node/snapshot/service.ts';
import { WorkspaceService } from '../../src/node/store/workspace.ts';
import { packageRoot } from '../../src/node/version.ts';

let s: RunningServer;
let root: string;
let pdir: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'adl-srv-'));
  pdir = path.join(root, 'demo');
  fs.mkdirSync(path.join(pdir, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(pdir, 'screens'), { recursive: true });
  fs.mkdirSync(path.join(pdir, 'assets'), { recursive: true });
  fs.writeFileSync(
    path.join(pdir, 'project.json'),
    stringifyProject({ ...newProjectDoc('Demo'), frame: '390x844' } as never),
  );
  const page = newPageDoc('Source of truth');
  page.items = {
    A: { kind: 'screen', x: 0, y: 0, status: 'new' },
    W: { kind: 'screen', x: 700, y: 0, frame: 'web-mobile' },
  };
  fs.writeFileSync(path.join(pdir, 'pages', 'truth.json'), stringifyPage(page as never));
  fs.writeFileSync(
    path.join(pdir, 'screens', 'A.html'),
    '<!doctype html><html><head><title>A</title><style>html{background:#123456}h1{color:#fff;animation:spin 2s infinite}@keyframes spin{to{transform:rotate(1turn)}}</style></head><body><h1 data-adl-anchor="title">Hello</h1></body></html>',
  );
  fs.writeFileSync(
    path.join(pdir, 'screens', 'W.html'),
    '<!doctype html><html><head><title>Web</title></head><body style="margin:0"><div style="height:1700px;background:linear-gradient(red,blue)">long page</div></body></html>',
  );
  s = await startServer({ workspace: root, port: 4600, quiet: true });
  const snaps = new SnapshotService(s);
  s.snapshots = snaps;
  await snaps.start();
}, 60000);

afterAll(async () => {
  await s?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('server', () => {
  it('answers only on localhost names', async () => {
    const ok = await fetch(`http://127.0.0.1:${s.port}/api/health`);
    expect(ok.status).toBe(200);
    const http = await import('node:http');
    const code = await new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port: s.port, path: '/api/workspace', headers: { host: 'evil.example' } }, (res) =>
        resolve(res.statusCode ?? 0),
      );
    });
    expect(code).toBe(403);
  });
  it('lists projects and serves state, compiled screens and sheets', async () => {
    const w = await (await fetch(`${s.url}/api/workspace`)).json();
    expect(w.projects.map((p: { id: string }) => p.id)).toEqual(['demo', 'example-still']);
    const st = await (await fetch(`${s.url}/api/p/demo/state`)).json();
    expect(Object.keys(st.screens).sort()).toEqual(['A', 'W']);
    const c = await (await fetch(`${s.url}/api/p/demo/c/${st.screens.A.hash}`)).json();
    expect(c.body).toContain('Hello');
  });
  it('refuses changes without the token', async () => {
    const r = await fetch(`${s.url}/api/p/demo/tx`, { method: 'POST', body: '{"ops":[]}' });
    expect(r.status).toBe(401);
  });
  it('applies WebSocket transactions and broadcasts them', async () => {
    const a = new WebSocket(`ws://localhost:${s.port}/ws?token=${s.token}`, {
      headers: { origin: `http://localhost:${s.port}` },
    });
    const b = new WebSocket(`ws://localhost:${s.port}/ws?token=${s.token}`);
    await Promise.all([new Promise((r) => a.once('open', r)), new Promise((r) => b.once('open', r))]);
    const got = new Promise<{ actor: string; ops: unknown[] }>((resolve) =>
      b.on('message', (d) => {
        const m = JSON.parse(String(d));
        if (m.t === 'tx') resolve(m);
      }),
    );
    a.send(JSON.stringify({ t: 'hello', clientId: 'a' }));
    const st = s.service.projects.get('demo')!;
    a.send(
      JSON.stringify({
        t: 'tx',
        pid: 'demo',
        ops: setStatus(st.docs, 'truth', ['A'], 'approved'),
        clientSeq: 1,
        summary: 'Approved A',
      }),
    );
    const m = await got;
    expect(m.actor).toBe('human');
    expect(st.docs.pages.truth!.items.A).toMatchObject({ status: 'approved' });
    a.close();
    b.close();
  });
  it('rejects WebSocket connections without the token', async () => {
    const c = new WebSocket(`ws://localhost:${s.port}/ws?token=nope`);
    const err = await new Promise((r) => {
      c.on('error', () => r('error'));
      c.on('open', () => r('open'));
    });
    expect(err).toBe('error');
  });
  it('renders snapshots with the real browser, including auto-height pages', async () => {
    await s.snapshots!.idle(60000);
    const snaps = s.snapshots!.snapsFor('demo');
    const keys = Object.keys(snaps);
    expect(keys.some((k) => k.endsWith('@390x844'))).toBe(true);
    const web = Object.entries(snaps).find(([k]) => k.endsWith('@390xauto'))![1];
    expect(web.h).toBeGreaterThanOrEqual(1700);
    const img = await fetch(`${s.url}${web.url}-256.webp`);
    expect(img.headers.get('content-type')).toBe('image/webp');
    const a = Object.entries(snaps).find(([k]) => k.endsWith('@390x844'))![1];
    expect(a.avg).toMatch(/^rgb\(1[0-9]|^rgb\(/);
  }, 90000);
  it('re-renders a screen after its file changes', async () => {
    const before = Object.keys(s.snapshots!.snapsFor('demo')).length;
    const st = s.service.projects.get('demo')!;
    const oldHash = st.screens.get('A')!.compiled!.hash;
    fs.writeFileSync(
      path.join(pdir, 'screens', 'A.html'),
      '<!doctype html><html><head><style>html{background:#654321}</style></head><body><h1>Changed</h1></body></html>',
    );
    const t0 = Date.now();
    while (st.screens.get('A')!.compiled!.hash === oldHash && Date.now() - t0 < 5000)
      await new Promise((r) => setTimeout(r, 30));
    const writeToCompile = Date.now() - t0;
    expect(writeToCompile).toBeLessThan(1500);
    await new Promise((r) => setTimeout(r, 100));
    await s.snapshots!.idle(30000);
    const newHash = st.screens.get('A')!.compiled!.hash;
    expect(Object.keys(s.snapshots!.snapsFor('demo')).some((k) => k.startsWith(newHash))).toBe(true);
    expect(Object.keys(s.snapshots!.snapsFor('demo')).length).toBeGreaterThanOrEqual(before);
    // regression (30-min chaos run): a tab that saw the old version still loads it while the new one arrives
    const old = await fetch(`http://127.0.0.1:${s.port}/api/p/demo/c/${oldHash}`);
    expect(old.status).toBe(200);
    expect(((await old.json()) as { hash: string }).hash).toBe(oldHash);
    expect((await fetch(`http://127.0.0.1:${s.port}/api/p/demo/c/0000000000000000`)).status).toBe(404);
  }, 60000);
});

describe('built-in example', () => {
  const stillDir = fs.realpathSync(path.join(packageRoot(), 'examples', 'still'));
  const cmd = async (name: string, args: string[]) => {
    const r = await fetch(`${s.url}/api/cmd/${name}`, {
      method: 'POST',
      headers: { 'x-adl-token': s.token, 'content-type': 'application/json' },
      body: JSON.stringify({ args }),
    });
    return (await r.json()) as { ok: boolean; text: string; data?: { id: string } };
  };
  const workspace = async () =>
    ((await (await fetch(`${s.url}/api/workspace`)).json()) as { projects: { id: string; example?: boolean }[] })
      .projects;

  it('every workspace lists it last, marked as an example, with its own state outside the package', async () => {
    const ex = (await workspace()).at(-1)!;
    expect(ex).toMatchObject({ id: 'example-still', name: 'Still', example: true });
    const st = await (await fetch(`${s.url}/api/p/example-still/state`)).json();
    expect(st.example).toBe(true);
    expect(Object.keys(st.screens).length).toBeGreaterThan(10);
    // caches, activity and snapshots go to the workspace, never into the package
    expect(s.service.projects.get('example-still')!.adl).toBe(
      path.join(fs.realpathSync(root), '.adl', 'example', 'example-still'),
    );
  });

  it('is read-only: changes from the app and from commands are refused, its files stay as they are', async () => {
    const file = path.join(stillDir, 'pages', 'truth.json');
    const before = fs.readFileSync(file, 'utf8');
    const r = await fetch(`${s.url}/api/p/example-still/tx`, {
      method: 'POST',
      headers: { 'x-adl-token': s.token, 'content-type': 'application/json' },
      body: JSON.stringify({ ops: [{ doc: 'page:truth', path: ['name'], value: 'Mine' }] }),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toContain('adl copy example-still');
    const note = await cmd('note', ['hello', '--on', 'S1', '--project', 'example-still']);
    expect(note.ok).toBe(false);
    expect(note.text).toContain('adl copy example-still');
    expect((await cmd('show', ['S1', '--project', 'example-still'])).ok).toBe(true); // reading is fine
    await s.service.flush();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('commands never pick the example on their own', async () => {
    // the person has one project of their own, so a command without --project goes there
    const r = await cmd('show', ['A']);
    expect(r.ok).toBe(true);
    expect(r.text).not.toContain('Several projects');
  });

  it('`adl copy` makes an editable copy in the workspace (a second copy gets its own folder)', async () => {
    const r = await cmd('copy', ['example-still']);
    expect(r).toMatchObject({ ok: true, data: { id: 'still' } });
    expect(fs.existsSync(path.join(root, 'still', 'project.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'still', '.adl'))).toBe(false);
    const ids = (await workspace()).map((p) => p.id);
    expect(ids.indexOf('still')).toBeLessThan(ids.indexOf('example-still'));
    expect((await cmd('note', ['mine now', '--on', 'S1', '--project', 'still'])).ok).toBe(true);
    expect((await cmd('copy', ['example-still'])).data?.id).toBe('still-2');
  });

  it('is not added twice when the workspace is the examples folder itself', async () => {
    const svc = new WorkspaceService(resolveWorkspace({ workspace: path.dirname(stillDir) }), { examples: true });
    await svc.load();
    expect([...svc.projects.values()].filter((p) => p.dir === stillDir).map((p) => p.id)).toEqual(['still']);
    svc.close();
  });
});
