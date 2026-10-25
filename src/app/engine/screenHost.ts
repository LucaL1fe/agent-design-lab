// Mounts a compiled screen inside a Shadow DOM host: real <html>/<body> elements in the shadow root, shared
// stylesheets adopted once per content hash, markup cloned from a cached <template> (no HTML parsing per mount).
// Used by the canvas and by the snapshot renderer, so both draw screens identically.
import type { CompiledScreenData } from '../../protocol/messages.ts';

export interface HostSource {
  compiled: (hash: string) => Promise<CompiledScreenData>;
  sheet: (hash: string) => Promise<string>;
}

const BASE_CSS = `:host{all:initial;display:block;position:relative;overflow:hidden;contain:strict;container:adl/size;background:#fff;color-scheme:light}
:host(.adl-paused) *,:host(.adl-paused) *::before,:host(.adl-paused) *::after{animation-play-state:paused!important}
:host(.adl-inert) *{pointer-events:none!important}`;

let baseSheet: CSSStyleSheet | undefined;
function base(): CSSStyleSheet {
  if (!baseSheet) {
    baseSheet = new CSSStyleSheet();
    baseSheet.replaceSync(BASE_CSS);
  }
  return baseSheet;
}

const sheets = new Map<string, Promise<CSSStyleSheet>>();
const fontLinks = new Set<string>();
const hoisted = new Set<string>();

function hashText(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export function sharedSheet(src: HostSource, hash: string): Promise<CSSStyleSheet> {
  let p = sheets.get(hash);
  if (!p) {
    p = src.sheet(hash).then((css) => {
      const s = new CSSStyleSheet();
      s.replaceSync(css);
      return s;
    });
    p.catch(() => sheets.delete(hash));
    sheets.set(hash, p);
  }
  return p;
}

function hoist(c: CompiledScreenData) {
  for (const href of c.hoisted.fontLinks) {
    if (fontLinks.has(href)) continue;
    fontLinks.add(href);
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    l.crossOrigin = 'anonymous';
    fontCss.push(
      new Promise<void>((r) => {
        l.onload = () => r();
        l.onerror = () => r();
      }),
    );
    document.head.appendChild(l);
  }
  if (c.hoisted.css) {
    const k = hashText(c.hoisted.css);
    if (!hoisted.has(k)) {
      hoisted.add(k);
      const s = document.createElement('style');
      s.dataset.adlHoist = k;
      s.textContent = c.hoisted.css;
      document.head.appendChild(s);
    }
  }
}

interface Prepared {
  data: CompiledScreenData;
  template: HTMLTemplateElement;
  local: CSSStyleSheet;
  shared: CSSStyleSheet[];
}

/** Prepared screens by compiled hash (LRU). Preparing parses HTML and CSS once; mounting only clones. */
const prepared = new Map<string, Promise<Prepared>>();
const MAX_PREPARED = 400;

export function prepare(src: HostSource, hash: string): Promise<Prepared> {
  let p = prepared.get(hash);
  if (p) {
    prepared.delete(hash);
    prepared.set(hash, p);
    return p;
  }
  p = (async () => {
    const data = await src.compiled(hash);
    const shared = await Promise.all(data.sheets.map((h) => sharedSheet(src, h)));
    const template = document.createElement('template');
    template.innerHTML = data.body;
    const local = new CSSStyleSheet();
    local.replaceSync(data.localCss);
    hoist(data);
    return { data, template, local, shared };
  })();
  p.catch(() => prepared.delete(hash));
  prepared.set(hash, p);
  while (prepared.size > MAX_PREPARED) prepared.delete(prepared.keys().next().value!);
  return p;
}

export function isPrepared(hash: string): boolean {
  return prepared.has(hash);
}

const TRANSPARENT = /^(transparent|rgba\(0, 0, 0, 0\))$/;

/** Mount (or re-mount) a prepared screen into a host element. Returns the shadow root. */
export function mountPrepared(host: HTMLElement, p: Prepared): ShadowRoot {
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  root.adoptedStyleSheets = [base(), ...p.shared, p.local];
  const html = document.createElement('html');
  const body = document.createElement('body');
  for (const [k, v] of Object.entries(p.data.htmlAttrs)) html.setAttribute(k, v);
  for (const [k, v] of Object.entries(p.data.bodyAttrs)) body.setAttribute(k, v);
  body.appendChild(p.template.content.cloneNode(true));
  html.appendChild(body);
  root.replaceChildren(html);
  propagateBackground(host, html, body);
  return root;
}

/** In a page, the root (or body) background paints the whole window. Mimic that on the host. */
export function propagateBackground(host: HTMLElement, html: HTMLElement, body: HTMLElement) {
  host.style.removeProperty('background');
  const hs = getComputedStyle(html);
  const from = !TRANSPARENT.test(hs.backgroundColor) || hs.backgroundImage !== 'none' ? hs : undefined;
  let src = from;
  if (!src) {
    const bs = getComputedStyle(body);
    if (!TRANSPARENT.test(bs.backgroundColor) || bs.backgroundImage !== 'none') {
      src = bs;
      body.style.setProperty('background', 'transparent', 'important');
    }
  }
  if (src) {
    host.style.backgroundColor = src.backgroundColor;
    if (src.backgroundImage !== 'none') {
      host.style.backgroundImage = src.backgroundImage;
      host.style.backgroundSize = src.backgroundSize;
      host.style.backgroundPosition = src.backgroundPosition;
      host.style.backgroundRepeat = src.backgroundRepeat;
    }
  }
  const scheme = hs.colorScheme;
  if (scheme && scheme !== 'normal' && !src)
    host.style.backgroundColor = /dark/.test(scheme) && !/light/.test(scheme) ? '#121212' : '#fff';
}

export function unmount(host: HTMLElement) {
  host.shadowRoot?.replaceChildren();
}

export function setPaused(host: HTMLElement, paused: boolean) {
  host.classList.toggle('adl-paused', paused);
}

/** Freeze every animation at `t` ms (snapshots, fidelity checks). */
export function seekAnimations(root: ShadowRoot | Document, t: number) {
  for (const a of root.getAnimations()) {
    try {
      a.pause();
      a.currentTime = t;
    } catch {
      // some animations cannot be seeked
    }
  }
}

/** Wait for fonts and images inside a mounted screen (bounded). */
/** Web font stylesheets (e.g. Google Fonts) added to the document, until they have loaded. */
const fontCss: Promise<void>[] = [];

/** Wait until a mounted screen looks final: font stylesheets loaded, its fonts fetched, images decoded. */
export async function settle(root: ShadowRoot, timeout = 4000): Promise<void> {
  const until = Date.now() + timeout;
  const left = () => Math.max(0, until - Date.now());
  const race = (p: Promise<unknown>) => Promise.race([p, new Promise((r) => setTimeout(r, left()))]);
  await race(Promise.all(fontCss));
  // fonts are only requested once text using them is laid out: lay out first, then wait for every pending font
  (root.host as HTMLElement).getBoundingClientRect();
  await new Promise((r) => requestAnimationFrame(r));
  await race(document.fonts.ready);
  while (document.fonts.status === 'loading' && left() > 0) await race(document.fonts.ready);
  const imgs = [...root.querySelectorAll('img')] as HTMLImageElement[];
  const work = Promise.all([
    document.fonts.ready,
    ...imgs.map((i) =>
      i.complete
        ? i.decode().catch(() => undefined)
        : new Promise((r) => {
            i.addEventListener('load', r, { once: true });
            i.addEventListener('error', r, { once: true });
          }),
    ),
  ]);
  await race(work);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

/** Full content height of a mounted screen (for auto-height frames such as long web pages). */
export function contentHeight(root: ShadowRoot): number {
  const html = root.querySelector('html');
  if (!html) return 0;
  return Math.ceil(Math.max(html.scrollHeight, html.getBoundingClientRect().height));
}

/** Element rectangles for data-adl-anchor names, relative to the host. */
export function anchorRects(
  host: HTMLElement,
  root: ShadowRoot,
): Record<string, { x: number; y: number; w: number; h: number }> {
  const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
  const hr = host.getBoundingClientRect();
  const sx = hr.width / (host.offsetWidth || hr.width || 1);
  for (const el of root.querySelectorAll('[data-adl-anchor]')) {
    const r = el.getBoundingClientRect();
    out[(el as HTMLElement).dataset.adlAnchor!] = {
      x: (r.left - hr.left) / sx,
      y: (r.top - hr.top) / sx,
      w: r.width / sx,
      h: r.height / sx,
    };
  }
  return out;
}

export function fetchSource(base: string, pid: string): HostSource {
  const enc = encodeURIComponent(pid);
  return {
    compiled: async (hash) => {
      const r = await fetch(`${base}/api/p/${enc}/c/${hash}`);
      if (!r.ok) throw new Error(`screen ${hash}: ${r.status}`);
      return (await r.json()) as CompiledScreenData;
    },
    sheet: async (hash) => {
      const r = await fetch(`${base}/api/p/${enc}/s/${hash}`);
      if (!r.ok) throw new Error(`sheet ${hash}: ${r.status}`);
      return r.text();
    },
  };
}
