// The build check from the terminal: adl build, adl capture, adl flow, and the file route serving captures in ranges.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commands, parseArgs } from '../../src/node/commands/registry.ts';
import '../../src/node/commands/index.ts';
import { byteRange, type RunningServer, startServer } from '../../src/node/server/server.ts';

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
// a 1×1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

describe('build commands without a server', () => {
  let ws: string;
  let pdir: string;
  const page = () => readJson(path.join(pdir, 'pages', 'truth.json'));
  beforeAll(async () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'adl-build-'));
    expect((await run('init', ['Notes'], ws)).ok).toBe(true);
    pdir = path.join(ws, 'notes');
    for (const id of ['home', 'edit', 'done'])
      expect((await run('screen', ['new', id, '--title', `The ${id} screen`], pdir)).ok).toBe(true);
    expect((await run('add', ['home', 'edit', 'done', '--chain', '--label', 'next', '--label', 'save'], pdir)).ok).toBe(
      true,
    );
    expect((await run('section', ['Writing', 'home', 'edit'], pdir)).ok).toBe(true);
    fs.writeFileSync(path.join(ws, 'shot.png'), PNG);
    fs.writeFileSync(path.join(ws, 'clip.mp4'), Buffer.alloc(64, 1));
  });
  afterAll(() => fs.rmSync(ws, { recursive: true, force: true }));

  it('build init puts every screen in the check, once', async () => {
    const r = await run('build', ['init'], pdir);
    expect(r.text).toBe('3 screens in the build check (not built)');
    expect(page().items.home.build).toMatchObject({ state: 'todo', by: 'agent' });
    expect((await run('build', ['init'], pdir)).text).toMatch(/already/);
  });

  it('sets states; deviating and blocked need a reason', async () => {
    expect((await run('build', ['home', 'matching'], pdir)).text).toBe('home → Matching');
    const no = await run('build', ['edit', 'deviating'], pdir);
    expect(no.ok).toBe(false);
    expect(no.text).toMatch(/needs a reason/);
    const yes = await run('build', ['edit', 'deviating', '--note', 'the title wraps'], pdir);
    expect(yes.text).toBe('edit → Deviating: “the title wraps”');
    // the reason stays when the state changes again without a note
    expect((await run('build', ['edit', 'blocked'], pdir)).ok).toBe(true);
    expect(page().items.edit.build).toMatchObject({ state: 'blocked', note: 'the title wraps' });
    expect((await run('build', ['home', 'shiny'], pdir)).text).toMatch(/not a build state/);
    expect((await run('build', ['nope', 'matching'], pdir)).text).toMatch(/not on page/);
  });

  it('build list shows progress per section and what is not matching yet', async () => {
    const r = await run('build', ['list'], pdir);
    expect(r.text).toContain('Screens: 1/3 matching');
    expect(r.text).toContain('Writing: 1/2 matching');
    expect(r.text).toContain('edit · Blocked · the title wraps');
    expect(r.text).not.toContain('home ·');
    const only = await run('build', ['list', '--state', 'matching'], pdir);
    expect(only.text).toContain('home · Matching');
  });

  it('capture copies the file into captures/ and records it per device and kind', async () => {
    process.env.ADL_NO_FFMPEG = '1';
    try {
      const r = await run('capture', ['home', 'phone', path.join(ws, 'shot.png'), '--label', 'first try'], pdir);
      expect(r.ok, r.text).toBe(true);
      const v = await run('capture', ['home', 'phone', path.join(ws, 'clip.mp4')], pdir);
      expect(v.ok, v.text).toBe(true);
    } finally {
      delete process.env.ADL_NO_FFMPEG;
    }
    const caps = page().items.home.build.captures;
    expect(caps).toHaveLength(2);
    expect(caps[0]).toMatchObject({
      device: 'phone',
      kind: 'image',
      src: 'captures/home/phone-image.png',
      label: 'first try',
    });
    expect(caps[1]).toMatchObject({ device: 'phone', kind: 'video', src: 'captures/home/phone-video.mp4' });
    expect(fs.existsSync(path.join(pdir, 'captures', 'home', 'phone-image.png'))).toBe(true);
    // the state stays as it was
    expect(page().items.home.build.state).toBe('matching');
  });

  it.runIf(hasFfmpeg)('with ffmpeg, a still gets a small picture (WebP when ffmpeg can write it)', async () => {
    const r = await run('capture', ['done', 'tablet', path.join(ws, 'shot.png')], pdir);
    expect(r.ok, r.text).toBe(true);
    const cap = page().items.done.build.captures[0];
    const webp = /\blibwebp\b/.test(spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout);
    expect(cap.src).toBe(webp ? 'captures/done/tablet-image.webp' : 'captures/done/tablet-image.png');
    expect(cap.thumb).toBe(webp ? 'captures/done/tablet-image.thumb.webp' : 'captures/done/tablet-image.thumb.jpg');
    expect(fs.existsSync(path.join(pdir, cap.thumb))).toBe(true);
  });

  it('capture refuses unknown files, devices and kinds', async () => {
    expect((await run('capture', ['home', 'phone', path.join(ws, 'none.png')], pdir)).text).toMatch(/No file/);
    fs.writeFileSync(path.join(ws, 'notes.txt'), 'x');
    expect((await run('capture', ['home', 'phone', path.join(ws, 'notes.txt')], pdir)).text).toMatch(
      /image .* or a video/,
    );
    expect((await run('capture', ['home', '../x', path.join(ws, 'shot.png')], pdir)).text).toMatch(/not a device/);
  });

  it('flows: add, set a state, capture a video, list, show, remove', async () => {
    expect((await run('flow', ['add', 'write', 'Write a note', 'home', 'edit', 'done'], pdir)).text).toBe(
      'flow write “Write a note”: home → edit → done',
    );
    expect((await run('flow', ['add', 'write', 'Again', 'home'], pdir)).text).toMatch(/exists/);
    expect((await run('flow', ['add', 'bad', 'Bad', 'home', 'ghost'], pdir)).text).toMatch(/not on page/);
    expect((await run('build', ['flow:write', 'deviating', '--note', 'save is slow'], pdir)).ok).toBe(true);
    process.env.ADL_NO_FFMPEG = '1';
    try {
      expect((await run('capture', ['flow:write', 'phone', path.join(ws, 'clip.mp4')], pdir)).ok).toBe(true);
    } finally {
      delete process.env.ADL_NO_FFMPEG;
    }
    const f = page().flows.write;
    expect(f).toMatchObject({ title: 'Write a note', steps: ['home', 'edit', 'done'], build: { state: 'deviating' } });
    expect(f.build.captures[0].src).toBe('captures/flow-write/phone-video.mp4');
    expect((await run('flow', ['list'], pdir)).text).toContain('write · Write a note · Deviating (save is slow)');
    expect((await run('build', ['list'], pdir)).text).toContain('flow:write · Deviating · save is slow');
    const show = await run('show', ['edit'], pdir);
    expect(show.text).toContain('build: Blocked · the title wraps');
    expect(show.text).toContain('in flows: write');
    // the steps keep their build state when the flow is changed
    expect((await run('flow', ['set', 'write', 'Write a note', 'home', 'done'], pdir)).ok).toBe(true);
    expect(page().flows.write.build.state).toBe('deviating');
    expect((await run('flow', ['rm', 'write'], pdir)).ok).toBe(true);
    expect(page().flows?.write).toBeUndefined();
  });

  it('build clear takes a screen out of the check', async () => {
    expect((await run('build', ['clear', 'done'], pdir)).ok).toBe(true);
    expect(page().items.done.build).toBeUndefined();
  });
});

describe('byte ranges for captures', () => {
  it('parses ranges', () => {
    expect(byteRange(undefined, 100)).toBeUndefined();
    expect(byteRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(byteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(byteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(byteRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
    expect(byteRange('bytes=100-', 100)).toBe('bad');
    expect(byteRange('bytes=0-1,5-6', 100)).toBeUndefined();
  });

  let s: RunningServer;
  let root: string;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'adl-range-'));
    expect((await run('init', ['Clips'], root)).ok).toBe(true);
    fs.mkdirSync(path.join(root, 'clips', 'captures'), { recursive: true });
    fs.writeFileSync(path.join(root, 'clips', 'captures', 'a.mp4'), Buffer.from('0123456789abcdef'));
    s = await startServer({ workspace: root, port: 4611, quiet: true });
  });
  afterAll(async () => {
    await s?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const get = (headers: Record<string, string>) =>
    new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.get(
        {
          host: '127.0.0.1',
          port: 4611,
          path: '/api/p/clips/f/captures/a.mp4',
          headers: { host: 'localhost:4611', ...headers },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => {
            body += c;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
        },
      );
      req.on('error', reject);
    });

  it('serves a range with 206 and the whole file with 200', async () => {
    const part = await get({ range: 'bytes=2-5' });
    expect(part.status).toBe(206);
    expect(part.body).toBe('2345');
    expect(part.headers['content-range']).toBe('bytes 2-5/16');
    expect(part.headers['content-type']).toBe('video/mp4');
    const all = await get({});
    expect(all.status).toBe(200);
    expect(all.body).toBe('0123456789abcdef');
    expect(all.headers['accept-ranges']).toBe('bytes');
    expect((await get({ range: 'bytes=40-' })).status).toBe(416);
  });
});
