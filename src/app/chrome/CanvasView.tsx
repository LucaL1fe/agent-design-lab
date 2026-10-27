import {
  ArrowUpRight,
  ChevronDown,
  Copy,
  Hand,
  Hash,
  ListChecks,
  MousePointer2,
  PanelRight,
  Play,
  StickyNote,
  Type,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { HISTORY_PAGE } from '../../core/actions.ts';
import { captureDevices, usesBuild } from '../../core/build.ts';
import { boot, connection } from '../boot/connection.ts';
import { Engine } from '../engine/engine.ts';
import { Interaction } from '../engine/interact.ts';
import { isTyping } from '../engine/viewport.ts';
import { app, navigate, setAppView, type Tool } from '../state/app.ts';
import { useStore } from '../state/store.ts';
import { CompareView } from './Compare.tsx';
import { copy } from './Home.tsx';
import { Inspector } from './Inspector.tsx';
import { PageMenu } from './PageMenu.tsx';
import { PresentMode } from './Present.tsx';
import { SearchPalette } from './Search.tsx';

export const engineRef: { current?: Engine | undefined; ix?: Interaction | undefined } = {};

const TOOLS: { id: Tool; icon: ReactNode; label: string; key: string }[] = [
  { id: 'select', icon: <MousePointer2 size={18} strokeWidth={1.8} />, label: 'Select', key: 'V' },
  { id: 'hand', icon: <Hand size={18} strokeWidth={1.8} />, label: 'Hand', key: 'H' },
  { id: 'text', icon: <Type size={18} strokeWidth={1.8} />, label: 'Text', key: 'T' },
  { id: 'section', icon: <Hash size={18} strokeWidth={1.8} />, label: 'Section', key: 'S' },
  { id: 'note', icon: <StickyNote size={18} strokeWidth={1.8} />, label: 'Note', key: 'N' },
  { id: 'arrow', icon: <ArrowUpRight size={18} strokeWidth={1.8} />, label: 'Arrow', key: 'A' },
];

function viewKey(pid: string, page: string) {
  return `adl:view:${pid}:${page}`;
}

export function CanvasView() {
  const project = useStore(app, (s) => s.project)!;
  const route = useStore(app, (s) => s.route);
  const tool = useStore(app, (s) => s.tool);
  const menu = useStore(app, (s) => s.menu);
  const panel = useStore(app, (s) => s.panel);
  const animations = useStore(app, (s) => s.animations);
  useStore(app, (s) => s.docsVersion);
  const host = useRef<HTMLDivElement>(null);
  const zoomLabel = useRef<HTMLSpanElement>(null);
  const [engine, setEngine] = useState<Engine>();
  const docs = project.docs;
  const pages = docs.project.pages;
  const pageId =
    route.page && docs.pages[route.page]
      ? route.page
      : docs.project.sourceOfTruth && docs.pages[docs.project.sourceOfTruth]
        ? docs.project.sourceOfTruth
        : (pages.find((p) => docs.pages[p]) ?? '');
  const page = docs.pages[pageId];

  // create the engine once per project
  useEffect(() => {
    if (!host.current) return;
    let saveT = 0;
    let lastSent = '';
    const e = new Engine(host.current, project, pageId, {
      onView: (v, visible, phase) => {
        if (zoomLabel.current) zoomLabel.current.textContent = `${Math.round(v.k * 100)}%`;
        if (phase === 'active') return;
        clearTimeout(saveT);
        saveT = window.setTimeout(() => {
          try {
            localStorage.setItem(viewKey(project.id, e.pageId), JSON.stringify(v));
          } catch {
            // private mode
          }
          const key = `${e.pageId}|${visible.join(',')}`;
          if (key !== lastSent) {
            lastSent = key;
            const r = e.vp.visibleRect(0);
            connection.send({
              t: 'view',
              pid: project.id,
              page: e.pageId,
              rect: r,
              zoom: v.k,
              selection: app.get().selection,
              visible,
            });
          }
          app.set({ zoom: v.k });
        }, 250);
      },
    });
    engineRef.current = e;
    const ix = new Interaction(e);
    engineRef.ix = ix;
    (window as unknown as { __adl: unknown }).__adl = { engine: e, ix, app, project, boot };
    setEngine(e);
    return () => {
      ix.destroy();
      e.destroy();
      if (engineRef.current === e) engineRef.current = undefined;
    };
  }, [project]);

  // page switches and the first view of a page
  const shownPage = useRef<string>('');
  useEffect(() => {
    if (!engine || !pageId) return;
    if (shownPage.current === pageId) return;
    if (engine.pageId !== pageId) engine.setPage(pageId);
    shownPage.current = pageId;
    // wait one frame so rectangles exist
    requestAnimationFrame(() => {
      engine.invalidate(true);
      requestAnimationFrame(() => {
        const focus = app.get().route.focus;
        let saved: { x: number; y: number; k: number } | undefined;
        try {
          saved = JSON.parse(localStorage.getItem(viewKey(project.id, pageId)) ?? 'null') ?? undefined;
        } catch {
          saved = undefined;
        }
        if (focus && engine.rects.has(focus)) {
          engine.fit([focus], false);
          app.set({ selection: [focus] });
        } else if (saved && Number.isFinite(saved.k)) {
          engine.vp.set(saved);
          engine.checkLost();
        } else engine.fitAll(false);
        // renders (adl render --canvas) wait for this before setting their own view
        engine.root.dataset.viewReady = pageId;
      });
    });
    if (route.page !== pageId) navigate({ pid: project.id, page: pageId }, true);
  }, [engine, pageId, project.id, route.page]);

  // the real product: a device view and a highlighted flow
  const appView = useStore(app, (s) => s.appView);
  const flowFocus = useStore(app, (s) => s.flowFocus);
  const devices = page ? captureDevices(page) : [];
  const tracked = page ? usesBuild(page) : false;
  const view = devices.includes(appView) ? appView : 'design';
  useEffect(() => {
    engine?.setAppView(view);
  }, [engine, view]);
  useEffect(() => {
    if (!engine) return;
    const steps = flowFocus ? page?.flows?.[flowFocus]?.steps : undefined;
    if (!steps) return;
    engine.setSearch(steps, steps[0]);
    engine.fit(steps.filter((id) => engine.rects.has(id)));
    return () => engine.setSearch(undefined);
  }, [engine, flowFocus, page]);

  useEffect(() => {
    if (!engine) return;
    engine.animationsSetting = animations;
    engine.setPausedAll(animations === 'never');
    engine.vp.handTool = tool === 'hand';
    engine.vp.insetRight = panel ? 300 : 0;
    engine.root.classList.toggle('hand', tool === 'hand');
    engine.invalidate(false);
  }, [engine, animations, tool, panel]);

  // the side panel opens only when the person opens it (button or ⌥I), and stays as they left it
  useEffect(() => {
    try {
      localStorage.setItem('adl:panel', panel ? '1' : '0');
    } catch {
      // private mode
    }
  }, [panel]);

  // view keys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping() || !engine) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.shiftKey && e.code === 'Digit1') {
        e.preventDefault();
        engine.fitAll();
      } else if (e.shiftKey && e.code === 'Digit2') {
        e.preventDefault();
        const sel = app.get().selection;
        if (sel.length) engine.fit(sel);
      } else if (e.shiftKey && e.code === 'Digit0') {
        e.preventDefault();
        engine.vp.zoomAt(engine.root.clientWidth / 2, engine.root.clientHeight / 2, 1, false);
      } else if ((e.key === '=' || e.key === '+') && !e.altKey) {
        e.preventDefault();
        engine.vp.zoomBy(1.25);
      } else if (e.key === '-' && !e.altKey) {
        e.preventDefault();
        engine.vp.zoomBy(0.8);
      } else if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        app.set({ searchOpen: true });
      } else if (e.altKey && !mod && e.code === 'KeyI') {
        // ⌥I: the side panel (e.code, because ⌥I types "ˆ" on a Mac keyboard)
        e.preventDefault();
        app.set((s) => ({ panel: !s.panel }));
      } else if (!mod && !e.altKey && e.key.toLowerCase() === 'c' && usesBuild(engine.page ?? { items: {} })) {
        e.preventDefault();
        app.set((s) => ({ compare: s.compare ? undefined : 'screens' }));
      } else if (!mod && !e.altKey && e.key.toLowerCase() === 'd') {
        const all = ['design', ...captureDevices(engine.page ?? { items: {} })];
        if (all.length > 1) {
          e.preventDefault();
          const cur = all.indexOf(app.get().appView);
          setAppView(all[(cur + 1) % all.length]!);
        }
      } else if (e.key === 'Escape' && app.get().flowFocus) {
        app.set({ flowFocus: undefined });
      } else if (!mod && !e.altKey) {
        const t = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
        if (t) app.set({ tool: t.id });
        else if (e.key === 'Escape') app.set({ menu: undefined });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine]);

  const problems = project.problems.filter((p) => p.level === 'error');
  const snap = useStore(app, (s) => s.snap);
  const isHistory = page?.kind === 'history' || pageId === HISTORY_PAGE;
  const askClaude =
    project.docs.project.pages.filter((p) => p !== HISTORY_PAGE).length > 1
      ? `Put the next flow for ${project.docs.project.name} on the page “${page?.name ?? ''}”`
      : `Design the first screens for ${project.docs.project.name}`;

  return (
    <div className="stage" onPointerDown={() => menu && menu !== 'context' && app.set({ menu: undefined })}>
      <div ref={host} style={{ position: 'absolute', inset: 0 }} data-testid="canvas" />
      <div className="tb" role="toolbar" aria-label="Tools" onPointerDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          className={`pg${menu === 'page' ? ' open' : ''}`}
          onClick={() => app.set({ menu: menu === 'page' ? undefined : 'page' })}
          aria-haspopup="menu"
          data-testid="page-button"
        >
          <span>{page?.name ?? 'No page'}</span>
          <ChevronDown />
        </button>
        <span className="sep" />
        {TOOLS.map((t) => (
          <button
            type="button"
            key={t.id}
            className={`tool${tool === t.id ? ' on' : ''}`}
            aria-label={`${t.label} (${t.key})`}
            aria-pressed={tool === t.id}
            onClick={() => app.set({ tool: t.id })}
            data-tool={t.id}
          >
            {t.icon}
            <span className="tip">
              {t.label}
              <span className="kbd">{t.key}</span>
            </span>
          </button>
        ))}
      </div>
      {menu === 'page' ? <PageMenu pageId={pageId} /> : null}
      {engine ? <SearchPalette engine={engine} pageId={pageId} /> : null}
      {engine ? <PresentMode engine={engine} pageId={pageId} /> : null}
      {engine ? <CompareView engine={engine} pageId={pageId} /> : null}
      <div className="rc" onPointerDown={(e) => e.stopPropagation()}>
        {devices.length ? (
          <fieldset className="viewsw" aria-label="Show the design or the real product" data-testid="view-switch">
            {['design', ...devices].map((d) => (
              <button
                type="button"
                key={d}
                className={view === d ? 'on' : ''}
                aria-pressed={view === d}
                onClick={() => setAppView(d)}
                title={d === 'design' ? 'The design (D cycles)' : `The real product on the ${d} (D cycles)`}
              >
                {d}
              </button>
            ))}
          </fieldset>
        ) : null}
        {tracked ? (
          <button
            type="button"
            className="tool"
            aria-label="Compare (C)"
            onClick={() => app.set((s) => ({ compare: s.compare ? undefined : 'screens' }))}
            data-testid="compare-button"
          >
            <ListChecks size={18} strokeWidth={1.8} />
            <span className="tip">
              Compare with the real product<span className="kbd">C</span>
            </span>
          </button>
        ) : null}
        <button
          type="button"
          className="tool"
          aria-label="Present (P)"
          onClick={() => window.dispatchEvent(new CustomEvent('adl:present'))}
        >
          <Play size={18} strokeWidth={1.8} />
          <span className="tip">
            Present<span className="kbd">P</span>
          </span>
        </button>
        <button
          type="button"
          className={`tool${panel ? ' on' : ''}`}
          aria-label="Side panel"
          aria-pressed={panel}
          onClick={() => app.set({ panel: !panel })}
        >
          <PanelRight size={18} strokeWidth={1.8} />
          <span className="tip">
            Side panel<span className="kbd">⌥I</span>
          </span>
        </button>
        <button
          type="button"
          className="zm"
          onClick={() => app.set({ menu: menu === 'zoom' ? undefined : 'zoom' })}
          aria-haspopup="menu"
          data-testid="zoom-button"
        >
          <span ref={zoomLabel}>100%</span>
          <ChevronDown />
        </button>
      </div>
      {menu === 'zoom' && engine ? <ZoomMenu engine={engine} /> : null}
      {problems.length ? (
        <div className="errbar" role="alert">
          <span>
            <b>{problems[0]!.file ?? 'Problem'}</b>: {problems[0]!.message}
          </span>
          {problems.length > 1 ? (
            <span className="more">
              +{problems.length - 1} more · run <code>adl validate</code>
            </span>
          ) : null}
        </div>
      ) : null}
      {page && !isHistory && Object.keys(page.items).length === 0 ? (
        <div className="empty canvas-empty" data-testid="empty-page">
          <div className="big">Nothing on this page yet</div>
          <div style={{ color: 'var(--muted)', fontSize: 15 }}>Ask Claude Code, for example:</div>
          <div className="say">
            <span className="q">“{askClaude}”</span>
            <button type="button" className="btn sm" onClick={() => copy(askClaude)}>
              <Copy size={14} /> Copy
            </button>
          </div>
          <div style={{ color: 'var(--muted)' }}>
            Screens appear here while Claude writes them. Press N for a note, S for a section.
          </div>
        </div>
      ) : null}
      {isHistory ? (
        <div className="pill-hint">
          History: everything that was replaced, rejected or removed. Select an item to restore it.
        </div>
      ) : null}
      {panel && page ? <Inspector pageId={pageId} /> : null}
      {snap.running && snap.total > 0 ? (
        <div className="progress" title="Still pictures are drawn in the background so zoomed-out views stay fast">
          <i /> Preparing previews · {Math.min(snap.done, snap.total)} / {snap.total}
        </div>
      ) : null}
    </div>
  );
}

function ZoomMenu({ engine }: { engine: Engine }) {
  const zoomTo = (k: number) => {
    engine.vp.zoomAt(engine.root.clientWidth / 2, engine.root.clientHeight / 2, k, false);
    app.set({ menu: undefined });
  };
  const animations = useStore(app, (s) => s.animations);
  return (
    <div className="menu" style={{ right: 12, top: 58 }} role="menu" onPointerDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="mi"
        onClick={() => {
          engine.vp.zoomBy(1.25);
          app.set({ menu: undefined });
        }}
      >
        Zoom in<span className="r">+</span>
      </button>
      <button
        type="button"
        className="mi"
        onClick={() => {
          engine.vp.zoomBy(0.8);
          app.set({ menu: undefined });
        }}
      >
        Zoom out<span className="r">−</span>
      </button>
      <hr />
      <button
        type="button"
        className="mi"
        onClick={() => {
          engine.fitAll();
          app.set({ menu: undefined });
        }}
      >
        Zoom to fit<span className="r">⇧1</span>
      </button>
      <button
        type="button"
        className="mi"
        onClick={() => {
          const s = app.get().selection;
          if (s.length) engine.fit(s);
          app.set({ menu: undefined });
        }}
      >
        Zoom to selection<span className="r">⇧2</span>
      </button>
      <hr />
      {[0.25, 0.5, 1, 2].map((k) => (
        <button type="button" key={k} className="mi" onClick={() => zoomTo(k)}>
          {k * 100}%{k === 1 ? <span className="r">⇧0</span> : null}
        </button>
      ))}
      <hr />
      <div className="lbl">Animations in screens</div>
      {(['auto', 'always', 'never'] as const).map((v) => (
        <button type="button" key={v} className="mi" onClick={() => app.set({ animations: v, menu: undefined })}>
          <span className="chk">{animations === v ? '✓' : ''}</span>
          {v === 'auto' ? 'Play when zoomed in (smooth)' : v === 'always' ? 'Always play' : 'Never play (stills only)'}
        </button>
      ))}
    </div>
  );
}
