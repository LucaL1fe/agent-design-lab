// The canvas renderer. Cost per frame depends on what is on screen, never on how big the document is:
//   far screens (narrower than ~40 px on screen) are drawn into one canvas from small snapshot sprites,
//   mid-size screens are <img> snapshots at a resolution that matches their size,
//   big screens run live in Shadow DOM hosts, within a budget, mounted only when the view is still.
// Sections, notes, texts, portals and images are light DOM; arrows are one SVG; section titles live in screen space.

import { buildDef, countBuild, progressText, shownCapture } from '../../core/build.ts';
import { resolveFrame } from '../../core/frames.ts';
import { screenHeadHeight } from '../../core/layout.ts';
import { headD, pathD, type Route, routeAll, trimEnd } from '../../core/route.ts';
import { arrowStyle, countStatuses, countsText, findStatus, showsBanner, statusInk } from '../../core/status.ts';
import type { Arrow, Capture, Id, Item, PageDoc, Rect, ScreenItem } from '../../core/types.ts';
import type { ProjectModel } from '../state/project.ts';
import { beginFrame, image, onImageLoad, wasDeferred } from './images.ts';
import { fetchSource, isPrepared, mountPrepared, prepare, setPaused, unmount } from './screenHost.ts';
import { GridIndex } from './spatial.ts';
import { type GesturePhase, keepInView, stickyTitle, type View, Viewport } from './viewport.ts';

export const TIER_MOSAIC = 40; // below this on-screen width a screen is a sprite in the mosaic canvas
export const TIER_LIVE_IN = 150; // at or above this it may run live (45 % zoom on a phone screen)
export const TIER_LIVE_OUT = 120; // hysteresis
export const HEAD_H = 54; // caption + banner space above a screen (world px)

type Tier = 'mosaic' | 'picture' | 'live';

interface ScreenNode {
  id: Id;
  el: HTMLDivElement;
  frame: HTMLDivElement;
  img?: HTMLImageElement;
  host?: HTMLDivElement;
  ph?: HTMLDivElement;
  head: HTMLDivElement;
  tier: Tier;
  liveHash?: string;
  mounting?: boolean;
  imgSize?: number;
  key: string;
  /** The real product's capture shown in a device view (an <img>, or a <video> while it plays). */
  cap?: HTMLImageElement | HTMLVideoElement;
  capKey?: string;
}

const SPEAKER =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path class="w1" d="M15.5 8.5a5 5 0 0 1 0 7"/><path class="w2" d="M18.6 5.4a9.5 9.5 0 0 1 0 13.2"/><path class="x" d="m16 9 6 6m0-6-6 6"/></svg>';

/** Videos that may play at once in a device view (decoding is the cost). */
const VIDEO_BUDGET = 6;

export function fileUrl(pid: string, src: string, version?: string): string {
  const path = src.split('/').map(encodeURIComponent).join('/');
  return `/api/p/${encodeURIComponent(pid)}/f/${path}${version ? `?v=${encodeURIComponent(version)}` : ''}`;
}

export interface EngineOptions {
  /** Called when the visible set or zoom changes (for the server's snapshot priorities, the URL, the zoom label). */
  onView?: (v: View, visible: Id[], phase: GesturePhase) => void;
  liveBudget?: number;
}

export type FrameHook = (v: View) => void;

export class Engine {
  readonly model: ProjectModel;
  pageId: string;
  readonly vp: Viewport;
  readonly root: HTMLElement;
  readonly world: HTMLDivElement;
  readonly overlay: HTMLDivElement;
  private layers: Record<'sections' | 'mosaic' | 'arrows' | 'items' | 'notes' | 'labels', HTMLElement>;
  private mosaic: HTMLCanvasElement;
  private mctx: CanvasRenderingContext2D;
  readonly index = new GridIndex(1024);
  rects = new Map<Id, Rect>();
  routes = new Map<Id, Route>();
  private screens = new Map<Id, ScreenNode>();
  private others = new Map<Id, HTMLElement>();
  private sectionTitles = new Map<Id, HTMLDivElement>();
  private arrowEls = new Map<Id, { g: SVGGElement; label?: HTMLDivElement }>();
  private liveLru: Id[] = [];
  private src;
  private raf = 0;
  private unsub: (() => void)[] = [];
  private placementKey: unknown;
  liveBudget: number;
  paused = false;
  /** Screens that must stay live (selected, hovered, search hit). */
  boost = new Set<Id>();
  dim = new Set<Id>();
  /** The screen with the search ring (⌘K's current result). */
  hit: Id | undefined;
  /** The screen playing its sounds: it runs live whenever it is in view, even when small. */
  audible: Id | undefined;
  private opts: EngineOptions;
  private visibleIds: Id[] = [];
  private lastFrame = 0;
  private slowWindows = 0;
  private goodSince = performance.now();
  private frameTimes: number[] = [];
  animationsSetting: 'auto' | 'always' | 'never' = 'auto';
  /** 'design', or a device ("phone", "tablet"): every screen then shows the real product's capture for it. */
  appView = 'design';
  /** Section titles stick to the left edge while their section runs off-screen; a tiled capture turns that off, or
   *  every tile would pin its own copy of the title. */
  stickyTitles = true;
  /** Called at the end of every frame (the interaction overlay draws selection, guides, handles). */
  hooks = new Set<FrameHook>();
  /** Items being dragged: their rectangles are offset until the drop is committed. */
  private preview?: { ids: Set<Id>; base: Map<Id, Rect> } | undefined;

  constructor(root: HTMLElement, model: ProjectModel, pageId: string, opts: EngineOptions = {}) {
    this.root = root;
    this.model = model;
    this.pageId = pageId;
    this.opts = opts;
    this.liveBudget = opts.liveBudget ?? 24;
    this.src = fetchSource('', model.id);
    root.classList.add('adl-viewport');
    this.world = document.createElement('div');
    this.world.className = 'adl-world';
    const mk = (cls: string, tag = 'div') => {
      const e = document.createElement(tag);
      e.className = cls;
      this.world.appendChild(e);
      return e;
    };
    this.layers = {
      sections: mk('layer sections'),
      mosaic: mk('layer mosaic-wrap'),
      arrows: document.createElementNS('http://www.w3.org/2000/svg', 'svg') as unknown as HTMLElement,
      items: mk('layer items'),
      notes: mk('layer notes'),
      labels: mk('layer labels'),
    };
    this.layers.arrows.setAttribute('class', 'layer arrows');
    this.world.insertBefore(this.layers.arrows, this.layers.items);
    this.mosaic = document.createElement('canvas');
    this.mosaic.className = 'mosaic';
    this.layers.mosaic.appendChild(this.mosaic);
    this.mctx = this.mosaic.getContext('2d', { alpha: true })!;
    root.appendChild(this.world);
    this.overlay = document.createElement('div');
    this.overlay.className = 'adl-overlay';
    root.appendChild(this.overlay);
    this.vp = new Viewport(root, this.world);
    this.vp.items = () => this.rects.values();
    this.unsub.push(this.vp.on((v, phase) => this.onView(v, phase)));
    this.unsub.push(
      model.on((kind) => {
        if (kind === 'docs' || kind === 'screens' || kind === 'snaps')
          this.invalidate(kind === 'docs' || kind === 'screens');
      }),
    );
    onImageLoad(() => this.schedule());
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.lostT);
    for (const u of this.unsub) u();
    this.vp.destroy();
    this.root.replaceChildren();
  }

  get page(): PageDoc | undefined {
    return this.model.docs.pages[this.pageId];
  }

  setPage(pageId: string) {
    this.pageId = pageId;
    for (const n of this.screens.values()) n.el.remove();
    this.screens.clear();
    for (const e of this.others.values()) e.remove();
    this.others.clear();
    for (const t of this.sectionTitles.values()) t.remove();
    this.sectionTitles.clear();
    for (const a of this.arrowEls.values()) {
      a.g.remove();
      a.label?.remove();
    }
    this.arrowEls.clear();
    this.liveLru = [];
    this.placementKey = undefined;
    this.invalidate(true);
  }

  setAppView(view: string) {
    if (view === this.appView) return;
    this.appView = view;
    this.root.classList.toggle('app-view', view !== 'design');
    this.invalidate(true);
  }

  private dirtyStructure = true;
  invalidate(structure = true) {
    if (structure) this.dirtyStructure = true;
    this.schedule();
  }

  schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.frame());
  }

  /** Render right now (after creating something the person will type into next). */
  renderNow() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.dirtyStructure = true;
    this.frame();
  }

  private onView(v: View, phase: GesturePhase) {
    this.root.classList.toggle('zoom-far', v.k < 0.14);
    this.root.classList.toggle('zoom-mid', v.k >= 0.14 && v.k < 0.35);
    this.root.classList.toggle('gesture', phase === 'active');
    this.schedule();
  }

  /** Everything that depends on the page document: rectangles, index, routes, non-screen DOM. */
  private rebuild() {
    const page = this.page;
    if (!page) return;
    const pl = this.model.placement(this.pageId);
    if (!pl) return;
    if ((this.placementKey !== pl || this.dirtyStructure) && !this.preview) {
      this.placementKey = pl;
      this.rects = pl.rects;
      this.checkLost();
      this.index.clear();
      for (const [id, r] of this.rects) {
        const it = page.items[id];
        if (!it || it.kind === 'section') continue;
        this.index.set(id, it.kind === 'screen' ? { x: r.x, y: r.y - HEAD_H, w: r.w, h: r.h + HEAD_H } : r);
      }
      this.syncOthers(page);
      this.syncArrows(page);
      // screens whose content or status changed: refresh their node
      for (const [id, n] of this.screens) {
        const it = page.items[id];
        if (!it || it.kind !== 'screen' || !this.rects.has(id)) {
          this.dropScreen(n);
          continue;
        }
        const key = this.screenKey(id, it);
        if (key !== n.key) this.updateScreenNode(n, id, it);
        const r = this.rects.get(id)!;
        place(n.el, r);
      }
    }
    this.dirtyStructure = false;
  }

  private screenKey(id: Id, it: Item): string {
    if (it.kind !== 'screen') return '';
    const meta = this.model.screenOf(id, it);
    const snap = this.model.snapOf(id, it);
    const cap = this.appView === 'design' ? undefined : shownCapture(it.build, this.appView);
    return `${meta?.hash ?? '-'}|${snap?.url ?? '-'}|${it.status ?? ''}|${it.banner ?? ''}|${it.title ?? ''}|${meta?.title ?? ''}|${it.proposalFor ?? ''}|${it.build?.state ?? ''}|${this.appView}|${cap ? `${cap.src}@${cap.at ?? ''}` : ''}`;
  }

  // ---------- non-screen items ----------

  private syncOthers(page: PageDoc) {
    const seen = new Set<Id>();
    const project = this.model.docs.project;
    for (const [id, it] of Object.entries(page.items)) {
      if (it.kind === 'screen' || (it.archived && page.kind !== 'history')) continue;
      const r = this.rects.get(id);
      if (!r) continue;
      seen.add(id);
      let el = this.others.get(id);
      const sig = JSON.stringify(it);
      if (el && el.dataset.sig !== sig && (it.kind === 'note' || it.kind === 'text') && el.dataset.kind === it.kind) {
        // update in place: keeps focus and the caret while someone is typing in it
        el.className =
          it.kind === 'note'
            ? `it note note-${it.color ?? 'yellow'}${it.resolved ? ' resolved' : ''}${it.size === 'small' ? ' small' : ''}`
            : `it txt txt-${it.size ?? 'h2'}`;
        if (el.isContentEditable) el.classList.add('editing');
        else if (el.textContent !== it.text) el.textContent = it.text;
        el.dataset.sig = sig;
      }
      if (!el || el.dataset.sig !== sig) {
        el?.remove();
        el = this.buildOther(id, it);
        el.dataset.sig = sig;
        this.others.set(id, el);
        (it.kind === 'section'
          ? this.layers.sections
          : it.kind === 'note' || it.kind === 'text'
            ? this.layers.notes
            : this.layers.items
        ).appendChild(el);
      }
      place(el, r, it.kind === 'note' || it.kind === 'text');
      if (it.kind === 'section') {
        let t = this.sectionTitles.get(id);
        if (!t) {
          t = document.createElement('div');
          t.className = 'sec-title';
          t.dataset.id = id;
          t.innerHTML =
            '<span class="t"></span><span class="cnt"></span><button class="ic focus" title="Zoom to this section" data-act="focus"></button><button class="ic png" title="Download as PNG" data-act="png"></button>';
          this.overlay.appendChild(t);
          this.sectionTitles.set(id, t);
        }
        t.querySelector('.t')!.textContent = it.title;
        const built = progressText(countBuild(page, id));
        t.querySelector('.cnt')!.textContent = [countsText(countStatuses(project, page, id)), built]
          .filter(Boolean)
          .join(' · ');
      }
    }
    for (const [id, el] of this.others) {
      if (seen.has(id)) continue;
      el.remove();
      this.others.delete(id);
      this.sectionTitles.get(id)?.remove();
      this.sectionTitles.delete(id);
    }
  }

  private buildOther(id: Id, it: Item): HTMLElement {
    const el = document.createElement('div');
    el.dataset.id = id;
    el.dataset.kind = it.kind;
    switch (it.kind) {
      case 'section':
        el.className = 'it sec';
        break;
      case 'note':
        el.className = `it note note-${it.color ?? 'yellow'}${it.resolved ? ' resolved' : ''}${it.size === 'small' ? ' small' : ''}`;
        el.textContent = it.text;
        break;
      case 'text':
        el.className = `it txt txt-${it.size ?? 'h2'}`;
        el.textContent = it.text;
        break;
      case 'portal': {
        el.className = 'it portal';
        const [first, ...rest] = it.text.split('\n');
        const t = document.createElement('div');
        t.className = 'pt';
        t.textContent = first ?? '';
        el.appendChild(t);
        if (rest.length) {
          const s = document.createElement('div');
          s.className = 'ps';
          s.textContent = rest.join(' ');
          el.appendChild(s);
        }
        break;
      }
      case 'image': {
        el.className = 'it image';
        const img = document.createElement('img');
        img.src = `/api/p/${encodeURIComponent(this.model.id)}/f/${it.src.split('/').map(encodeURIComponent).join('/')}`;
        img.alt = it.title ?? '';
        img.draggable = false;
        el.appendChild(img);
        break;
      }
    }
    return el;
  }

  // ---------- arrows ----------

  /** Caption + banner height above a screen (0 for other items), so arrows attach above it. */
  private headOf(page: PageDoc, id: Id): number {
    const it = page.items[id];
    if (it?.kind !== 'screen') return 0;
    const r = this.rects.get(id);
    const project = this.model.docs.project;
    const banner = showsBanner(project, it.status)
      ? `${findStatus(project, it.status)?.label ?? it.status ?? ''}${it.banner ? ` · ${it.banner}` : ''}`
      : undefined;
    return screenHeadHeight(banner, r?.w ?? 393) + 6;
  }

  private syncArrows(page: PageDoc) {
    const project = this.model.docs.project;
    const obstacles = new Map<Id, Rect>();
    const labelAvoid: Rect[] = [];
    for (const [id, r] of this.rects) {
      const k = page.items[id]?.kind;
      if (k === 'screen' || k === 'portal' || k === 'image') obstacles.set(id, r);
      else if (k === 'note' || k === 'text') labelAvoid.push(r);
    }
    const inputs = Object.entries(page.arrows)
      .filter(([, a]) => this.rects.has(a.from) && this.rects.has(a.to))
      .map(([id, arrow]) => ({
        id,
        arrow,
        from: this.rects.get(arrow.from)!,
        to: this.rects.get(arrow.to)!,
        fromHead: this.headOf(page, arrow.from),
        toHead: this.headOf(page, arrow.to),
      }));
    this.routes = routeAll(inputs, { obstacles, headroom: HEAD_H + 8, labelAvoid });
    const seen = new Set<Id>();
    const svg = this.layers.arrows as unknown as SVGSVGElement;
    for (const { id, arrow } of inputs) {
      const route = this.routes.get(id)!;
      seen.add(id);
      this.drawArrow(svg, id, arrow, route, arrowStyle(project, arrow.style));
    }
    for (const [id, a] of this.arrowEls) {
      if (seen.has(id)) continue;
      a.g.remove();
      a.label?.remove();
      this.arrowEls.delete(id);
    }
  }

  drawArrow(
    svg: SVGSVGElement,
    id: Id,
    arrow: Arrow,
    route: Route,
    style: { color: string; dash?: number[]; width?: number },
  ) {
    let a = this.arrowEls.get(id);
    if (!a) {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.dataset.id = id;
      g.innerHTML = '<path class="hit"/><path class="line"/><path class="head"/>';
      svg.appendChild(g);
      a = { g };
      this.arrowEls.set(id, a);
    }
    const pts = trimEnd(route.points, 6);
    const d = pathD(pts);
    const [hit, line, head] = a.g.children as unknown as SVGPathElement[];
    hit!.setAttribute('d', d);
    line!.setAttribute('d', d);
    line!.style.stroke = style.color;
    line!.style.strokeDasharray = style.dash?.join(' ') ?? '';
    line!.style.strokeWidth = String(style.width ?? 2.5);
    head!.setAttribute('d', headD(route.points, 13));
    head!.style.fill = style.color;
    if (arrow.label) {
      if (!a.label) {
        a.label = document.createElement('div');
        a.label.className = 'alab';
        a.label.dataset.id = id;
        this.layers.labels.appendChild(a.label);
      }
      a.label.textContent = arrow.label;
      a.label.style.left = `${route.label[0]}px`;
      a.label.style.top = `${route.label[1]}px`;
      a.label.classList.toggle('v', route.labelAxis === 'v');
      a.label.style.color = arrow.style === 'loop' ? style.color : '';
    } else if (a.label) {
      a.label.remove();
      delete a.label;
    }
  }

  // ---------- screens ----------

  private makeScreenNode(id: Id, it: Item & { kind: 'screen' }): ScreenNode {
    const el = document.createElement('div');
    el.className = 'it scr';
    el.dataset.id = id;
    const head = document.createElement('div');
    head.className = 'head';
    const frame = document.createElement('div');
    frame.className = 'frame';
    el.append(head, frame);
    const n: ScreenNode = { id, el, frame, head, tier: 'picture', key: '' };
    this.updateScreenNode(n, id, it);
    this.layers.items.appendChild(el);
    return n;
  }

  private updateScreenNode(n: ScreenNode, id: Id, it: Item) {
    if (it.kind !== 'screen') return;
    const project = this.model.docs.project;
    const meta = this.model.screenOf(id, it);
    const title = it.title ?? meta?.title;
    n.key = this.screenKey(id, it);
    const st = findStatus(project, it.status);
    const banner = showsBanner(project, it.status);
    n.head.replaceChildren();
    const cap = document.createElement('div');
    cap.className = 'cap';
    if (meta?.sounds?.length) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'snd';
      b.dataset.snd = id;
      b.setAttribute('aria-label', `Play ${id} with sound`);
      b.title = 'Sound: plays this screen with sound, every other screen stays quiet';
      b.innerHTML = SPEAKER;
      cap.append(b);
    }
    if (it.build) {
      // the build check: tied to the screen, next to its id
      const def = buildDef(it.build.state);
      const chip = document.createElement('span');
      chip.className = `bld bld-${it.build.state}`;
      chip.style.setProperty('--c', def?.color ?? '#7A7A73');
      chip.textContent = def?.label ?? it.build.state;
      if (it.build.note) chip.title = it.build.note;
      cap.append(chip);
    }
    const b = document.createElement('b');
    b.textContent = id;
    cap.append(b);
    if (title && title !== id) cap.append(document.createTextNode(` · ${title}`));
    n.head.appendChild(cap);
    if (banner) {
      const ban = document.createElement('div');
      ban.className = 'ban';
      const color = st?.color ?? '#FFD43B';
      ban.style.background = color;
      ban.style.color = st ? statusInk(st) : '#1F1A0A';
      const lb = document.createElement('b');
      lb.textContent = st?.label ?? it.status ?? '';
      ban.appendChild(lb);
      if (it.banner) ban.appendChild(document.createTextNode(` · ${it.banner}`));
      n.head.appendChild(ban);
    }
    n.el.classList.toggle('hasban', banner);
    n.el.classList.toggle('snd-on', this.audible === id);
    const appv = this.appView !== 'design';
    n.el.classList.toggle('appv', appv);
    n.el.classList.toggle('nocap', appv && !shownCapture(it.build, this.appView));
    if (appv) n.frame.dataset.nocap = `No ${this.appView} capture yet`;
    else delete n.frame.dataset.nocap;
    n.el.classList.toggle('proposal', !!it.proposalFor);
    const f = this.model.frameOf(id, it);
    const preset = resolveFrame(f.spec, project);
    const radius = preset?.radius ?? (f.w <= 480 ? 36 : 10);
    n.frame.style.borderRadius = `${radius}px`;
    n.frame.style.background = this.model.snapOf(id, it)?.avg ?? '#1b1b1a';
    const planned = !meta;
    n.el.classList.toggle('planned', planned);
    if (planned) {
      if (!n.ph) {
        n.ph = document.createElement('div');
        n.ph.className = 'ph';
        n.frame.appendChild(n.ph);
      }
      n.ph.textContent = 'Planned · no HTML yet';
    } else if (n.ph && meta) {
      n.ph.remove();
      delete n.ph;
    }
    // a changed screen version: live content must be re-mounted, the picture swapped
    if (n.liveHash && n.liveHash !== meta?.hash) {
      if (n.host) {
        unmount(n.host);
        n.host.remove();
        delete n.host;
      }
      delete n.liveHash;
      if (n.tier === 'live') n.tier = 'picture';
    }
    if (n.img) n.imgSize = 0;
    this.applyGlow(n, id);
  }

  private applyGlow(n: ScreenNode, id: Id) {
    const t = this.model.agentTouched.get(id);
    const on = !!t && Date.now() - t < 6000;
    n.el.classList.toggle('glow', on);
    if (on) setTimeout(() => this.schedule(), 6100 - (Date.now() - t!));
  }

  private dropScreen(n: ScreenNode) {
    if (n.host) unmount(n.host);
    n.el.remove();
    this.screens.delete(n.id);
    this.liveLru = this.liveLru.filter((x) => x !== n.id);
  }

  // ---------- frame ----------

  private frame() {
    this.raf = 0;
    const t0 = performance.now();
    this.measure(t0);
    this.rebuild();
    const page = this.page;
    if (!page) return;
    const v = this.vp.v;
    const W = this.root.clientWidth;
    const H = this.root.clientHeight;
    const margin = Math.max(W, H) * 0.5;
    const vis = this.vp.visibleRect(margin);
    const strict = this.vp.visibleRect(0);
    const ids = this.index.query(vis);
    const dpr = devicePixelRatio || 1;
    const settled = this.vp.phase !== 'active';
    const mosaicList: Id[] = [];
    const want = new Map<Id, Tier>();
    const liveCandidates: { id: Id; prio: number; cost: number }[] = [];
    const visibleScreens: Id[] = [];
    for (const id of ids) {
      const it = page.items[id];
      if (!it || it.kind !== 'screen') continue;
      const r = this.rects.get(id)!;
      const w = r.w * v.k;
      const inStrict =
        r.x < strict.x + strict.w && strict.x < r.x + r.w && r.y < strict.y + strict.h && strict.y < r.y + r.h;
      if (inStrict) visibleScreens.push(id);
      const cur = this.screens.get(id)?.tier;
      if (w < TIER_MOSAIC && !(cur && cur !== 'mosaic' && w >= TIER_MOSAIC * 0.85)) {
        mosaicList.push(id);
        want.set(id, 'mosaic');
        continue;
      }
      const liveOk =
        (w >= (cur === 'live' ? TIER_LIVE_OUT : TIER_LIVE_IN) || id === this.audible) &&
        inStrict &&
        this.animationsSetting !== 'never' &&
        this.appView === 'design' &&
        !!this.model.screenOf(id, it);
      if (liveOk) {
        const visibleFrac = overlapFrac(r, strict);
        if (visibleFrac >= 0.25 || cur === 'live') {
          const [cx, cy] = [r.x + r.w / 2, r.y + r.h / 2];
          const [sx, sy] = [strict.x + strict.w / 2, strict.y + strict.h / 2];
          const dist = Math.hypot(cx - sx, cy - sy) / Math.hypot(strict.w, strict.h);
          const meta = this.model.screenOf(id, it)!;
          const cost = 1 + (meta.cost.infinite > 20 ? 1 : 0) + (meta.cost.backdrop > 0 ? 1 : 0);
          liveCandidates.push({
            id,
            prio:
              visibleFrac * (1 - dist) +
              (this.boost.has(id) ? 0.5 : 0) +
              (id === this.audible ? 1 : 0) +
              (cur === 'live' ? 0.05 : 0),
            cost,
          });
        }
      }
      want.set(id, 'picture');
    }
    // live budget: best priority first
    liveCandidates.sort((a, b) => b.prio - a.prio || (a.id < b.id ? -1 : 1));
    let budget = this.liveBudget;
    for (const c of liveCandidates) {
      if (budget - c.cost < 0) continue;
      budget -= c.cost;
      want.set(c.id, 'live');
    }
    // apply: create/update nodes (bounded work while the view moves)
    let created = 0;
    let mounts = 0;
    let videos = 0;
    const maxCreate = settled ? 400 : 24;
    for (const [id, tier] of want) {
      if (tier === 'mosaic') {
        const n = this.screens.get(id);
        if (n) this.toMosaic(n);
        continue;
      }
      const it = page.items[id] as Item & { kind: 'screen' };
      let n = this.screens.get(id);
      if (!n) {
        if (created >= maxCreate) {
          mosaicList.push(id);
          continue;
        }
        created++;
        n = this.makeScreenNode(id, it);
        this.screens.set(id, n);
        place(n.el, this.rects.get(id)!);
      }
      n.el.style.display = '';
      n.el.style.contentVisibility = '';
      n.el.classList.toggle('dim', this.dim.has(id));
      n.el.classList.toggle('hit', this.hit === id);
      if (n.el.classList.contains('glow')) this.applyGlow(n, id);
      const r = this.rects.get(id)!;
      this.ensurePicture(n, id, it, r.w * v.k * dpr);
      if (this.appView !== 'design' || n.cap) {
        const big = r.w * v.k >= TIER_LIVE_IN && overlapFrac(r, strict) >= 0.25;
        const play = big && videos < VIDEO_BUDGET && this.animationsSetting !== 'never';
        if (this.syncCapture(n, it, r.w * v.k * dpr, play)) videos++;
      }
      if (tier === 'live') {
        if (n.tier !== 'live' && settled && mounts < 2 && !n.mounting) {
          mounts++;
          void this.mountLive(n, id, it);
        }
      } else if (n.tier === 'live') this.demote(n);
    }
    // nodes that left the neighbourhood
    for (const [id, n] of this.screens) {
      if (want.has(id) && want.get(id) !== 'mosaic') continue;
      if (want.get(id) === 'mosaic') continue;
      if (n.tier === 'live') this.demote(n);
      if (n.liveHash) {
        // keep recently live screens warm, hidden, so coming back is instant
        n.el.style.contentVisibility = 'hidden';
        if (!this.liveLru.includes(id)) this.liveLru.push(id);
      } else this.dropScreen(n);
    }
    while (this.liveLru.length > 48) {
      const old = this.liveLru.shift()!;
      const n = this.screens.get(old);
      if (n && !want.has(old)) this.dropScreen(n);
    }
    this.drawMosaic(mosaicList, v);
    this.positionTitles(v, page);
    let live = 0;
    let pics = 0;
    for (const n of this.screens.values()) {
      if (n.tier === 'live') live++;
      else if (n.tier === 'picture' && n.el.style.display !== 'none') pics++;
    }
    this.stats.live = live;
    this.stats.pictures = pics;
    this.stats.nodes = this.screens.size;
    this.stats.frames++;
    if (!this.firstContent && this.rects.size) {
      this.firstContent = true;
      performance.mark('adl:first-content');
    }
    this.visibleIds = visibleScreens;
    this.opts.onView?.(v, visibleScreens, this.vp.phase);
    for (const h of this.hooks) h(v);
    if (settled) {
      for (const [id, t] of want) {
        const n = this.screens.get(id);
        if (t === 'live' && n && n.tier !== 'live') {
          this.schedule();
          break;
        }
      }
    }
  }

  private toMosaic(n: ScreenNode) {
    if (n.tier === 'live') this.demote(n);
    n.el.style.display = 'none';
    n.tier = 'mosaic';
  }

  /** Show (or drop) the real product's capture in a device view. Returns true when a video plays. */
  private syncCapture(n: ScreenNode, it: ScreenItem, devW: number, play: boolean): boolean {
    const c: Capture | undefined = this.appView === 'design' ? undefined : shownCapture(it.build, this.appView);
    if (!c) {
      if (n.cap) {
        n.cap.remove();
        delete n.cap;
        delete n.capKey;
      }
      return false;
    }
    const video = c.kind === 'video' && play;
    // far away a small picture is enough; close up the full one (the video's still until it plays)
    const still = c.kind === 'video' ? (c.poster ?? c.thumb) : devW <= 260 && c.thumb ? c.thumb : c.src;
    const key = `${video ? 'v' : 'i'}|${video ? c.src : (still ?? '')}|${c.at ?? ''}`;
    if (n.capKey === key) return video;
    n.cap?.remove();
    delete n.cap;
    const pid = this.model.id;
    if (video) {
      const el = document.createElement('video');
      el.muted = true;
      el.loop = true;
      el.playsInline = true;
      el.autoplay = true;
      el.preload = 'auto';
      if (c.poster) el.poster = fileUrl(pid, c.poster, c.at);
      el.src = fileUrl(pid, c.src, c.at);
      n.cap = el;
    } else if (still) {
      const el = document.createElement('img');
      el.decoding = 'async';
      el.draggable = false;
      el.alt = '';
      el.src = fileUrl(pid, still, c.at);
      n.cap = el;
    } else {
      delete n.capKey;
      return false;
    }
    n.cap.className = `capt${c.kind === 'video' ? ' is-video' : ''}`;
    n.frame.appendChild(n.cap);
    n.capKey = key;
    return video;
  }

  private ensurePicture(n: ScreenNode, id: Id, it: Item, devW: number) {
    const snap = this.model.snapOf(id, it);
    if (n.tier === 'mosaic') n.tier = 'picture';
    if (!snap) return;
    const size = devW <= 64 ? 64 : devW <= 128 ? 128 : devW <= 256 ? 256 : 512;
    if (n.img && n.imgSize && n.imgSize >= size && n.img.dataset.base === snap.url) return;
    if (!n.img) {
      n.img = document.createElement('img');
      n.img.className = 'pic';
      n.img.decoding = 'async';
      n.img.draggable = false;
      n.img.alt = '';
      n.frame.insertBefore(n.img, n.frame.firstChild);
    }
    n.img.dataset.base = snap.url;
    n.img.src = `${snap.url}-${size}.webp`;
    n.imgSize = size;
  }

  private async mountLive(n: ScreenNode, id: Id, it: Item) {
    const meta = this.model.screenOf(id, it);
    if (!meta) return;
    n.mounting = true;
    try {
      const hash = meta.hash;
      const p = await prepare(this.src, hash);
      if (!this.screens.has(id) || this.model.screenOf(id, it)?.hash !== hash) return;
      if (!n.host) {
        n.host = document.createElement('div');
        n.host.className = 'host';
        n.frame.appendChild(n.host);
      }
      const r = this.rects.get(id);
      if (r) {
        n.host.style.width = `${r.w}px`;
        n.host.style.height = `${r.h}px`;
      }
      if (n.liveHash !== hash) mountPrepared(n.host, p);
      n.host.classList.add('adl-inert');
      setPaused(n.host, this.paused || this.animationsSetting === 'never');
      n.liveHash = hash;
      n.tier = 'live';
      n.el.classList.add('live');
      this.liveLru = this.liveLru.filter((x) => x !== id);
      this.schedule();
    } catch {
      // the picture stays; try again on the next settle
    } finally {
      n.mounting = false;
    }
  }

  private demote(n: ScreenNode) {
    n.tier = 'picture';
    n.el.classList.remove('live');
    if (n.host) setPaused(n.host, true);
  }

  /** The screen that plays its sounds (or none): its speaker lights up and it gets a live slot first. */
  setAudible(id: Id | undefined) {
    if (this.audible === id) return;
    this.audible = id;
    for (const n of this.screens.values()) n.el.classList.toggle('snd-on', n.id === id);
    this.schedule();
  }

  /** The shadow root of a screen while it runs live (not a picture, not kept warm in the background). */
  liveRoot(id: Id): ShadowRoot | undefined {
    const n = this.screens.get(id);
    return n?.tier === 'live' ? (n.host?.shadowRoot ?? undefined) : undefined;
  }

  /** Pause or resume every live screen (Settings → Animations, gestures under load). */
  setPausedAll(p: boolean) {
    this.paused = p;
    for (const n of this.screens.values()) if (n.host) setPaused(n.host, p || n.tier !== 'live');
  }

  // ---------- mosaic ----------

  stats = { live: 0, pictures: 0, mosaic: 0, mosaicMissing: 0, nodes: 0, frames: 0 };
  private firstContent = false;

  private drawMosaic(list: Id[], v: View) {
    const W = this.root.clientWidth;
    const H = this.root.clientHeight;
    const dpr = devicePixelRatio || 1;
    const c = this.mosaic;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      c.style.width = `${W}px`;
      c.style.height = `${H}px`;
    }
    // the canvas sits in the world, counter-transformed so it always covers the viewport
    c.style.transform = `translate(${-v.x / v.k}px, ${-v.y / v.k}px) scale(${1 / v.k})`;
    const g = this.mctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    this.stats.mosaic = list.length;
    this.stats.mosaicMissing = 0;
    if (!list.length) return;
    beginFrame(this.vp.phase === 'active' ? 24 : 80);
    g.setTransform(dpr * v.k, 0, 0, dpr * v.k, dpr * v.x, dpr * v.y);
    const page = this.page!;
    const project = this.model.docs.project;
    for (const id of list) {
      const r = this.rects.get(id);
      const it = page.items[id];
      if (!r || !it || it.kind !== 'screen') continue;
      const snap = this.model.snapOf(id, it);
      const devW = r.w * v.k * dpr;
      const shot = this.appView === 'design' ? undefined : shownCapture(it.build, this.appView);
      const shotImg = shot?.thumb ? image(fileUrl(this.model.id, shot.thumb, shot.at)) : undefined;
      if (shot && devW >= 16) {
        g.fillStyle = '#0b0b0b';
        g.fillRect(r.x, r.y, r.w, r.h);
        if (shotImg) {
          const s = Math.min(r.w / shotImg.naturalWidth, r.h / shotImg.naturalHeight);
          const w = shotImg.naturalWidth * s;
          const h = shotImg.naturalHeight * s;
          g.drawImage(shotImg, r.x + (r.w - w) / 2, r.y + (r.h - h) / 2, w, h);
        }
      } else if (devW < 16) {
        // a few pixels wide: its average colour says as much as a picture would, at no cost
        g.fillStyle = snap?.avg ?? '#262624';
        g.fillRect(r.x, r.y, r.w, r.h);
      } else {
        const img = snap ? image(`${snap.url}-${devW <= 64 ? 64 : 128}.webp`) : undefined;
        const rad = Math.min(r.w, r.h) * 0.06;
        g.save();
        g.beginPath();
        g.roundRect(r.x, r.y, r.w, r.h, rad);
        g.clip();
        if (img) g.drawImage(img, r.x, r.y, r.w, r.h);
        else {
          if (snap) this.stats.mosaicMissing++;
          g.fillStyle = snap?.avg ?? '#262624';
          g.fillRect(r.x, r.y, r.w, r.h);
        }
        g.restore();
      }
      if (this.dim.has(id) || (this.appView !== 'design' && !shot)) {
        g.fillStyle = 'rgba(20,20,19,0.7)';
        g.fillRect(r.x, r.y, r.w, r.h);
      }
      if (it.build) {
        // the build state as a strip under the screen, readable at any zoom
        g.fillStyle = buildDef(it.build.state)?.color ?? '#7A7A73';
        const bh = Math.max(12, 6 / v.k);
        g.fillRect(r.x, r.y + r.h + 3 / v.k, r.w, bh);
      }
      if (showsBanner(project, it.status)) {
        const st = findStatus(project, it.status);
        g.fillStyle = st?.color ?? '#FFD43B';
        const bh = Math.max(14, 6 / v.k);
        g.fillRect(r.x, r.y - bh - 2 / v.k, r.w, bh);
      }
    }
    if (wasDeferred()) this.schedule();
  }

  // ---------- section titles (screen space, constant size) ----------

  private positionTitles(v: View, page: PageDoc) {
    const W = this.root.clientWidth;
    const H = this.root.clientHeight;
    for (const [id, t] of this.sectionTitles) {
      const r = this.rects.get(id);
      if (!r || !page.items[id]) continue;
      const x = r.x * v.k + v.x;
      const y = r.y * v.k + v.y;
      const w = r.w * v.k;
      const on = x < W && x + w > 0 && y > -40 && y < H + 40 && w > 60;
      t.style.display = on ? '' : 'none';
      if (!on) continue;
      const { left, room } = this.stickyTitles ? stickyTitle(x, w) : { left: x, room: w };
      t.style.transform = `translate(${left}px, ${Math.round(y - 30)}px)`;
      t.style.maxWidth = `${Math.max(60, room)}px`;
      t.classList.toggle('narrow', room < 300);
      t.classList.toggle('tiny', room < 170);
    }
  }

  // ---------- drag preview ----------

  /** Items that move along with `ids`: children of moved sections and notes anchored to moved items. */
  dependents(ids: Iterable<Id>): Set<Id> {
    const page = this.page;
    const out = new Set<Id>(ids);
    if (!page) return out;
    let grew = true;
    while (grew) {
      grew = false;
      for (const [id, it] of Object.entries(page.items)) {
        if (out.has(id)) continue;
        if ((it.parent && out.has(it.parent)) || (it.kind === 'note' && it.anchor && out.has(it.anchor))) {
          out.add(id);
          grew = true;
        }
      }
    }
    return out;
  }

  /** Offset items (and everything that moves with them) without touching the documents. */
  previewMove(ids: Iterable<Id>, dx: number, dy: number) {
    const page = this.page;
    if (!page) return;
    if (!this.preview) {
      const set = this.dependents(ids);
      const base = new Map<Id, Rect>();
      for (const id of set) {
        const r = this.rects.get(id);
        if (r) base.set(id, { ...r });
      }
      this.preview = { ids: set, base };
      this.rects = new Map(this.rects);
    }
    for (const [id, r] of this.preview.base) {
      const nr = { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
      this.rects.set(id, nr);
      const it = page.items[id];
      this.index.set(id, it?.kind === 'screen' ? { x: nr.x, y: nr.y - HEAD_H, w: nr.w, h: nr.h + HEAD_H } : nr);
      const el = this.screens.get(id)?.el ?? this.others.get(id);
      if (el) {
        el.style.left = `${nr.x}px`;
        el.style.top = `${nr.y}px`;
      }
    }
    this.rerouteTouching(this.preview.ids);
    this.schedule();
  }

  /** Re-route only the arrows that touch the given items (cheap enough for every pointer move). */
  rerouteTouching(ids: Set<Id>) {
    const page = this.page;
    if (!page) return;
    const project = this.model.docs.project;
    const obstacles = new Map<Id, Rect>();
    const labelAvoid: Rect[] = [];
    for (const [id, r] of this.rects) {
      const k = page.items[id]?.kind;
      if (k === 'screen' || k === 'portal' || k === 'image') obstacles.set(id, r);
      else if (k === 'note' || k === 'text') labelAvoid.push(r);
    }
    const inputs = Object.entries(page.arrows)
      .filter(([, a]) => (ids.has(a.from) || ids.has(a.to)) && this.rects.has(a.from) && this.rects.has(a.to))
      .map(([id, arrow]) => ({
        id,
        arrow,
        from: this.rects.get(arrow.from)!,
        to: this.rects.get(arrow.to)!,
        fromHead: this.headOf(page, arrow.from),
        toHead: this.headOf(page, arrow.to),
      }));
    const routes = routeAll(inputs, { obstacles, headroom: HEAD_H + 8, labelAvoid });
    const svg = this.layers.arrows as unknown as SVGSVGElement;
    for (const { id, arrow } of inputs) {
      const r = routes.get(id)!;
      this.routes.set(id, r);
      this.drawArrow(svg, id, arrow, r, arrowStyle(project, arrow.style));
    }
  }

  /** End a drag preview: the next frame rebuilds everything from the documents. */
  endPreview() {
    this.preview = undefined;
    this.dirtyStructure = true;
    this.placementKey = undefined;
    this.schedule();
  }

  get previewing() {
    return !!this.preview;
  }

  /** Mark selected arrows and items (classes only; boxes are drawn by the overlay). */
  applySelection(items: Id[], arrows: Id[]) {
    for (const [id, a] of this.arrowEls) {
      const on = arrows.includes(id);
      a.g.classList.toggle('sel', on);
      a.label?.classList.toggle('sel', on);
    }
    for (const [id, t] of this.sectionTitles) t.classList.toggle('sel', items.includes(id));
  }

  arrowIds(): Id[] {
    return [...this.arrowEls.keys()];
  }

  // ---------- frame-time governor ----------

  private measure(now: number) {
    if (this.lastFrame) {
      const dt = now - this.lastFrame;
      if (dt < 1000) this.frameTimes.push(dt);
    }
    this.lastFrame = now;
    if (this.frameTimes.length >= 60) {
      const slow = this.frameTimes.filter((d) => d > 34).length / this.frameTimes.length;
      this.frameTimes = [];
      if (slow > 0.08 && this.vp.phase !== 'idle') {
        this.slowWindows++;
        if (this.slowWindows >= 2 && this.liveBudget > 8) {
          this.liveBudget = Math.max(8, Math.floor(this.liveBudget * 0.75));
          this.slowWindows = 0;
          this.goodSince = now;
        }
      } else {
        this.slowWindows = 0;
        if (now - this.goodSince > 5000 && this.liveBudget < (this.opts.liveBudget ?? 24)) {
          this.liveBudget = Math.min(this.opts.liveBudget ?? 24, this.liveBudget + 2);
          this.goodSince = now;
        }
      }
    }
  }

  // ---------- queries for the interaction layer and chrome ----------

  visible(): Id[] {
    return this.visibleIds;
  }

  itemAt(clientX: number, clientY: number): Id | undefined {
    const [x, y] = this.vp.toWorld(clientX, clientY);
    const page = this.page;
    if (!page) return undefined;
    const hits = this.index.at(x, y).filter((id) => {
      const r = this.rects.get(id);
      return (
        r && x >= r.x && x <= r.x + r.w && y >= r.y - (page.items[id]?.kind === 'screen' ? HEAD_H : 0) && y <= r.y + r.h
      );
    });
    const order = (id: Id) => {
      const k = page.items[id]?.kind;
      return k === 'note' || k === 'text' ? 3 : k === 'screen' || k === 'portal' || k === 'image' ? 2 : 1;
    };
    hits.sort((a, b) => order(b) - order(a));
    if (hits[0]) return hits[0];
    // sections: hit on their area
    for (const [id, it] of Object.entries(page.items)) {
      if (it.kind !== 'section') continue;
      const r = this.rects.get(id);
      if (r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return id;
    }
    return undefined;
  }

  contentBounds(): Rect | undefined {
    let x1 = Number.POSITIVE_INFINITY;
    let y1 = Number.POSITIVE_INFINITY;
    let x2 = Number.NEGATIVE_INFINITY;
    let y2 = Number.NEGATIVE_INFINITY;
    for (const [id, r] of this.rects) {
      const head = this.page?.items[id]?.kind === 'screen' ? HEAD_H : 0;
      x1 = Math.min(x1, r.x);
      y1 = Math.min(y1, r.y - head);
      x2 = Math.max(x2, r.x + r.w);
      y2 = Math.max(y2, r.y + r.h);
    }
    return Number.isFinite(x1) ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : undefined;
  }

  private lostT = 0;
  /** A view that shows none of the page (saved before the layout moved, or all it showed was deleted) goes to the
   *  whole page once the layout has been still for a moment. Before, such a view was restored on every visit and the
   *  canvas opened empty. */
  checkLost() {
    clearTimeout(this.lostT);
    this.lostT = window.setTimeout(() => {
      if (this.vp.phase !== 'idle') return this.checkLost();
      const v = this.vp.v;
      const W = this.root.clientWidth;
      const H = this.root.clientHeight;
      if (this.rects.size && keepInView(v, this.rects.values(), W, H, this.vp.insetTop, 1) !== v) this.fitAll(false);
    }, 800);
  }

  fitAll(animate = true) {
    const b = this.contentBounds();
    if (b) this.vp.fitRect(b, { pad: 40, maxK: 1, animate });
  }

  fit(ids: Id[], animate = true) {
    let r: Rect | undefined;
    for (const id of ids) {
      const x = this.rects.get(id);
      if (!x) continue;
      const head = this.page?.items[id]?.kind === 'screen' ? HEAD_H : 0;
      const b = { x: x.x, y: x.y - head, w: x.w, h: x.h + head };
      r = r
        ? {
            x: Math.min(r.x, b.x),
            y: Math.min(r.y, b.y),
            w: Math.max(r.x + r.w, b.x + b.w) - Math.min(r.x, b.x),
            h: Math.max(r.y + r.h, b.y + b.h) - Math.min(r.y, b.y),
          }
        : b;
    }
    if (r) this.vp.fitRect(r, { pad: 60, maxK: 1, animate });
  }

  /** Visible screens still waiting for their picture or live mount (0 = what you see is final; used by renders). */
  pending(): number {
    if (this.raf) return 1;
    const page = this.page;
    if (!page) return 0;
    let n = this.stats.mosaicMissing;
    for (const id of this.visibleIds) {
      const node = this.screens.get(id);
      const it = page.items[id];
      const r = this.rects.get(id);
      if (!it || !r || r.w * this.vp.v.k < TIER_MOSAIC) continue; // drawn in the mosaic canvas
      if (!node) {
        n++;
        continue;
      }
      if (node.tier === 'mosaic' || !this.model.snapOf(id, it)) continue;
      if (node.mounting) n++;
      else if (node.tier !== 'live' && !(node.img?.complete && node.img.naturalWidth > 0)) n++;
    }
    return n;
  }

  /** Search highlight: dim everything on the page except `matches`, ring `current` (keeps it live). */
  setSearch(matches: Id[] | undefined, current?: Id) {
    this.dim.clear();
    if (this.hit) this.boost.delete(this.hit);
    this.hit = current;
    if (current) this.boost.add(current);
    if (matches && this.page) {
      const keep = new Set(matches);
      for (const [id, it] of Object.entries(this.page.items))
        if (it.kind === 'screen' && !keep.has(id)) this.dim.add(id);
    }
    this.invalidate(false);
  }

  liveCount(): number {
    let n = 0;
    for (const s of this.screens.values()) if (s.tier === 'live') n++;
    return n;
  }

  isPrepared(id: Id): boolean {
    const it = this.page?.items[id];
    const meta = it ? this.model.screenOf(id, it) : undefined;
    return !!meta && isPrepared(meta.hash);
  }

  nodeOf(id: Id): HTMLElement | undefined {
    return this.screens.get(id)?.el ?? this.others.get(id);
  }

  labelOf(arrowId: Id): HTMLElement | undefined {
    return this.arrowEls.get(arrowId)?.label;
  }

  arrowEl(arrowId: Id): SVGGElement | undefined {
    return this.arrowEls.get(arrowId)?.g;
  }

  hostOf(id: Id): HTMLElement | undefined {
    return this.screens.get(id)?.host;
  }
}

function place(el: HTMLElement, r: Rect, autoHeight = false) {
  el.style.left = `${r.x}px`;
  el.style.top = `${r.y}px`;
  el.style.width = `${r.w}px`;
  if (!autoHeight) el.style.height = `${r.h}px`;
}

function overlapFrac(r: Rect, v: Rect): number {
  const w = Math.max(0, Math.min(r.x + r.w, v.x + v.w) - Math.max(r.x, v.x));
  const h = Math.max(0, Math.min(r.y + r.h, v.y + v.h) - Math.max(r.y, v.y));
  return (w * h) / Math.max(1, r.w * r.h);
}
