import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { importClaudeDesign, statusFromBanner } from '../../src/node/importer/claude-design.ts';

describe('statusFromBanner', () => {
  it.each([
    ['As today (1.8.0)', { status: 'as-today', banner: '1.8.0' }],
    ['NEEDS A FIX · copy breaks the house style', { status: 'needs-fix', banner: 'copy breaks the house style' }],
    ['NOT APPROVED · MISSING: the user picks a colour', { status: 'missing', banner: 'the user picks a colour' }],
    ['TO DECIDE · S4 B · my pick', { status: 'to-decide', banner: 'S4 B · my pick' }],
    ['NOT APPROVED · new texts: shorter title', { status: 'not-approved', banner: 'new texts: shorter title' }],
    ['CHANGED · the quote first', { status: 'changed', banner: 'the quote first' }],
  ])('%s', (text, want) => expect(statusFromBanner(text)).toEqual(want));
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adl-imp-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('importClaudeDesign', () => {
  const src = path.join(dir, 'src');
  fs.mkdirSync(path.join(src), { recursive: true });
  fs.writeFileSync(
    path.join(src, 'canvas.json'),
    JSON.stringify({
      v: 3,
      title: 'Demo canvas',
      pages: [{ id: 'p', name: 'Truth' }],
      boards: { 'Tab-A.dc.html': { x: 100, y: 200, w: 1600, h: 1200, page: 'p', title: 'TAB · A' } },
      notes: {
        n1: { x: 0, y: 0, text: 'How it works', fill: 'gray', w: 300, page: 'p' },
        t1: { x: 0, y: -200, kind: 'title1', text: 'APP', page: 'p' },
      },
    }),
  );
  const seg = (l: number, t: number, w: number, h: number, d: string, head = false) =>
    `<svg width="${w}" height="${h}" style="position: absolute; left: ${l}px; top: ${t}px; width: ${w}px; height: ${h}px; overflow: visible; fill: none; stroke: #8C8C8C">${head ? '<defs><marker id="m"><path d="M0 0 L4 2 L0 4 Z"></path></marker></defs>' : ''}<path d="${d}"${head ? ' marker-end="url(#m)"' : ''}></path></svg>`;
  fs.writeFileSync(
    path.join(src, 'Tab-A.dc.html'),
    `<!doctype html><html><head><script src="./support.js"></script></head><body><x-dc><helmet><link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet"><style>body{margin:0}.am-phone{position:absolute}.z1,.z1{margin:0;overflow:hidden}.z1 .root{color:#fff;animation:spin 1s infinite}.z1 h1{font-size:30px}@keyframes spin{to{transform:rotate(1turn)}}@keyframes unused{to{opacity:0}}</style></helmet><div style="position: relative; width: 1600px; height: 1200px">
<div style="position: absolute; left: 64px; top: 44px; font: 900 44px/52px Inter">TAB · A</div>
${seg(454, 334, 300, 8, 'M 0 4 L 300 4', true)}
<div class="am-phone z1" style="position: absolute; overflow: hidden; left: 64px; top: 228px; width: 390px; height: 844px"><div class="root"><h1>First</h1><img src="/_blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"></div><div style="position: absolute; z-index: 9999; background: #FFD43B">NOT APPROVED · MISSING: the start</div></div>
<div class="am-phone z1" style="position: absolute; overflow: hidden; left: 754px; top: 228px; width: 390px; height: 844px"><div class="root"><h1>Second</h1></div></div>
<div style="position: absolute; left: 64px; top: 170px; font: 900 16px/20px Inter"><span style="color: #FFD43B">A1</span> · First screen</div>
<div style="position: absolute; left: 754px; top: 170px; font: 900 16px/20px Inter"><span style="color: #FFD43B">A2</span> · Second screen</div>
<div style="position: absolute; left: 480px; top: 296px; width: 250px; text-align: center; font: 800 14px/18px Inter; color: #C9C9C9">taps Next</div>
<div style="position: absolute; left: 64px; top: 1090px; border-radius: 13px; background: #242424; font: 800 13px/17px Inter">fresh install</div>
<div style="position: absolute; left: 1200px; top: 228px; width: 300px; min-height: 92px; border: 2px dashed #4A4A4A"><div>→ B1 The other tab</div></div>
</div></x-dc></body></html>`,
  );
  const blobs = path.join(dir, 'blobs');
  fs.mkdirSync(blobs);
  fs.writeFileSync(path.join(blobs, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp'), 'webp');

  it('turns boards into a project', async () => {
    const out = path.join(dir, 'out');
    const r = await importClaudeDesign({ sources: [src], to: out, blobDirs: [blobs] });
    expect(r).toMatchObject({ boards: 1, screens: 2, arrows: 1, portals: 1, chips: 1, notes: 1, assets: 1 });
    expect(r.arrowsUnmatched).toEqual([]);
    const page = JSON.parse(fs.readFileSync(path.join(out, 'pages', 'truth.json'), 'utf8'));
    expect(page.items['Tab-A']).toMatchObject({ kind: 'section', title: 'TAB · A', x: 100, y: 200 });
    expect(page.items.A1).toMatchObject({
      kind: 'screen',
      parent: 'Tab-A',
      x: 64,
      y: 228,
      title: 'First screen',
      status: 'missing',
      banner: 'the start',
    });
    expect(page.items.A2).toMatchObject({ status: 'approved' });
    expect(page.arrows['A1>A2']).toMatchObject({ from: 'A1', to: 'A2', label: 'taps Next' });
    expect(Object.values(page.items).find((i: any) => i.kind === 'portal')).toMatchObject({
      text: '→ B1 The other tab',
    });
    expect(r.warnings.join(' ')).toContain('points at B1');
    expect(page.items.t1).toMatchObject({ kind: 'text', size: 'h1', text: 'APP' });
    const html = fs.readFileSync(path.join(out, 'screens', 'A1.html'), 'utf8');
    expect(html).toContain('<meta name="adl:frame" content="390x844">');
    expect(html).toContain('../assets/img/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp');
    expect(html).not.toContain('NOT APPROVED');
    const css = fs.readFileSync(path.join(out, 'styles', fs.readdirSync(path.join(out, 'styles'))[0]!), 'utf8');
    expect(css).toContain('.root{color:#fff');
    expect(css).toContain('@keyframes spin');
    expect(css).not.toContain('unused');
    expect(css).not.toContain('.z1');
  });
});
