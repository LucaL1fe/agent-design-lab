// Spike S1: does a screen rendered inside a Shadow DOM host look exactly like the same screen as a standalone page,
// and does the standalone page look like the phone on the original Claude Design board?
// Usage: ADL_BENCH_WIREFLOWS=<dir> node bench/spikes/s1-fidelity.ts <board> [board ...]
//   boards are .dc.html paths relative to <dir>; images come from <dir>/app/assets/blob/ and
//   <dir>/onboarding/assets/ + onboarding/blobmap.json
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { parse, serialize } from 'parse5';
import pixelmatch from 'pixelmatch';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import postcss from 'postcss';

const WF = process.env.ADL_BENCH_WIREFLOWS ?? '';
if (!WF) throw new Error('set ADL_BENCH_WIREFLOWS (see the usage line at the top)');
const OUT = path.resolve(import.meta.dirname, '../results/s1');
fs.mkdirSync(OUT, { recursive: true });

type Node = any;
const BOARDS = process.argv.slice(2);
if (!BOARDS.length) throw new Error('name at least one board (see the usage line at the top)');

// ---- blob resolution ----
const blobs = new Map<string, string>();
for (const f of fs.readdirSync(path.join(WF, 'app/assets/blob')))
  blobs.set(f.replace(/\.\w+$/, ''), path.join(WF, 'app/assets/blob', f));
const onbMap = JSON.parse(fs.readFileSync(path.join(WF, 'onboarding/blobmap.json'), 'utf8')) as Record<string, string>;
for (const [name, url] of Object.entries(onbMap)) {
  const id = url.replace('/_blob/', '');
  const f = path.join(WF, 'onboarding/assets', name + '.webp');
  if (fs.existsSync(f) && !blobs.has(id)) blobs.set(id, f);
}

// ---- board parsing ----
const attr = (n: Node, k: string) => n.attrs?.find((a: any) => a.name === k)?.value as string | undefined;
function walk(n: Node, fn: (n: Node) => void) {
  fn(n);
  for (const c of n.childNodes ?? []) walk(c, fn);
  if (n.content) walk(n.content, fn);
}
interface Phone {
  board: string;
  idx: number;
  group: string;
  x: number;
  y: number;
  w: number;
  h: number;
  inner: string;
  caption: string;
}
interface Board {
  file: string;
  links: string[];
  css: string;
  w: number;
  h: number;
  phones: Phone[];
  html: string;
}

function parseBoard(rel: string): Board {
  const src = fs.readFileSync(path.join(WF, rel), 'utf8');
  const doc = parse(src);
  let helmet: Node | undefined;
  walk(doc, (n) => {
    if (n.nodeName === 'helmet') helmet = n;
  });
  const links: string[] = [];
  let css = '';
  for (const c of helmet?.childNodes ?? []) {
    if (c.nodeName === 'link') links.push(attr(c, 'href')!);
    if (c.nodeName === 'style') css += serialize(c);
  }
  const m = src.match(/"\$preview":\{"width":(\d+),"height":(\d+)\}/);
  const phones: Phone[] = [];
  walk(doc, (n) => {
    const cls = attr(n, 'class') ?? '';
    if (!/\bam-phone\b/.test(cls)) return;
    const st = attr(n, 'style') ?? '';
    const num = (k: string) => Number(st.match(new RegExp(`${k}:\\s*(-?[\\d.]+)px`))?.[1] ?? 0);
    const kids = (n.childNodes as Node[]).filter((c) => c.nodeName !== '#text');
    const last = kids[kids.length - 1];
    if (last && /z-index:\s*9999/.test(attr(last, 'style') ?? '')) n.childNodes.splice(n.childNodes.indexOf(last), 1);
    phones.push({
      board: path.basename(rel, '.dc.html'),
      idx: phones.length,
      group: cls.match(/\bz\d+\b/)?.[0] ?? '',
      x: num('left'),
      y: num('top'),
      w: num('width'),
      h: num('height'),
      inner: serialize(n),
      caption: '',
    });
  });
  const start = src.indexOf('</helmet>') + 9;
  const end = src.indexOf('</x-dc>');
  return {
    file: rel,
    links,
    css,
    w: Number(m?.[1] ?? 4000),
    h: Number(m?.[2] ?? 4000),
    phones,
    html: src.slice(start, end),
  };
}

// ---- CSS: pick one group's rules and un-scope them ----
function unscope(boardCss: string, group: string): { css: string; hoisted: string } {
  const root = postcss.parse(boardCss);
  const out = postcss.root();
  const hoisted = postcss.root();
  const g = '.' + group;
  const fix = (sel: string): string | null => {
    const s = sel.trim();
    if (s === g) return 'body';
    if (s.startsWith(g + ' ')) return s.slice(g.length + 1);
    if (s.startsWith(g) && /^[.:[]/.test(s.slice(g.length))) return 'body' + s.slice(g.length);
    return null;
  };
  const take = (container: postcss.Container, into: postcss.Container) => {
    container.each((node) => {
      if (node.type === 'rule') {
        if (node.parent?.type === 'atrule' && /keyframes/i.test((node.parent as postcss.AtRule).name)) return;
        const sels = node.selectors.map(fix).filter((s): s is string => s !== null);
        if (sels.length) into.append(node.clone({ selectors: sels }));
      } else if (node.type === 'atrule') {
        if (/keyframes$/i.test(node.name)) into.append(node.clone());
        else if (node.name === 'property' || node.name === 'font-face') hoisted.append(node.clone());
        else if (node.nodes) {
          const a = node.clone({ nodes: [] });
          take(node, a);
          if (a.nodes?.length) into.append(a);
        }
      }
    });
  };
  take(root, out);
  return { css: out.toString(), hoisted: hoisted.toString() };
}

// Shadow transforms (strategy A: real html/body elements inside the shadow root)
function forShadow(css: string): string {
  const root = postcss.parse(css);
  root.walkRules((r) => {
    if (r.parent?.type === 'atrule' && /keyframes/i.test((r.parent as postcss.AtRule).name)) return;
    r.selectors = r.selectors.map((s) => s.replace(/:root\b/g, 'html'));
  });
  root.walkDecls((d) => {
    d.value = d.value.replace(
      /(-?[\d.]+)(d|s|l)?v(h|w|min|max)\b/g,
      (_m, n, _p, u) => `${n}cq${u === 'h' ? 'h' : u === 'w' ? 'w' : u}`,
    );
  });
  return root.toString();
}

const boards = BOARDS.map(parseBoard);
const phones = boards.flatMap((b) => b.phones.map((p) => ({ ...p, b })));
console.log(`boards ${boards.length}, phones ${phones.length}`);

const docHead = (b: Board, extra = '') =>
  `<meta charset="utf-8">${b.links.map((l) => `<link rel="stylesheet" href="${l}">`).join('')}${extra}`;

function standalone(p: (typeof phones)[number]) {
  const { css, hoisted } = unscope(p.b.css, p.group);
  return `<!doctype html><html><head>${docHead(p.b)}<style>html{background:#0F0F0F}body{margin:0}${hoisted}${css}</style></head><body>${p.inner}</body></html>`;
}
function shadowPage(p: (typeof phones)[number]) {
  const { css, hoisted } = unscope(p.b.css, p.group);
  const sheet = forShadow(`body{margin:0}${css}`);
  return `<!doctype html><html><head>${docHead(p.b)}<style>body{margin:0;background:#202020}${hoisted}</style></head><body>
<div id="host" style="width:${p.w}px;height:${p.h}px;contain:strict;container-type:size;overflow:hidden;background:#0F0F0F"></div>
<script>
const host=document.getElementById('host');const sr=host.attachShadow({mode:'open'});
const sh=new CSSStyleSheet();sh.replaceSync(${JSON.stringify(sheet)});sr.adoptedStyleSheets=[sh];
const html=document.createElement('html');const body=document.createElement('body');
body.innerHTML=${JSON.stringify(p.inner)};html.appendChild(body);sr.appendChild(html);
const bg=getComputedStyle(html).backgroundColor, bb=getComputedStyle(body).backgroundColor;
const clear=v=>v==='rgba(0, 0, 0, 0)'||v==='transparent';
if(!clear(bg))host.style.background=bg;else if(!clear(bb))host.style.background=bb;
</script></body></html>`;
}
function boardPage(b: Board) {
  return `<!doctype html><html><head>${docHead(b)}<style>body{margin:0}.am-phone>div[style*="z-index: 9999"]{display:none!important}${b.css}</style></head><body>${b.html}</body></html>`;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url!, 'http://x');
  const send = (body: string | Buffer, type = 'text/html') => {
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  };
  if (u.pathname.startsWith('/_blob/')) {
    const f = blobs.get(u.pathname.slice(7));
    if (!f) {
      res.writeHead(404);
      res.end();
      return;
    }
    return send(fs.readFileSync(f), f.endsWith('.png') ? 'image/png' : 'image/webp');
  }
  const [, kind, a, i] = u.pathname.split('/');
  if (kind === 'board') return send(boardPage(boards[Number(a)]!));
  const p = phones.find((q) => q.board === a && q.idx === Number(i));
  if (!p) {
    res.writeHead(404);
    res.end();
    return;
  }
  if (kind === 'standalone') return send(standalone(p));
  if (kind === 'shadow') return send(shadowPage(p));
  res.writeHead(404);
  res.end();
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as any).port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ deviceScaleFactor: 1 });
const settle = async (page: any, shadow: boolean) => {
  await page.evaluate(async (shadow: boolean) => {
    await document.fonts.ready;
    const root: any = shadow ? document.getElementById('host')!.shadowRoot : document;
    await Promise.all(
      [...root.querySelectorAll('img')].map((i: HTMLImageElement) =>
        i.complete
          ? null
          : new Promise((r) => {
              i.onload = i.onerror = r;
            }),
      ),
    );
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    for (const a of root.getAnimations()) {
      a.pause();
      a.currentTime = 1200;
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, shadow);
};

function maskCorners(png: PNG, r = 36) {
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      const dx = x < r ? r - x : x >= png.width - r ? x - (png.width - r - 1) : 0;
      const dy = y < r ? r - y : y >= png.height - r ? y - (png.height - r - 1) : 0;
      if (dx && dy) {
        const k = (y * png.width + x) * 4;
        png.data[k] = png.data[k + 1] = png.data[k + 2] = 0;
        png.data[k + 3] = 255;
      }
    }
}
function diff(a: Buffer, b: Buffer, name: string) {
  const A = PNG.sync.read(a),
    B = PNG.sync.read(b);
  if (A.width !== B.width || A.height !== B.height)
    return { pct: 100, note: `size ${A.width}x${A.height} vs ${B.width}x${B.height}` };
  maskCorners(A);
  maskCorners(B);
  const D = new PNG({ width: A.width, height: A.height });
  const n = pixelmatch(A.data, B.data, D.data, A.width, A.height, { threshold: 0.1 });
  const pct = (100 * n) / (A.width * A.height);
  if (pct > 0.5) fs.writeFileSync(path.join(OUT, name + '.diff.png'), PNG.sync.write(D));
  return { pct, note: '' };
}

const rows: any[] = [];
for (const [bi, b] of boards.entries()) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: Math.min(b.w, 8000), height: Math.min(b.h, 8000) });
  await page.goto(`${base}/board/${bi}`);
  await settle(page, false);
  const orig = new Map<number, Buffer>();
  for (const p of b.phones)
    orig.set(p.idx, await page.screenshot({ clip: { x: p.x, y: p.y, width: p.w, height: p.h } }));
  await page.close();
  for (const p of b.phones) {
    const sp = await ctx.newPage();
    await sp.setViewportSize({ width: p.w, height: p.h });
    await sp.goto(`${base}/standalone/${p.board}/${p.idx}`);
    await settle(sp, false);
    const st = await sp.screenshot();
    await sp.close();
    const hp = await ctx.newPage();
    await hp.setViewportSize({ width: p.w, height: p.h });
    await hp.goto(`${base}/shadow/${p.board}/${p.idx}`);
    await settle(hp, true);
    const sh = await hp.screenshot({ clip: { x: 0, y: 0, width: p.w, height: p.h } });
    await hp.close();
    const name = `${p.board}-${p.idx}`;
    const a = diff(orig.get(p.idx)!, st, name + '-orig-vs-standalone');
    const c = diff(st, sh, name + '-standalone-vs-shadow');
    if (a.pct > 0.5 || c.pct > 0.5) {
      fs.writeFileSync(path.join(OUT, name + '-orig.png'), orig.get(p.idx)!);
      fs.writeFileSync(path.join(OUT, name + '-standalone.png'), st);
      fs.writeFileSync(path.join(OUT, name + '-shadow.png'), sh);
    }
    rows.push({
      name,
      w: p.w,
      h: p.h,
      origVsStandalone: +a.pct.toFixed(3),
      standaloneVsShadow: +c.pct.toFixed(3),
      note: a.note || c.note,
    });
  }
}
await browser.close();
server.close();
const ok1 = rows.filter((r) => r.origVsStandalone < 0.5).length;
const ok2 = rows.filter((r) => r.standaloneVsShadow < 0.5).length;
console.table(rows);
console.log(`orig≈standalone ${ok1}/${rows.length}   standalone≈shadow ${ok2}/${rows.length}`);
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(rows, null, 1));
