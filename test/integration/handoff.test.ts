// The handoff loop: approved screens → handoff/ → a "built app" checked against it. The design's own HTML served as
// the app must pass; a build with a wrong colour and changed copy must fail with those reasons.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commands, parseArgs } from '../../src/node/commands/registry.ts';
import '../../src/node/commands/index.ts';
import { animationsOf, stringsOf } from '../../src/node/handoff/handoff.ts';
import { parseTokens, toDtcg } from '../../src/node/handoff/tokens.ts';

const run = async (cmd: string, argv: string[], cwd: string) => {
  try {
    return await commands.get(cmd)!.run(parseArgs(argv), { cwd });
  } catch (e) {
    return { ok: false, text: (e as Error).message, data: undefined };
  }
};

const screen = (title: string, body: string, color = 'var(--color-accent)') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="../styles/tokens.css"><link rel="stylesheet" href="../styles/components.css">
<style>.screen{min-height:100vh;padding:60px 24px;box-sizing:border-box}.hero{height:180px;border-radius:24px;background:${color};animation:rise 600ms ease-out both}@keyframes rise{from{opacity:0;transform:translateY(20px)}}</style>
</head><body><main class="screen"><div class="hero"></div><h1>${title}</h1>${body}</main></body></html>`;

let ws: string;
let pdir: string;
let server: http.Server;
let port: number;

beforeAll(async () => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'adl-handoff-'));
  await run('init', ['Bakery'], ws);
  pdir = path.join(ws, 'bakery');
  fs.writeFileSync(
    path.join(pdir, 'screens', 'S1.html'),
    screen(
      'Fresh bread, every morning',
      '<p>Order before 8 pm.</p><a class="btn" data-adl-anchor="order" href="S2.html">Order now</a>',
    ),
  );
  fs.writeFileSync(
    path.join(pdir, 'screens', 'S2.html'),
    screen(
      'Your basket',
      '<p>2 sourdough loaves</p><a class="btn" data-adl-anchor="pay" href="S3.html">Pay 9.80 €</a>',
    ),
  );
  // S3's look settles late (a block appears at 3 s): it sets its own still moment
  fs.writeFileSync(
    path.join(pdir, 'screens', 'S3.html'),
    screen('Thank you!', '<p>Pick it up tomorrow at 7.</p><div class="late"></div>')
      .replace('<title>', '<meta name="adl:snapshot" content="3500"><title>')
      .replace(
        '</style>',
        '.late{height:120px;background:#FF0000;animation:show 1ms 3000ms both}@keyframes show{from{opacity:0}}</style>',
      ),
  );
  fs.writeFileSync(path.join(pdir, 'screens', 'S4.html'), screen('Loyalty card', '<p>Not decided yet.</p>'));
  await run('add', ['S1', 'S2', 'S3', '--chain', '--label', 'Order now', '--label', 'Pay'], pdir);
  await run('link', ['S1', 'S2', '--trigger', 'tap order'], pdir);
  await run('link', ['S2', 'S3', '--trigger', 'tap pay'], pdir);
  await run('add', ['S4', '--after', 'S3', '--label', 'Loyalty'], pdir);
  await run('note', ['Prices include VAT', '--on', 'S2'], pdir);
  await run('section', ['Order', 'S1', 'S2', 'S3', 'S4'], pdir);
  await run('status', ['S1', 'S2', 'S3', 'approved', '--actor', 'human'], pdir);
  // a "built app": static files; /good serves the design itself, /bad a build with a wrong colour and changed copy
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const [, variant, ...rest] = u.pathname.split('/');
    let file = path.join(pdir, ...rest);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    let body = fs.readFileSync(file, 'utf8');
    if (variant === 'bad' && file.endsWith('S2.html'))
      body = body.replace('var(--color-accent)', '#e0218a').replace('2 sourdough loaves', 'Two loaves');
    file = file.replace(/\\/g, '/');
    res.writeHead(200, { 'content-type': file.endsWith('.css') ? 'text/css' : 'text/html' }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
}, 60000);

afterAll(() => {
  server?.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

describe('handoff', () => {
  it('pulls copy in reading order, animations, and DTCG tokens', () => {
    expect(stringsOf(fs.readFileSync(path.join(pdir, 'screens', 'S2.html'), 'utf8'))).toEqual([
      'Your basket',
      '2 sourdough loaves',
      'Pay 9.80 €',
    ]);
    expect(animationsOf(fs.readFileSync(path.join(pdir, 'screens', 'S1.html'), 'utf8'))).toEqual([
      { selector: '.hero', animation: 'rise 600ms ease-out both' },
    ]);
    const tokens = parseTokens(
      ':root{--color-accent:#3b6cf6;--space-4:16px;--ease-out:cubic-bezier(0.2,0.8,0.2,1);--color-link:var(--color-accent)}',
    );
    expect(toDtcg(tokens)).toEqual({
      color: { accent: { $type: 'color', $value: '#3b6cf6' }, link: { $value: '{color.accent}' } },
      space: { '4': { $type: 'dimension', $value: '16px' } },
      ease: { out: { $type: 'cubicBezier', $value: 'cubic-bezier(0.2,0.8,0.2,1)' } },
    });
  });

  it('writes the spec from approved screens only', async () => {
    const r = await run('handoff', [], pdir);
    expect(r.ok).toBe(true);
    const h = path.join(pdir, 'handoff');
    for (const f of [
      'HANDOFF.md',
      'spec.json',
      'tokens.json',
      'components.md',
      'flows.mmd',
      'png/S1.png',
      'source/screens/S2.html',
    ])
      expect(fs.existsSync(path.join(h, f)), f).toBe(true);
    const spec = JSON.parse(fs.readFileSync(path.join(h, 'spec.json'), 'utf8'));
    expect(spec.screens.map((s: { id: string }) => s.id)).toEqual(['S1', 'S2', 'S3']);
    expect(spec.excluded.map((s: { id: string }) => s.id)).toEqual(['S4']);
    expect(spec.screens[1].requirements).toEqual(['Prices include VAT']);
    expect(spec.screens[0].transitions).toEqual([
      { to: 'S2', label: 'Order now', trigger: { on: 'tap', el: 'order' }, included: true },
    ]);
    const md = fs.readFileSync(path.join(h, 'HANDOFF.md'), 'utf8');
    expect(md).toContain(
      '**S1 · Fresh bread, every morning** (start) → **S2 · Your basket**: “Order now” (tap `order`)',
    );
    expect(md).toContain('- S4 · Loyalty card: New');
    // the screen's own still moment: in the spec, in HANDOFF.md, and in its reference picture (the late block shows)
    expect(spec.screens[2].snapshotAt).toBe(3500);
    expect(spec.screens[0].snapshotAt).toBeUndefined();
    expect(md).toContain('animations frozen at 3500 ms');
    const ref = PNG.sync.read(fs.readFileSync(path.join(h, 'png', 'S3.png')));
    let red = 0;
    for (let i = 0; i < ref.data.length; i += 4)
      if (ref.data[i]! > 230 && ref.data[i + 1]! < 30 && ref.data[i + 2]! < 30) red++;
    expect(red).toBeGreaterThan(1000);
    expect(fs.readFileSync(path.join(h, 'flows.mmd'), 'utf8')).toContain('S1 -->|"Order now"| S2');
  }, 60000);

  it('the design itself, served as the app, passes the check', async () => {
    const h = path.join(pdir, 'handoff');
    const routes = (variant: string) => ({
      baseUrl: `http://127.0.0.1:${port}`,
      screens: {
        S1: { path: `/${variant}/screens/S1.html` },
        S2: { path: `/${variant}/screens/S2.html` },
        S3: { path: `/${variant}/screens/S3.html` },
      },
    });
    fs.writeFileSync(path.join(ws, 'good.json'), JSON.stringify(routes('good')));
    fs.writeFileSync(path.join(ws, 'bad.json'), JSON.stringify(routes('bad')));
    const good = await run('handoff', ['check', '--handoff', h, '--routes', path.join(ws, 'good.json')], ws);
    expect(good.text).toMatch(/^PASS · screens 3\/3 · transitions 2\/2/);
    const report = good.data as { screens: { ssim: number }[] };
    for (const s of report.screens) expect(s.ssim).toBeGreaterThan(0.99);

    const bad = await run('handoff', ['check', '--handoff', h, '--routes', path.join(ws, 'bad.json')], ws);
    expect(bad.ok).toBe(false);
    expect(bad.text).toMatch(
      /✗ S2: similarity [\d.]+ \(needs 0\.92\), [\d.]+ % pixels differ, missing copy: “2 sourdough loaves”/,
    );
    expect(fs.existsSync(path.join(h, 'check', 'S2.png'))).toBe(true);
    expect(fs.readFileSync(path.join(h, 'check', 'report.md'), 'utf8')).toContain('# Handoff check: NOT YET');
  }, 90000);
});
