// Synthetic stress project: N screens in sections, with endless animations, backdrop blurs, tall pages, desktop frames,
// labelled arrows and notes. Deterministic (seeded).
// node bench/gen-fixture.ts <out-workspace> [screens=1000]
import fs from 'node:fs';
import path from 'node:path';
import { newPageDoc, newProjectDoc } from '../src/core/actions.ts';
import { stringifyPage, stringifyProject } from '../src/core/json.ts';
import type { PageDoc } from '../src/core/types.ts';

const out = path.resolve(process.argv[2] ?? 'bench/fixtures/ws');
const N = Number(process.argv[3] ?? 1000);
let seed = 42;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)]!;

const pdir = path.join(out, 'stress');
fs.rmSync(pdir, { recursive: true, force: true });
for (const d of ['pages', 'screens', 'styles']) fs.mkdirSync(path.join(pdir, d), { recursive: true });

fs.writeFileSync(
  path.join(pdir, 'styles', 'app.css'),
  `:root{--bg:#101012;--card:#1c1c20;--line:#2c2c33;--text:#f1f1f3;--muted:#9a9aa5;--accent:#5b8cff;--ok:#3ccf91}
html{background:var(--bg)}
body{margin:0;font:15px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif;color:var(--text)}
.top{display:flex;align-items:center;justify-content:space-between;padding:52px 20px 12px}
.h{font-size:28px;font-weight:800}
.chip{background:var(--card);border-radius:12px;padding:6px 10px;font-weight:700}
.list{display:flex;flex-direction:column;gap:10px;padding:10px 16px}
.row{display:flex;align-items:center;gap:12px;background:var(--card);border-radius:16px;padding:14px;border:1px solid var(--line)}
.ico{width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,var(--accent),#a06bff)}
.btn{margin:18px 16px;background:var(--accent);color:#fff;font-weight:800;text-align:center;border-radius:14px;padding:16px}
.tabs{position:absolute;left:0;right:0;bottom:0;height:84px;background:#141418;display:flex;justify-content:space-around;align-items:center;color:var(--muted)}
.spin{animation:spin 1.2s linear infinite}
.pulse{animation:pulse 1.4s ease-in-out infinite}
.float{animation:float 2.2s ease-in-out infinite}
.glass{backdrop-filter:blur(14px);background:rgba(255,255,255,.08)}
@keyframes spin{to{transform:rotate(1turn)}}
@keyframes pulse{50%{opacity:.4;transform:scale(.96)}}
@keyframes float{50%{transform:translateY(-10px)}}
`,
);

const animatedRows = (n: number, cls: string) =>
  Array.from(
    { length: n },
    (_, i) =>
      `<div class="row"><div class="ico ${i % 2 ? cls : ''}"></div><div style="flex:1"><b>Item ${i + 1}</b><div style="color:var(--muted)">Detail line for item ${i + 1}</div></div><span class="chip">+${(i + 1) * 5}</span></div>`,
  ).join('');

const page: PageDoc = newPageDoc('Stress test');
const sections = Math.ceil(N / 17);
let made = 0;
for (let s = 0; s < sections && made < N; s++) {
  const sid = `sec-${s + 1}`;
  const sx = (s % 4) * 12000;
  const sy = Math.floor(s / 4) * 2800;
  page.items[sid] = { kind: 'section', title: `SECTION ${s + 1} · flow ${s + 1}`, x: sx, y: sy };
  const rowX = [64, 64];
  for (let i = 0; i < 17 && made < N; i++) {
    made++;
    const id = `S${s + 1}-${i + 1}`;
    const r = rnd();
    const kind = r < 0.05 ? 'desktop' : r < 0.15 ? 'tall' : 'phone';
    const anim = rnd() < 0.3 ? pick(['spin', 'pulse', 'float']) : '';
    const glass = rnd() < 0.05;
    const confetti = rnd() < 0.1;
    const rows = kind === 'tall' ? 18 : 6;
    const frame = kind === 'desktop' ? '1440x900' : kind === 'tall' ? '390xauto' : '390x844';
    const w = kind === 'desktop' ? 1440 : 390;
    const conf = confetti
      ? Array.from(
          { length: 24 },
          (_, k) =>
            `<i class="float" style="position:absolute;left:${(k * 37) % 380}px;top:${(k * 53) % 300}px;width:8px;height:12px;background:hsl(${k * 40} 80% 60%);animation-delay:${(k % 7) * 0.1}s"></i>`,
        ).join('')
      : '';
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="adl:frame" content="${frame}"><title>Screen ${id}</title><link rel="stylesheet" href="../styles/app.css"></head><body${kind === 'desktop' ? ' style="padding:0 120px"' : ''}><div style="position:relative;${kind === 'tall' ? '' : 'height:100vh'}"><div class="top"><span class="h">${pick(['Home', 'Search', 'Library', 'Profile', 'Settings', 'Inbox'])} ${id}</span><span class="chip ${glass ? 'glass' : ''}">${Math.floor(rnd() * 900)}</span></div><div class="list">${animatedRows(rows, anim)}</div><div class="btn ${anim}">Continue</div>${kind === 'tall' ? '' : '<div class="tabs"><span>Home</span><span>Search</span><span>Me</span></div>'}${conf}</div></body></html>`;
    fs.writeFileSync(path.join(pdir, 'screens', `${id}.html`), html);
    const row = Math.floor(i / 9);
    const x = rowX[row]!;
    rowX[row] = x + w + 470;
    page.items[id] = {
      kind: 'screen',
      parent: sid,
      x,
      y: 160 + row * 1150,
      status: pick(['approved', 'new', 'to-decide', 'needs-fix']),
      ...(rnd() < 0.5 ? { banner: 'check the spacing and the copy' } : {}),
    };
    if (i > 0)
      page.arrows[`S${s + 1}-${i}>${id}`] = {
        from: `S${s + 1}-${i}`,
        to: id,
        label: pick(['taps Continue', 'swipes left', '3 s later', 'allows reminders', 'no account']),
      };
  }
  if (s % 1 === 0)
    page.items[`note-${s + 1}`] = {
      kind: 'note',
      parent: sid,
      x: 64,
      y: 2100,
      w: 360,
      text: `Notes for section ${s + 1}: check the empty state and the error state.`,
      color: pick(['yellow', 'blue', 'green', 'pink']),
    };
}
const project = { ...newProjectDoc('Stress test'), frame: '390x844' };
fs.writeFileSync(path.join(pdir, 'project.json'), stringifyProject(project as never));
fs.writeFileSync(path.join(pdir, 'pages', 'truth.json'), stringifyPage(page as never));
console.log(`wrote ${made} screens in ${sections} sections to ${pdir}`);
