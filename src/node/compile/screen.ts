// Compiles a screen's standalone HTML document into what the canvas mounts inside a Shadow DOM host:
// sanitized body markup, html/body attributes, local CSS, shared stylesheets (compiled once per content hash),
// document-level rules, searchable text, anchors and a cost profile.
import { type DefaultTreeAdapterMap, parse, serialize } from 'parse5';
import { sha } from '../fsutil.ts';
import {
  type CssContext,
  elementTokens,
  FONT_HOSTS,
  isRemote,
  type RuleCost,
  resolveRel,
  ruleCost,
  transformCss,
} from './css.ts';

export const COMPILER_VERSION = 4;

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];

export interface CompiledSheet {
  hash: string;
  file: string;
  css: string;
}

export interface CompiledScreen {
  v: number;
  hash: string;
  id: string;
  file: string;
  title?: string;
  frame?: string;
  /** `<meta name="adl:snapshot" content="ms">`: the moment this screen's still pictures freeze its animations, for
   * screens whose look settles later than the project's snapshotAt. */
  snapshotAt?: number;
  htmlAttrs: Record<string, string>;
  bodyAttrs: Record<string, string>;
  body: string;
  /** Shared stylesheets (hashes, in document order). */
  sheets: string[];
  localCss: string;
  hoisted: { fontLinks: string[]; css: string };
  text: string;
  anchors: string[];
  gos: { el?: string; to: string }[];
  /** `data-adl-sound`: files played in time with their element's animation (only screens that have any). */
  sounds?: ScreenSound[];
  deps: string[];
  cost: { keyframes: number; animations: number; infinite: number; backdrop: number; bytes: number };
  warnings: string[];
}

export interface ScreenSound {
  /** Project-relative audio file. */
  src: string;
  /** The element that makes the sound: its anchor, id, or tag and classes. */
  el: string;
  /** Milliseconds into each round of the element's animation (into the screen when it has none). */
  at?: number;
}

export interface CompileContext {
  /** Project-relative path of the screen file (e.g. screens/T4.html). */
  file: string;
  id: string;
  fileUrl: CssContext['fileUrl'];
  readFile: CssContext['readFile'];
  remote?: CssContext['remote'];
  /** Compiled shared sheets by project-relative path, filled as a cache across screens. */
  sheetCache: Map<
    string,
    {
      key: string;
      sheet: CompiledSheet;
      hoisted: string;
      fontLinks: string[];
      deps: string[];
      warnings: string[];
      cost: CompiledScreen['cost'];
      rules: RuleCost[];
    }
  >;
  /** Content hash of a project file (for cache keys); undefined when missing. */
  fileHash: (rel: string) => string | undefined;
}

const DROP_ELEMENTS = new Set([
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'base',
  'noscript',
  'portal',
  'meta',
]);
const URL_ATTRS = new Set([
  'src',
  'href',
  'poster',
  'xlink:href',
  'action',
  'formaction',
  'data',
  'background',
  'cite',
  'longdesc',
  'srcset',
]);
const AUDIO = /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|webm)$/i;
const DANGEROUS_URL = /^\s*(javascript|vbscript|data:text\/html|data:application\/(x-)?javascript)/i;
const KEEP_ROOT_ATTR = /^(class|id|lang|dir|style|data-[\w-]+|aria-[\w-]+|role|title)$/i;

const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value;
const isEl = (n: Node): n is Element => 'tagName' in n;

function children(n: Node): Node[] {
  const c = (n as ParentNode).childNodes ?? [];
  if (isEl(n) && n.tagName === 'template')
    return [...c, ...((n as unknown as { content: ParentNode }).content?.childNodes ?? [])];
  return c;
}

function find(n: Node, tag: string): Element | undefined {
  if (isEl(n) && n.tagName === tag) return n;
  for (const c of children(n)) {
    const f = find(c, tag);
    if (f) return f;
  }
  return undefined;
}

function rootAttrs(el: Element | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of el?.attrs ?? []) if (KEEP_ROOT_ATTR.test(a.name)) out[a.name] = a.value;
  return out;
}

export function compileScreen(html: string, ctx: CompileContext): { screen: CompiledScreen; sheets: CompiledSheet[] } {
  const warnings: string[] = [];
  const deps = new Set<string>([ctx.file]);
  const doc = parse(html);
  const htmlEl = find(doc, 'html');
  const head = find(doc, 'head');
  const body = find(doc, 'body');
  const title = head ? textOf(find(head, 'title')).trim() || undefined : undefined;
  let frame: string | undefined;
  let snapshotAt: number | undefined;
  const fontLinks: string[] = [];
  const sheetFiles: string[] = [];
  const remoteSheets: string[] = [];
  const localCss: string[] = [];

  const collectStyle = (el: Element) => {
    localCss.push(textOf(el));
  };
  const collectLink = (el: Element) => {
    const rel = (attr(el, 'rel') ?? '').toLowerCase();
    const href = attr(el, 'href');
    if (!href || !rel.split(/\s+/).includes('stylesheet')) return;
    if (FONT_HOSTS.test(href)) fontLinks.push(href);
    else if (isRemote(href)) remoteSheets.push(href.startsWith('//') ? `https:${href}` : href);
    else {
      const r = resolveRel(ctx.file, href);
      if (r) sheetFiles.push(r);
      else warnings.push(`Stylesheet ${href} is outside the project`);
    }
  };
  for (const n of head ? children(head) : []) {
    if (!isEl(n)) continue;
    if (n.tagName === 'style') collectStyle(n);
    else if (n.tagName === 'link') collectLink(n);
    else if (n.tagName === 'meta' && attr(n, 'name') === 'adl:frame') frame = attr(n, 'content')?.trim() || undefined;
    else if (n.tagName === 'meta' && attr(n, 'name') === 'adl:snapshot') {
      const ms = Number(attr(n, 'content')?.trim().replace(/ms$/, ''));
      if (attr(n, 'content')?.trim() && Number.isFinite(ms) && ms >= 0) snapshotAt = Math.round(ms);
      else warnings.push(`adl:snapshot "${attr(n, 'content') ?? ''}" is not a number of milliseconds`);
    }
  }

  // sanitize the body, pulling out <style> and stylesheet <link>s, rewriting asset URLs
  const text: string[] = [];
  const anchors = new Set<string>();
  const gos: { el?: string; to: string }[] = [];
  let removed = 0;
  const clean = (parent: ParentNode) => {
    const kids = parent.childNodes;
    for (let i = kids.length - 1; i >= 0; i--) {
      const n = kids[i]!;
      if (!isEl(n)) {
        if (n.nodeName === '#text') text.push((n as unknown as { value: string }).value);
        continue;
      }
      const tag = n.tagName;
      if (tag === 'style') {
        collectStyle(n);
        kids.splice(i, 1);
        continue;
      }
      if (tag === 'link') {
        collectLink(n);
        kids.splice(i, 1);
        continue;
      }
      if (DROP_ELEMENTS.has(tag) || (tag === 'script' && n.namespaceURI?.includes('svg'))) {
        if (tag === 'script' || tag === 'iframe' || tag === 'object' || tag === 'embed') removed++;
        kids.splice(i, 1);
        continue;
      }
      if ((tag === 'animate' || tag === 'set') && n.attrs.some((a) => DANGEROUS_URL.test(a.value))) {
        kids.splice(i, 1);
        continue;
      }
      n.attrs = n.attrs.filter((a) => {
        const name = a.name.toLowerCase();
        if (name.startsWith('on')) {
          removed++;
          return false;
        }
        if (name === 'srcdoc') return false;
        if (URL_ATTRS.has(name) && DANGEROUS_URL.test(a.value)) return false;
        return true;
      });
      for (const a of n.attrs) {
        const name = a.name.toLowerCase();
        if (name === 'data-adl-anchor' && a.value) anchors.add(a.value);
        if (name === 'alt' || name === 'aria-label' || name === 'placeholder' || name === 'title') text.push(a.value);
        if (name === 'style' && /url\(/i.test(a.value)) {
          const r = transformCss(`x{${a.value}}`, cssCtx(ctx, ctx.file));
          for (const d of r.deps) deps.add(d);
          a.value = r.css.replace(/^x\s*\{\s*/, '').replace(/\s*\}\s*$/, '');
        } else if (name === 'srcset') {
          a.value = a.value
            .split(',')
            .map((part) => {
              const [u, ...rest] = part.trim().split(/\s+/);
              const r = u ? resolveRel(ctx.file, u) : undefined;
              if (!r) return part.trim();
              deps.add(r);
              return [ctx.fileUrl(r), ...rest].join(' ');
            })
            .join(', ');
        } else if (
          (name === 'src' ||
            name === 'poster' ||
            name === 'xlink:href' ||
            (name === 'href' && (tag === 'image' || tag === 'use'))) &&
          a.value
        ) {
          const r = resolveRel(ctx.file, a.value);
          if (r) {
            deps.add(r);
            a.value = ctx.fileUrl(r) + (a.value.includes('#') ? a.value.slice(a.value.indexOf('#')) : '');
          }
        }
      }
      const go = attr(n, 'data-adl-go');
      if (go) {
        const el = attr(n, 'data-adl-anchor');
        gos.push(el ? { el, to: go } : { to: go });
      }
      clean(n as unknown as ParentNode);
      if (tag === 'template') {
        const content = (n as unknown as { content?: ParentNode }).content;
        if (content) clean(content);
      }
    }
  };
  if (body) clean(body as unknown as ParentNode);
  const sounds = body ? collectSounds(body, ctx, deps, warnings) : [];
  if (removed)
    warnings.push(
      `Removed ${removed} script${removed === 1 ? '' : 's'} or event handler${removed === 1 ? '' : 's'}: screens are HTML and CSS only`,
    );

  // shared sheets (project files and fetched remote CSS), compiled once per file content
  const sheets: CompiledSheet[] = [];
  const sheetHashes: string[] = [];
  const hoistedCss: string[] = [];
  const cost = { keyframes: 0, animations: 0, infinite: 0, backdrop: 0, bytes: 0 };
  // animations and blurs count only where their rule can match this screen: a shared stylesheet that holds rules for
  // many screens would otherwise make every screen that links it look expensive
  const tokens = new Set<string>();
  const collectTokens = (n: Node) => {
    if (isEl(n)) elementTokens(n.attrs, tokens);
    for (const c of children(n)) collectTokens(c);
  };
  if (htmlEl) collectTokens(htmlEl);
  const addCost = (c: { keyframes: number }, rules: RuleCost[]) => {
    const r = ruleCost(rules, tokens);
    cost.keyframes += c.keyframes;
    cost.animations += r.animations;
    cost.infinite += r.infinite;
    cost.backdrop += r.backdrop;
  };
  const sheetFrom = (key: string, cacheKey: string, sourceText: string | undefined, from: string) => {
    let c = ctx.sheetCache.get(key);
    if (!c || c.key !== cacheKey) {
      if (sourceText === undefined) {
        warnings.push(`Stylesheet ${from} not found`);
        return;
      }
      const r = transformCss(sourceText, cssCtx(ctx, from));
      const hash = sha(`${COMPILER_VERSION}:${r.css}`);
      c = {
        key: cacheKey,
        sheet: { hash, file: from, css: r.css },
        hoisted: r.hoisted,
        fontLinks: r.fontLinks,
        deps: r.deps,
        warnings: r.warnings,
        cost: { ...r.cost, bytes: r.css.length },
        rules: r.rules,
      };
      ctx.sheetCache.set(key, c);
    }
    deps.add(from);
    for (const d of c.deps) deps.add(d);
    warnings.push(...c.warnings);
    fontLinks.push(...c.fontLinks);
    if (c.hoisted) hoistedCss.push(c.hoisted);
    addCost(c.cost, c.rules);
    if (!sheetHashes.includes(c.sheet.hash)) {
      sheetHashes.push(c.sheet.hash);
      sheets.push(c.sheet);
    }
  };
  for (const f of sheetFiles) {
    const h = ctx.fileHash(f);
    sheetFrom(f, `${COMPILER_VERSION}:${h}:${depsKey(ctx, f)}`, h === undefined ? undefined : ctx.readFile(f), f);
  }
  for (const url of remoteSheets) {
    const t = ctx.remote?.(url);
    if (t === undefined) warnings.push(`Remote stylesheet ${url} could not be loaded`);
    else sheetFrom(`remote:${url}`, `${COMPILER_VERSION}:${sha(t)}`, t, ctx.file);
  }

  const local = transformCss(localCss.join('\n'), cssCtx(ctx, ctx.file));
  for (const d of local.deps) deps.add(d);
  warnings.push(...local.warnings);
  fontLinks.push(...local.fontLinks);
  if (local.hoisted) hoistedCss.push(local.hoisted);
  addCost(local.cost, local.rules);
  cost.bytes = local.css.length;

  const bodyHtml = body ? serialize(body as unknown as ParentNode) : '';
  const searchText = text.join(' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
  const out: Omit<CompiledScreen, 'hash'> = {
    v: COMPILER_VERSION,
    id: ctx.id,
    file: ctx.file,
    ...(title ? { title } : {}),
    ...(frame ? { frame } : {}),
    ...(snapshotAt !== undefined ? { snapshotAt } : {}),
    htmlAttrs: rootAttrs(htmlEl),
    bodyAttrs: rootAttrs(body),
    body: bodyHtml,
    sheets: sheetHashes,
    localCss: local.css,
    hoisted: { fontLinks: [...new Set(fontLinks)], css: [...new Set(hoistedCss)].join('\n') },
    text: searchText,
    anchors: [...anchors],
    gos,
    ...(sounds.length ? { sounds } : {}),
    deps: [...deps],
    cost,
    warnings: lint(cost, local.css.length, warnings),
  };
  const hash = sha(JSON.stringify(out));
  return { screen: { ...out, hash }, sheets };
}

/** `data-adl-sound` and `data-adl-sound-at`, in document order: files resolved and rewritten like an image's src, times
 * normalised to milliseconds, so the canvas only reads numbers and URLs. */
function collectSounds(root: Node, ctx: CompileContext, deps: Set<string>, warnings: string[]): ScreenSound[] {
  const out: ScreenSound[] = [];
  const walk = (n: Node) => {
    if (isEl(n)) {
      const sound = n.attrs.find((a) => a.name === 'data-adl-sound');
      const at = n.attrs.find((a) => a.name === 'data-adl-sound-at');
      let ms: number | undefined;
      if (at) {
        ms = parseTime(at.value);
        if (ms === undefined) {
          warnings.push(`data-adl-sound-at "${at.value}" is not a time (e.g. 400ms or 0.4s)`);
          n.attrs = n.attrs.filter((a) => a !== at);
        } else if (!sound) warnings.push('data-adl-sound-at without data-adl-sound on the same element');
        else at.value = String(ms);
      }
      if (sound) {
        const value = sound.value.trim();
        const rel = value ? resolveRel(ctx.file, value) : undefined;
        if (!rel || !AUDIO.test(rel)) {
          warnings.push(
            !value
              ? 'data-adl-sound is empty'
              : !rel
                ? `Sound ${value} is not a file in the project`
                : `Sound ${value} is not an audio file (mp3, wav, ogg, m4a, aac, flac, opus or webm)`,
          );
          n.attrs = n.attrs.filter((a) => a !== sound);
        } else {
          if (ctx.fileHash(rel) === undefined) warnings.push(`Sound ${value} not found`);
          deps.add(rel);
          sound.value = ctx.fileUrl(rel);
          out.push({ src: rel, el: elementLabel(n), ...(ms !== undefined ? { at: ms } : {}) });
        }
      }
    }
    for (const c of children(n)) walk(c);
  };
  walk(root);
  return out;
}

/** "400", "400ms" or "0.4s" in milliseconds; undefined when it is not a time. */
export function parseTime(v: string): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s)?\s*$/i.exec(v);
  if (!m) return undefined;
  return Math.round(Number(m[1]) * (m[2]?.toLowerCase() === 's' ? 1000 : 1));
}

/** How a person finds an element again: its anchor, else its id, else its tag and first classes. */
function elementLabel(n: Element): string {
  const anchor = attr(n, 'data-adl-anchor');
  if (anchor) return `[data-adl-anchor="${anchor}"]`;
  const id = attr(n, 'id');
  if (id) return `#${id}`;
  const classes = (attr(n, 'class') ?? '').split(/\s+/).filter(Boolean).slice(0, 2);
  return n.tagName + classes.map((c) => `.${c}`).join('');
}

function depsKey(ctx: CompileContext, file: string): string {
  // local @imports inside a sheet change the sheet too; cheap approximation: hash of the import list targets
  const text = ctx.readFile(file);
  if (!text || !/@import/i.test(text)) return '';
  const imports = [...text.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s]+)/gi)]
    .map((m) => resolveRel(file, m[1]!))
    .filter(Boolean) as string[];
  return imports.map((f) => ctx.fileHash(f) ?? '-').join(',');
}

function cssCtx(ctx: CompileContext, from: string): CssContext {
  return { from, fileUrl: ctx.fileUrl, readFile: ctx.readFile, ...(ctx.remote ? { remote: ctx.remote } : {}) };
}

function textOf(n: Node | undefined): string {
  if (!n) return '';
  if (n.nodeName === '#text') return (n as unknown as { value: string }).value;
  return children(n).map(textOf).join('');
}

function lint(cost: CompiledScreen['cost'], localBytes: number, warnings: string[]): string[] {
  const out = [...new Set(warnings)];
  if (localBytes > 20_000)
    out.push(
      `This screen has ${Math.round(localBytes / 1000)} KB of its own CSS: move shared rules into styles/ so they load once`,
    );
  if (cost.infinite > 30)
    out.push(`${cost.infinite} endless animations: screens with many endless animations slow the canvas down`);
  if (cost.backdrop > 6) out.push(`${cost.backdrop} backdrop-filter blurs: each one is expensive to draw`);
  return out;
}
