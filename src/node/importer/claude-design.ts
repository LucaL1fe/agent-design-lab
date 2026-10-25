// Imports a Claude Design canvas (canvas.json + *.dc.html boards) into an Agent Design Lab project:
// boards become sections, every phone becomes a standalone screen file, baked-in banners become statuses with banner
// text, SVG segment chains become labelled arrows, dashed boxes become portals, chips become notes.
import fs from 'node:fs';
import path from 'node:path';
import { type DefaultTreeAdapterMap, parse, serialize } from 'parse5';
import postcss from 'postcss';
import { newPageDoc, newProjectDoc } from '../../core/actions.ts';
import { stringifyPage, stringifyProject } from '../../core/json.ts';
import { DEFAULT_STATUSES } from '../../core/status.ts';
import type { Arrow, Item, NoteColor, PageDoc, ProjectDoc, StatusDef } from '../../core/types.ts';
import { sha } from '../fsutil.ts';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

export interface ImportOptions {
  /** Folders holding canvas.json and the .dc.html boards. Their boards are merged (later folders win on duplicates). */
  sources: string[];
  /** Project folder to write. */
  to: string;
  name?: string;
  /** Resolve /_blob/<id> URLs: folders with files named <id>.<ext>. */
  blobDirs?: string[];
  /** Name maps {"name": "/_blob/<id>"} with the folder that holds <name>.<ext>. */
  blobMaps?: { map: string; dir: string }[];
  includeOverview?: boolean;
  /** Frame background colour of the phones (written into every screen). */
  background?: string;
  /** Keep the arrows' original routes as waypoints (default: let the canvas route them). */
  keepRoutes?: boolean;
}

export interface ImportReport {
  boards: number;
  screens: number;
  arrows: number;
  arrowsUnmatched: { board: string; reason: string; at: [number, number] }[];
  labelsUnused: { board: string; text: string }[];
  portals: number;
  portalsUnresolved: string[];
  notes: number;
  texts: number;
  chips: number;
  statuses: Record<string, number>;
  cssBytesBefore: number;
  cssBytesAfter: number;
  sheets: number;
  assets: number;
  missingAssets: string[];
  unknown: { board: string; html: string }[];
  warnings: string[];
}

interface Phone {
  id: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  group: string;
  inner: string;
  banner?: { text: string; bg: string };
}

interface Seg {
  pts: [number, number][];
  head: boolean;
  color: string;
  dashed: boolean;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const attr = (n: Element, k: string) => n.attrs.find((a) => a.name === k)?.value;
const isEl = (n: Node): n is Element => 'tagName' in n;
const kids = (n: Node): Node[] => ((n as DefaultTreeAdapterMap['parentNode']).childNodes ?? []) as Node[];
function textOf(n: Node): string {
  if (n.nodeName === '#text') return (n as unknown as { value: string }).value;
  return kids(n).map(textOf).join('');
}
function walk(n: Node, fn: (n: Node) => void) {
  fn(n);
  for (const c of kids(n)) walk(c, fn);
}
function styleOf(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (attr(el, 'style') ?? '').split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}
const px = (v: string | undefined) => (v ? Number.parseFloat(v) : Number.NaN);

// ---------- statuses from baked-in banners ----------

const IMPORT_STATUSES: StatusDef[] = [
  { id: 'approved', label: 'Approved', color: '#45C08A', role: 'approved', banner: false, createdBy: 'builtin' },
  { id: 'as-today', label: 'As today', color: '#5A5A54', role: 'existing', createdBy: 'import' },
  { id: 'needs-fix', label: 'Needs a fix', color: '#FF9F43', role: 'todo', createdBy: 'builtin' },
  { id: 'changed', label: 'Changed', color: '#FF9F43', role: 'review', createdBy: 'import' },
  { id: 'missing', label: 'Missing', color: '#FFD43B', role: 'todo', createdBy: 'builtin' },
  { id: 'to-decide', label: 'To decide', color: '#FFD43B', role: 'review', createdBy: 'builtin' },
  { id: 'not-approved', label: 'Not approved', color: '#FFD43B', role: 'review', createdBy: 'import' },
  { id: 'new', label: 'New', color: '#E58A64', role: 'review', createdBy: 'builtin' },
];

export function statusFromBanner(text: string): { status: string; banner?: string } {
  const t = text.replace(/\s+/g, ' ').trim();
  const m = t.match(/^as today\s*\(([^)]*)\)$/i);
  if (m) return { status: 'as-today', banner: m[1]! };
  if (/^as today/i.test(t))
    return { status: 'as-today', banner: t.replace(/^as today\s*·?\s*/i, '') || undefined } as {
      status: string;
      banner?: string;
    };
  const parts = t.split(/\s*·\s*/);
  const head = (parts[0] ?? '').toUpperCase();
  const rest = parts.slice(1).join(' · ');
  if (head.startsWith('NEEDS A FIX')) return { status: 'needs-fix', ...(rest ? { banner: rest } : {}) };
  if (head.startsWith('CHANGED')) return { status: 'changed', ...(rest ? { banner: rest } : {}) };
  if (head.startsWith('TO DECIDE')) return { status: 'to-decide', ...(rest ? { banner: rest } : {}) };
  if (head.startsWith('NOT APPROVED')) {
    const r = rest.match(/^MISSING:?\s*(.*)$/i);
    if (r) return { status: 'missing', ...(r[1] ? { banner: r[1] } : {}) };
    if (/^TO DECIDE/i.test(rest)) return { status: 'to-decide', banner: rest.replace(/^TO DECIDE\s*·?\s*/i, '') };
    return { status: 'not-approved', ...(rest ? { banner: rest } : {}) };
  }
  if (head.startsWith('MISSING'))
    return {
      status: 'missing',
      ...(rest || t.replace(/^MISSING:?\s*/i, '') ? { banner: rest || t.replace(/^MISSING:?\s*/i, '') } : {}),
    };
  return { status: 'not-approved', banner: t };
}

// ---------- blobs ----------

class Blobs {
  private files = new Map<string, string>();
  private names = new Map<string, string>();
  constructor(opts: ImportOptions) {
    for (const dir of opts.blobDirs ?? []) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) this.files.set(f.replace(/\.\w+$/, ''), path.join(dir, f));
    }
    for (const { map, dir } of opts.blobMaps ?? []) {
      const m = JSON.parse(fs.readFileSync(map, 'utf8')) as Record<string, string>;
      for (const [name, url] of Object.entries(m)) {
        const id = url.replace('/_blob/', '');
        const cand = fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => f.replace(/\.\w+$/, '') === name) : undefined;
        if (cand && !this.files.has(id)) this.files.set(id, path.join(dir, cand));
        this.names.set(id, name);
      }
    }
  }
  resolve(id: string): { file: string; name: string } | undefined {
    const file = this.files.get(id);
    if (!file) return undefined;
    const name = (this.names.get(id) ?? id).replace(/[^A-Za-z0-9_.-]+/g, '-') + path.extname(file);
    return { file, name };
  }
}

// ---------- CSS per phone group ----------

function groupCss(boardCss: string, group: string): { css: string; usedKeyframes: Set<string> } {
  const root = postcss.parse(boardCss);
  const out = postcss.root();
  const g = '.' + group;
  const fix = (sel: string): string | null => {
    const s = sel.trim();
    if (s === g) return 'body';
    if (s.startsWith(g + ' ')) return s.slice(g.length + 1);
    if (s.startsWith(g) && /^[.:[#]/.test(s.slice(g.length))) return 'body' + s.slice(g.length);
    return null;
  };
  const used = new Set<string>();
  const take = (container: postcss.Container, into: postcss.Container) => {
    container.each((node) => {
      if (node.type === 'rule') {
        const sels = node.selectors.map(fix).filter((s): s is string => s !== null);
        if (!sels.length) return;
        const r = node.clone({ selectors: [...new Set(sels)] });
        r.walkDecls(/^animation(-name)?$/i, (d) => {
          for (const w of d.value.split(/[\s,]+/)) if (/^[A-Za-z_][\w-]*$/.test(w)) used.add(w);
        });
        into.append(r);
      } else if (
        node.type === 'atrule' &&
        !/keyframes$/i.test(node.name) &&
        node.name !== 'property' &&
        node.name !== 'font-face' &&
        node.nodes
      ) {
        const a = node.clone({ nodes: [] });
        take(node, a);
        if (a.nodes?.length) into.append(a);
      }
    });
  };
  take(root, out);
  // the keyframes this group uses (last definition wins, like the cascade)
  const kf = new Map<string, postcss.AtRule>();
  const globals: postcss.AtRule[] = [];
  root.each((node) => {
    if (node.type !== 'atrule') return;
    if (/keyframes$/i.test(node.name)) kf.set(node.params.trim(), node);
    else if (node.name === 'property' || node.name === 'font-face') globals.push(node);
  });
  for (const name of used) {
    const k = kf.get(name);
    if (k) out.append(k.clone());
  }
  for (const gl of globals) out.prepend(gl.clone());
  return { css: out.toString(), usedKeyframes: used };
}

// ---------- board parsing ----------

interface Parsed {
  file: string;
  links: string[];
  css: string;
  phones: Phone[];
  segs: Seg[];
  labels: { x: number; y: number; w: number; text: string; color: string }[];
  portals: (Box & { text: string })[];
  chips: { x: number; y: number; w: number; text: string; warn: boolean }[];
  texts: { x: number; y: number; text: string; size: 'h2' | 'h3' }[];
  unknown: string[];
}

function parseBoard(file: string): Parsed {
  const src = fs.readFileSync(file, 'utf8');
  const doc = parse(src);
  let helmet: Element | undefined;
  walk(doc, (n) => {
    if (isEl(n) && n.tagName === 'helmet') helmet ??= n;
  });
  const links: string[] = [];
  let css = '';
  for (const c of helmet ? kids(helmet) : []) {
    if (!isEl(c)) continue;
    if (c.tagName === 'link' && attr(c, 'href')) links.push(attr(c, 'href')!);
    if (c.tagName === 'style') css += textOf(c);
  }
  // the board root: the first positioned div after <helmet> inside <x-dc>
  let xdc: Element | undefined;
  walk(doc, (n) => {
    if (isEl(n) && n.tagName === 'x-dc') xdc ??= n;
  });
  const root = (xdc ? kids(xdc) : []).find((n) => isEl(n) && n.tagName === 'div') as Element | undefined;
  const out: Parsed = {
    file,
    links,
    css,
    phones: [],
    segs: [],
    labels: [],
    portals: [],
    chips: [],
    texts: [],
    unknown: [],
  };
  if (!root) return out;
  const captions: { x: number; y: number; id: string; title: string }[] = [];
  for (const n of kids(root)) {
    if (!isEl(n)) continue;
    const st = styleOf(n);
    const cls = attr(n, 'class') ?? '';
    const x = px(st.left);
    const y = px(st.top);
    if (/\bam-phone\b/.test(cls)) {
      const ch = kids(n).filter(isEl);
      const last = ch[ch.length - 1];
      let banner: Phone['banner'];
      if (last && /z-index:\s*9999/.test(attr(last, 'style') ?? '')) {
        const bs = styleOf(last);
        banner = { text: textOf(last).trim(), bg: bs.background ?? '' };
        (n as unknown as { childNodes: Node[] }).childNodes.splice(kids(n).indexOf(last), 1);
      }
      out.phones.push({
        id: '',
        title: '',
        x,
        y,
        w: px(st.width),
        h: px(st.height),
        group: cls.match(/\bz\d+\b/)?.[0] ?? '',
        inner: serialize(n as never),
        ...(banner ? { banner } : {}),
      });
      continue;
    }
    if (n.tagName === 'svg') {
      const w = px(st.width);
      const h = px(st.height);
      let path0: Element | undefined;
      walk(n, (m) => {
        if (isEl(m) && m.tagName === 'path' && attr(m, 'd') && !path0 && !kidsOfDefs(n, m)) path0 = m;
      });
      const d = path0 ? attr(path0, 'd')! : '';
      const nums = [...d.matchAll(/-?[\d.]+/g)].map((mm) => Number(mm[0]));
      if (nums.length >= 4 && Number.isFinite(x) && Number.isFinite(y)) {
        const pts: [number, number][] = [];
        for (let i = 0; i + 1 < nums.length; i += 2) pts.push([x + nums[i]!, y + nums[i + 1]!]);
        const stroke = st.stroke ?? attr(n, 'stroke') ?? '#8C8C8C';
        const dash =
          st['stroke-dasharray'] ??
          attr(n, 'stroke-dasharray') ??
          (path0 ? attr(path0, 'stroke-dasharray') : undefined);
        out.segs.push({
          pts,
          head: !!(path0 && attr(path0, 'marker-end')),
          color: stroke.toUpperCase(),
          dashed: !!dash && dash !== 'none',
        });
        void w;
        void h;
      }
      continue;
    }
    if (n.tagName !== 'div') continue;
    const font = st.font ?? '';
    const text = textOf(n).replace(/\s+/g, ' ').trim();
    const span = kids(n).find((k) => isEl(k) && k.tagName === 'span') as Element | undefined;
    if (span && /#FFD43B/i.test(attr(span, 'style') ?? '') && /900 16px/.test(font)) {
      const id = textOf(span).trim();
      const title = text
        .slice(id.length)
        .replace(/^\s*·\s*/, '')
        .trim();
      captions.push({ x, y, id, title });
      continue;
    }
    if (/dashed #4A4A4A/i.test(attr(n, 'style') ?? '')) {
      const blocks = kids(n)
        .map((k) => textOf(k).replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      out.portals.push({
        x,
        y,
        w: px(st.width) || 300,
        h: px(st['min-height']) || px(st.height) || 92,
        text: blocks.join('\n') || text,
      });
      continue;
    }
    if (st['border-radius'] === '13px' && /#242424|#3A1F1F/i.test(st.background ?? '')) {
      out.chips.push({ x, y, w: px(st.width) || 300, text, warn: /#3A1F1F/i.test(st.background ?? '') });
      continue;
    }
    if (/800 14px/.test(font) && text) {
      out.labels.push({ x, y, w: px(st.width) || 0, text, color: (st.color ?? '#C9C9C9').toUpperCase() });
      continue;
    }
    if (/900 44px/.test(font) || (x === 64 && y === 102)) continue; // board title + status counts (counts are live in ADL)
    if (/900 18px/.test(font) && text) {
      out.texts.push({ x, y, text, size: 'h3' });
      continue;
    }
    if (text) out.unknown.push(serialize(n as never).slice(0, 200) || text);
  }
  // captions: the caption sits ~58 px above its phone
  for (const p of out.phones) {
    let best: (typeof captions)[number] | undefined;
    let bestD = Number.POSITIVE_INFINITY;
    for (const c of captions) {
      const d = Math.abs(c.x - p.x) + Math.abs(p.y - 58 - c.y);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (best && bestD < 40) {
      p.id = best.id;
      p.title = best.title;
      captions.splice(captions.indexOf(best), 1);
    }
  }
  for (const c of captions) out.unknown.push(`caption without a phone: ${c.id} · ${c.title}`);
  return out;
}

function kidsOfDefs(root: Element, target: Element): boolean {
  let inDefs = false;
  walk(root, (n) => {
    if (isEl(n) && n.tagName === 'defs')
      walk(n, (m) => {
        if (m === target) inDefs = true;
      });
  });
  return inDefs;
}

// ---------- arrows ----------

const near = (a: [number, number], b: [number, number], tol = 2.5) =>
  Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;

function chains(segs: Seg[]): Seg[][] {
  const out: Seg[][] = [];
  const used = new Set<Seg>();
  for (const head of segs.filter((s) => s.head)) {
    const chain = [head];
    used.add(head);
    let cur = head;
    for (let guard = 0; guard < 50; guard++) {
      const start = cur.pts[0]!;
      const prev = segs.find((s) => !used.has(s) && !s.head && near(s.pts[s.pts.length - 1]!, start));
      if (!prev) break;
      chain.unshift(prev);
      used.add(prev);
      cur = prev;
    }
    out.push(chain);
  }
  return out;
}

function boxEdgeHit(p: [number, number], b: Box, tol: number): boolean {
  const inX = p[0] >= b.x - tol && p[0] <= b.x + b.w + tol;
  const inY = p[1] >= b.y - tol && p[1] <= b.y + b.h + tol;
  if (!inX || !inY) return false;
  const dl = Math.abs(p[0] - b.x);
  const dr = Math.abs(p[0] - (b.x + b.w));
  const dt = Math.abs(p[1] - b.y);
  const db = Math.abs(p[1] - (b.y + b.h));
  return Math.min(dl, dr, dt, db) <= tol;
}

// ---------- main ----------

export async function importClaudeDesign(opts: ImportOptions): Promise<ImportReport> {
  const report: ImportReport = {
    boards: 0,
    screens: 0,
    arrows: 0,
    arrowsUnmatched: [],
    labelsUnused: [],
    portals: 0,
    portalsUnresolved: [],
    notes: 0,
    texts: 0,
    chips: 0,
    statuses: {},
    cssBytesBefore: 0,
    cssBytesAfter: 0,
    sheets: 0,
    assets: 0,
    missingAssets: [],
    unknown: [],
    warnings: [],
  };
  const blobs = new Blobs(opts);
  // merge canvas.json files: later sources win for the same board file
  type CBoard = { x: number; y: number; w: number; h: number; page?: string; title?: string };
  type CNote = {
    x: number;
    y: number;
    text: string;
    kind?: string;
    w?: number;
    maxW?: number;
    fill?: string;
    page?: string;
  };
  const positions = new Map<string, CBoard>();
  const fileDir = new Map<string, string>();
  const notes = new Map<string, CNote>();
  let canvasName = opts.name ?? 'Imported design';
  let pageName = 'Source of truth';
  for (const dir of opts.sources) {
    const cj = JSON.parse(fs.readFileSync(path.join(dir, 'canvas.json'), 'utf8')) as {
      title?: string;
      pages?: { id: string; name: string }[];
      boards?: Record<string, CBoard>;
      notes?: Record<string, CNote>;
    };
    if (!opts.name && cj.title) canvasName = cj.title;
    if (cj.pages?.[0]?.name) pageName = cj.pages[0].name;
    for (const [f, b] of Object.entries(cj.boards ?? {})) positions.set(f, b);
    for (const [id, n] of Object.entries(cj.notes ?? {})) notes.set(id, n);
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.dc.html')) fileDir.set(f, dir);
  }
  const boards = new Map<string, { dir: string; b: CBoard }>();
  for (const [f, b] of positions) {
    const dir = fileDir.get(f);
    if (dir) boards.set(f, { dir, b });
  }
  const out = opts.to;
  fs.mkdirSync(path.join(out, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(out, 'screens'), { recursive: true });
  fs.mkdirSync(path.join(out, 'styles'), { recursive: true });
  fs.mkdirSync(path.join(out, 'assets', 'img'), { recursive: true });

  const page: PageDoc = newPageDoc(pageName);
  const fonts = new Set<string>();
  const sheetByCss = new Map<string, string>(); // css hash → file name
  const assetsCopied = new Map<string, string>(); // blob id → assets/img/<name>
  const usedScreenIds = new Set<string>();
  const statusCount: Record<string, number> = {};
  const pendingSectionTargets: { pid: string; code: string }[] = [];

  const blobUrl = (id: string, fromDir: 'screens' | 'styles'): string | undefined => {
    let rel = assetsCopied.get(id);
    if (!rel) {
      const r = blobs.resolve(id);
      if (!r) {
        if (!report.missingAssets.includes(id)) report.missingAssets.push(id);
        return undefined;
      }
      rel = `assets/img/${r.name}`;
      fs.copyFileSync(r.file, path.join(out, rel));
      assetsCopied.set(id, rel);
    }
    return fromDir === 'screens' || fromDir === 'styles' ? `../${rel}` : rel;
  };
  const rewriteBlobs = (s: string, fromDir: 'screens' | 'styles') =>
    s.replace(/\/_blob\/([0-9a-f]{32})/g, (m, id: string) => blobUrl(id, fromDir) ?? m);

  for (const [file, { dir, b }] of boards) {
    if (/^Main\.dc\.html$/.test(file) && !opts.includeOverview) continue;
    const parsed = parseBoard(path.join(dir, file));
    report.boards++;
    for (const l of parsed.links) fonts.add(l);
    report.cssBytesBefore += parsed.css.length * Math.max(1, new Set(parsed.phones.map((p) => p.group)).size);
    const sectionId = file.replace(/\.dc\.html$/, '').replace(/[^A-Za-z0-9-]+/g, '-');
    page.items[sectionId] = {
      kind: 'section',
      title: b.title ?? sectionId,
      x: Math.round(b.x),
      y: Math.round(b.y),
      w: Math.round(b.w),
      h: Math.round(b.h),
    };
    // group stylesheets, shared across boards when identical
    const groupSheet = new Map<string, string>();
    for (const grp of new Set(parsed.phones.map((p) => p.group))) {
      const { css } = groupCss(parsed.css, grp);
      const finalCss = rewriteBlobs(css, 'styles');
      const h = sha(finalCss, 10);
      let name = sheetByCss.get(h);
      if (!name) {
        name = `app-${h}.css`;
        fs.writeFileSync(path.join(out, 'styles', name), finalCss);
        sheetByCss.set(h, name);
        report.cssBytesAfter += finalCss.length;
      }
      groupSheet.set(grp, name);
    }
    // screens
    const boxes = new Map<string, Box & { kind: 'screen' | 'portal' }>();
    for (const p of parsed.phones) {
      let id = p.id || `${sectionId}-${p.x}-${p.y}`;
      if (usedScreenIds.has(id)) {
        let i = 2;
        while (usedScreenIds.has(`${id}~${i}`)) i++;
        report.warnings.push(`Two phones are called ${id}; the second one is ${id}~${i}`);
        id = `${id}~${i}`;
      }
      usedScreenIds.add(id);
      const frame = `${p.w}x${p.h}`;
      const body = rewriteBlobs(p.inner, 'screens');
      const sheet = groupSheet.get(p.group);
      const html = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="adl:frame" content="${frame}">\n<title>${escapeHtml(p.title || id)}</title>\n${[...parsed.links].map((l) => `<link rel="stylesheet" href="${escapeAttr(l)}">`).join('\n')}\n${sheet ? `<link rel="stylesheet" href="../styles/${sheet}">\n` : ''}<style>html{background:${opts.background ?? '#0F0F0F'}}body{margin:0}</style>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
      fs.writeFileSync(path.join(out, 'screens', `${id.replace(/[/\\]/g, '_')}.html`), html);
      const item: Item = { kind: 'screen', parent: sectionId, x: Math.round(p.x), y: Math.round(p.y) };
      if (p.title) item.title = p.title;
      if (p.banner) {
        const s = statusFromBanner(p.banner.text);
        item.status = s.status;
        if (s.banner) item.banner = s.banner;
      } else item.status = 'approved';
      statusCount[item.status!] = (statusCount[item.status!] ?? 0) + 1;
      page.items[id] = item;
      boxes.set(id, { x: p.x, y: p.y, w: p.w, h: p.h, kind: 'screen' });
      report.screens++;
    }
    // portals
    for (const [i, po] of parsed.portals.entries()) {
      const pid = `p-${sectionId}-${i + 1}`;
      const ids = [...po.text.matchAll(/\b([A-Z]{1,3}\d+[a-z]?)\b/g)].map((mm) => mm[1]!);
      const target = ids.find((x) => x !== po.text.match(/from\s+([A-Z]{1,3}\d+)/)?.[1]) ?? ids[0];
      if (!target) {
        const code = po.text.match(/→\s*([A-Z]{1,3})\b/)?.[1];
        if (code) pendingSectionTargets.push({ pid: `p-${sectionId}-${i + 1}`, code });
      }
      page.items[pid] = {
        kind: 'portal',
        parent: sectionId,
        x: Math.round(po.x),
        y: Math.round(po.y),
        w: Math.round(po.w),
        h: Math.round(po.h),
        text: po.text,
        ...(target ? { target } : {}),
      };
      boxes.set(pid, { ...po, kind: 'portal' });
      report.portals++;
    }
    // chips → notes anchored to the phone above them
    for (const [i, c] of parsed.chips.entries()) {
      let anchor: string | undefined;
      for (const [id, bx] of boxes)
        if (
          bx.kind === 'screen' &&
          c.x >= bx.x - 10 &&
          c.x <= bx.x + bx.w &&
          c.y >= bx.y + bx.h - 10 &&
          c.y <= bx.y + bx.h + 400
        )
          anchor = id;
      const nid = `chip-${sectionId}-${i + 1}`;
      const color: NoteColor = c.warn ? 'pink' : 'grey';
      if (anchor) {
        const a = boxes.get(anchor)!;
        page.items[nid] = {
          kind: 'note',
          anchor,
          x: Math.round(c.x - a.x),
          y: Math.round(c.y - a.y),
          w: Math.round(c.w),
          text: c.text,
          color,
          size: 'small',
          by: 'import',
        };
      } else
        page.items[nid] = {
          kind: 'note',
          parent: sectionId,
          x: Math.round(c.x),
          y: Math.round(c.y),
          w: Math.round(c.w),
          text: c.text,
          color,
          size: 'small',
          by: 'import',
        };
      report.chips++;
    }
    for (const [i, t] of parsed.texts.entries()) {
      page.items[`txt-${sectionId}-${i + 1}`] = {
        kind: 'text',
        parent: sectionId,
        x: Math.round(t.x),
        y: Math.round(t.y),
        text: t.text,
        size: t.size,
      };
      report.texts++;
    }
    // arrows
    const usedLabels = new Set<number>();
    for (const chain of chains(parsed.segs)) {
      const pts: [number, number][] = [];
      for (const s of chain) for (const p of s.pts) if (!pts.length || !near(pts[pts.length - 1]!, p, 0.5)) pts.push(p);
      const tail = pts[0]!;
      const tip = pts[pts.length - 1]!;
      const findBox = (p: [number, number], tol: number, extraTop = 0): string | undefined => {
        let best: string | undefined;
        let bestD = Number.POSITIVE_INFINITY;
        for (const [id, bx] of boxes) {
          const grown = { x: bx.x, y: bx.y - extraTop, w: bx.w, h: bx.h + extraTop };
          if (!boxEdgeHit(p, grown, tol)) continue;
          const d = Math.min(
            Math.abs(p[0] - grown.x),
            Math.abs(p[0] - grown.x - grown.w),
            Math.abs(p[1] - grown.y),
            Math.abs(p[1] - grown.y - grown.h),
          );
          if (d < bestD) {
            bestD = d;
            best = id;
          }
        }
        return best;
      };
      const vertical = (p: [number, number], dir: 'above' | 'below'): string | undefined => {
        let best: string | undefined;
        let bestD = Number.POSITIVE_INFINITY;
        for (const [id, bx] of boxes) {
          if (p[0] < bx.x - 4 || p[0] > bx.x + bx.w + 4) continue;
          const d = dir === 'above' ? p[1] - (bx.y + bx.h) : bx.y - p[1];
          if (d >= -4 && d <= 260 && d < bestD) {
            bestD = d;
            best = id;
          }
        }
        return best;
      };
      const from = findBox(tail, 4) ?? findBox(tail, 12, 70) ?? vertical(tail, 'above');
      const to = findBox(tip, 6) ?? findBox(tip, 14, 70) ?? vertical(tip, 'below');
      if (!from || !to) {
        report.arrowsUnmatched.push({
          board: file,
          reason: !from ? 'tail not on a screen or portal' : 'tip not on a screen or portal',
          at: !from ? tail : tip,
        });
        continue;
      }
      const dashed = chain.some((s) => s.dashed);
      const yellow = chain.some((s) => /E0B400|FFD43B/i.test(s.color));
      // label: the label box just above a horizontal segment of the chain (or beside a vertical one)
      let label: string | undefined;
      let labelColor = '';
      let bestScore = Number.POSITIVE_INFINITY;
      let bestIdx = -1;
      for (const [li, l] of parsed.labels.entries()) {
        if (usedLabels.has(li)) continue;
        for (let i = 1; i < pts.length; i++) {
          const [a, c] = [pts[i - 1]!, pts[i]!];
          if (Math.abs(a[1] - c[1]) < 1) {
            const lo = Math.min(a[0], c[0]);
            const hi = Math.max(a[0], c[0]);
            const lx1 = l.x;
            const lx2 = l.x + (l.w || 200);
            const overlap = Math.min(hi, lx2) - Math.max(lo, lx1);
            const dy = a[1] - l.y;
            if (overlap > 10 && dy >= 10 && dy <= 60) {
              const score = Math.abs(dy - 36) + Math.max(0, 40 - overlap) * 0.1;
              if (score < bestScore) {
                bestScore = score;
                bestIdx = li;
              }
            }
          } else {
            const x = a[0];
            const lo = Math.min(a[1], c[1]);
            const hi = Math.max(a[1], c[1]);
            const dRight = Math.abs(l.x + (l.w || 0) - x);
            const dLeft = Math.abs(l.x - x);
            if (l.y >= lo - 30 && l.y <= hi + 10 && Math.min(dRight, dLeft) < 40) {
              const score = 50 + Math.min(dRight, dLeft);
              if (score < bestScore) {
                bestScore = score;
                bestIdx = li;
              }
            }
          }
        }
      }
      if (bestIdx >= 0) {
        usedLabels.add(bestIdx);
        label = parsed.labels[bestIdx]!.text;
        labelColor = parsed.labels[bestIdx]!.color;
      }
      let style: string | undefined;
      if (from === to || /8BE34A/i.test(labelColor) || label?.startsWith('↻')) style = 'loop';
      else if (dashed && yellow) style = 'new';
      else if (dashed) style = 'proposal';
      const arrow: Arrow = { from, to };
      if (label) arrow.label = label.replace(/^↻\s*/, '');
      if (style) arrow.style = style;
      if (style === 'proposal' && page.items[to]?.kind === 'screen' && /proposed|option/i.test(label ?? 'proposed'))
        (page.items[to] as { proposalFor?: string }).proposalFor = from;
      if (opts.keepRoutes && pts.length > 2) {
        // the route exactly as drawn (page coordinates); the canvas re-routes once an end is moved
        arrow.waypoints = pts
          .slice(1, -1)
          .map(([x, y]) => [Math.round(x + b.x), Math.round(y + b.y)] as [number, number]);
      }
      let aid = `${from}>${to}`;
      for (let i = 2; page.arrows[aid]; i++) aid = `${from}>${to}#${i}`;
      page.arrows[aid] = arrow;
      report.arrows++;
    }
    for (const [li, l] of parsed.labels.entries())
      if (!usedLabels.has(li)) report.labelsUnused.push({ board: file, text: l.text });
    for (const u of parsed.unknown) report.unknown.push({ board: file, html: u });
  }

  // portals that point at a whole lane ("→ OP paywall"): the section whose title mentions the code
  for (const t of pendingSectionTargets) {
    const sec = Object.entries(page.items).find(
      ([, it]) => it.kind === 'section' && new RegExp(`\\b${t.code}\\d`).test(it.title),
    );
    if (sec) (page.items[t.pid] as { target?: string }).target = sec[0];
  }
  report.portalsUnresolved = Object.values(page.items)
    .filter((it) => it.kind === 'portal' && !it.target)
    .map((it) => (it as { text: string }).text.replace(/\n/g, ' · '));
  // portals whose target is not a screen or section on this page
  for (const [id, it] of Object.entries(page.items)) {
    if (it.kind === 'portal' && it.target && !page.items[it.target]) {
      report.warnings.push(`Portal ${id} points at ${it.target}, which is not on the canvas`);
      delete (it as { target?: string }).target;
    }
  }

  // canvas notes and titles
  const fillToColor: Record<string, NoteColor> = {
    gray: 'grey',
    grey: 'grey',
    yellow: 'yellow',
    green: 'green',
    blue: 'blue',
    red: 'pink',
    pink: 'pink',
    orange: 'orange',
    purple: 'purple',
  };
  for (const [id, n] of notes) {
    if (n.kind === 'title1') {
      page.items[id] = { kind: 'text', x: Math.round(n.x), y: Math.round(n.y), text: n.text, size: 'h1' };
      report.texts++;
    } else if (!n.kind || n.kind === 'sticky') {
      page.items[id] = {
        kind: 'note',
        x: Math.round(n.x),
        y: Math.round(n.y),
        w: Math.round(n.w ?? n.maxW ?? 320),
        text: n.text,
        color: fillToColor[n.fill ?? 'yellow'] ?? 'yellow',
        by: 'import',
      };
      report.notes++;
    }
  }

  const project: ProjectDoc = {
    ...newProjectDoc(canvasName),
    frame: '390x844',
    presets: {},
    styles: [...new Set(sheetByCss.values())].map((s) => `styles/${s}`),
    fonts: [...fonts],
    statuses: [...IMPORT_STATUSES],
    defaultStatus: 'new',
  };
  for (const s of Object.keys(statusCount))
    if (!project.statuses!.some((d) => d.id === s))
      project.statuses!.push({
        ...(DEFAULT_STATUSES.find((d) => d.id === s) ?? { id: s, label: s, color: '#FFD43B', role: 'review' }),
        createdBy: 'import',
      } as StatusDef);
  fs.writeFileSync(path.join(out, 'project.json'), stringifyProject(project as never));
  fs.writeFileSync(path.join(out, 'pages', 'truth.json'), stringifyPage(page as never));
  report.statuses = statusCount;
  report.sheets = sheetByCss.size;
  report.assets = assetsCopied.size;
  fs.writeFileSync(path.join(out, 'import-report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(out, 'import-report.md'), reportMd(report));
  return report;
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

export function reportMd(r: ImportReport): string {
  const lines = [
    '# Import report',
    '',
    `- Boards: ${r.boards}`,
    `- Screens: ${r.screens}`,
    `- Arrows: ${r.arrows} (${r.arrowsUnmatched.length} not attached)`,
    `- Portals: ${r.portals} (${r.portalsUnresolved.length} without a target)`,
    `- Notes: ${r.notes} canvas notes, ${r.chips} chips under screens, ${r.texts} titles`,
    `- Statuses: ${Object.entries(r.statuses)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}`,
    `- CSS: ${Math.round(r.cssBytesBefore / 1024)} KB as drawn on the boards → ${Math.round(r.cssBytesAfter / 1024)} KB in ${r.sheets} shared stylesheets`,
    `- Images: ${r.assets} copied${r.missingAssets.length ? `, ${r.missingAssets.length} missing (${r.missingAssets.join(', ')})` : ''}`,
  ];
  if (r.arrowsUnmatched.length)
    lines.push(
      '',
      '## Arrows that could not be attached',
      ...r.arrowsUnmatched.map((a) => `- ${a.board} at ${a.at.map(Math.round).join(',')}: ${a.reason}`),
    );
  if (r.labelsUnused.length)
    lines.push('', '## Labels without an arrow', ...r.labelsUnused.map((l) => `- ${l.board}: ${l.text}`));
  if (r.unknown.length)
    lines.push(
      '',
      '## Board elements not imported',
      ...r.unknown.map((u) => `- ${u.board}: ${u.html.replace(/\n/g, ' ').slice(0, 160)}`),
    );
  if (r.warnings.length) lines.push('', '## Warnings', ...r.warnings.map((w) => `- ${w}`));
  return lines.join('\n') + '\n';
}
