// Present mode: walk the flow like a person using the product. The current screen runs live; its outgoing arrows
// are the buttons (their labels), tappable elements with an arrow's anchor are hotspots, "auto" arrows advance by
// themselves. → next · ← back · ↑↓ choose · Esc ends (and leaves the canvas on the last screen).
import { Play, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { arrowStylesOf } from '../../core/status.ts';
import type { Arrow, Id, PageDoc, ScreenItem } from '../../core/types.ts';
import type { Engine } from '../engine/engine.ts';
import { fetchSource, mountPrepared, prepare, unmount } from '../engine/screenHost.ts';
import { app } from '../state/app.ts';
import type { ProjectModel } from '../state/project.ts';
import { useStore } from '../state/store.ts';

interface Next {
  arrow: Arrow;
  to: Id;
  label: string;
  el?: string | undefined;
  after?: number | undefined;
}

/** Where a screen leads: its navigation arrows (proposal links are not paths), portals followed to their target. */
export function nextsOf(project: Pick<ProjectModel, 'docs'>, page: PageDoc, id: Id): Next[] {
  const styles = arrowStylesOf(project.docs.project);
  const out: Next[] = [];
  for (const a of Object.values(page.arrows)) {
    if (a.from !== id || a.to === id) continue;
    if (styles[a.style ?? 'flow']?.nav === false) continue;
    let to = a.to;
    const target = page.items[to];
    if (target?.kind === 'portal' && target.target && page.items[target.target]) to = target.target;
    if (page.items[to]?.kind !== 'screen') continue;
    const t = a.trigger;
    const label =
      a.label ||
      (t?.on === 'auto' && t.after ? `${Math.round(t.after / 100) / 10} s later` : t?.on === 'back' ? 'back' : 'next');
    out.push({ arrow: a, to, label, el: t?.el ?? a.fromEl, after: t?.on === 'auto' ? (t.after ?? 2000) : undefined });
  }
  return out;
}

/** Where to start: the selected screen, else the page's entry screen, else the first screen nothing leads to. */
export function startOf(page: PageDoc, selection: Id[]): Id | undefined {
  const screens = Object.entries(page.items).filter(([, it]) => it.kind === 'screen' && !it.archived);
  const sel = selection.find((s) => page.items[s]?.kind === 'screen');
  if (sel) return sel;
  const entry = screens.find(([, it]) => (it as ScreenItem).entry);
  if (entry) return entry[0];
  const hasIn = new Set(Object.values(page.arrows).map((a) => a.to));
  return (screens.find(([id]) => !hasIn.has(id)) ?? screens[0])?.[0];
}

export function PresentMode({ engine, pageId }: { engine: Engine; pageId: string }) {
  const project = useStore(app, (s) => s.project)!;
  const presenting = useStore(app, (s) => s.presenting);
  useStore(app, (s) => s.docsVersion);
  const page = project.docs.pages[pageId];

  // P and the ▶ button start it
  useEffect(() => {
    const start = () => {
      if (!page || app.get().presenting) return;
      const s = startOf(page, app.get().selection);
      if (s) app.set({ presenting: { start: s, trail: [s] }, menu: undefined, searchOpen: false });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'p' || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as HTMLElement)?.closest?.('input,textarea,[contenteditable="true"]')) return;
      e.preventDefault();
      start();
    };
    window.addEventListener('adl:present', start);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('adl:present', start);
      window.removeEventListener('keydown', onKey);
    };
  }, [page]);

  if (!presenting || !page) return null;
  return <Presenting project={project} page={page} engine={engine} trail={presenting.trail} />;
}

function Presenting({
  project,
  page,
  engine,
  trail,
}: {
  project: ProjectModel;
  page: PageDoc;
  engine: Engine;
  trail: Id[];
}) {
  const cur = trail[trail.length - 1]!;
  const item = page.items[cur] as ScreenItem | undefined;
  const nexts = useMemo(() => (item ? nextsOf(project, page, cur) : []), [project, page, cur, item]);
  const [pick, setPick] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const meta = item ? project.screenOf(cur, item) : undefined;
  const frame = item ? project.frameOf(cur, item) : { w: 393, h: 852 as number | 'auto' };
  const fh = frame.h === 'auto' ? (meta?.autoH ?? 1200) : frame.h;

  const go = (to: Id) => app.set({ presenting: { start: trail[0]!, trail: [...trail, to] } });
  const back = () => trail.length > 1 && app.set({ presenting: { start: trail[0]!, trail: trail.slice(0, -1) } });
  const end = () => {
    app.set({ presenting: undefined, selection: [cur] });
    engine.fit([cur], false);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new screen starts with its first arrow picked
  useEffect(() => setPick(0), [cur]);

  // the canvas underneath rests while presenting
  useEffect(() => {
    engine.setPausedAll(true);
    return () => engine.setPausedAll(app.get().animations === 'never');
  }, [engine]);

  // fit the screen into the stage
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const resize = () => setScale(Math.min(1.25, (el.clientHeight - 24) / fh, (el.clientWidth - 24) / frame.w));
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fh, frame.w]);

  // mount the live screen and wire its hotspots (again for another screen or a new version of it)
  // biome-ignore lint/correctness/useExhaustiveDependencies: go/page/project change together with cur and nexts
  useEffect(() => {
    const h = host.current;
    if (!h || !meta) return;
    let cancelled = false;
    const cleanups: (() => void)[] = [];
    void prepare(fetchSource('', project.id), meta.hash)
      .then((p) => {
        if (cancelled) return;
        const root = mountPrepared(h, p);
        const byEl = new Map(nexts.filter((n) => n.el).map((n) => [n.el!, n.to]));
        for (const el of root.querySelectorAll<HTMLElement>('[data-adl-anchor],[data-adl-go]')) {
          const to = byEl.get(el.dataset.adlAnchor ?? '') ?? el.dataset.adlGo;
          if (!to || !page.items[to]) continue;
          el.classList.add('adl-hotspot');
          const onClick = (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
            go(to);
          };
          el.addEventListener('click', onClick);
          cleanups.push(() => el.removeEventListener('click', onClick));
        }
        const style = document.createElement('style');
        style.textContent =
          '.adl-hotspot{cursor:pointer}.adl-hotspot:hover{outline:2px solid #4d8eff;outline-offset:2px;border-radius:6px}';
        root.appendChild(style);
      })
      // a version replaced meanwhile: the next one arrives with a screens event and this effect runs again
      .catch(() => undefined);
    return () => {
      cancelled = true;
      for (const c of cleanups) c();
      unmount(h);
    };
  }, [meta?.hash, cur, nexts]);

  // the only "auto" arrow advances by itself
  const auto = nexts.length === 1 && nexts[0]!.after !== undefined ? nexts[0] : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the timer restarts only when the screen changes
  useEffect(() => {
    if (!auto) return;
    const t = setTimeout(() => go(auto.to), auto.after);
    return () => clearTimeout(t);
  }, [cur, auto?.to]);

  // one stable listener (capture, so canvas shortcuts like Backspace never see these keys); it reads the latest state
  const latest = useRef({ nexts, pick, go, back, end });
  latest.current = { nexts, pick, go, back, end };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const l = latest.current;
      if (e.key === 'Escape') l.end();
      else if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
        const n = l.nexts[l.pick];
        if (n) l.go(n.to);
      } else if (e.key === 'ArrowLeft' || e.key === 'Backspace') l.back();
      else if (e.key === 'ArrowDown') setPick((p) => Math.min(l.nexts.length - 1, p + 1));
      else if (e.key === 'ArrowUp') setPick((p) => Math.max(0, p - 1));
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const titleOf = (id: Id) => {
    const it = page.items[id] as ScreenItem | undefined;
    return (it && (it.title ?? project.screenOf(id, it)?.title)) || '';
  };

  return (
    <div className="pres" data-testid="present">
      <div className="pres-top">
        <Play size={16} />
        <b>Presenting {page.name}</b> from {trail[0]}
        <button type="button" className="x" onClick={end} aria-label="End presenting">
          Esc <X size={16} />
        </button>
      </div>
      <div className="trail">
        {trail.map((id, i) => (
          <button
            type="button"
            // biome-ignore lint/suspicious/noArrayIndexKey: a loop visits the same screen twice; the step is the key
            key={`${id}-${i}`}
            className={i === trail.length - 1 ? 'cur' : ''}
            onClick={() => app.set({ presenting: { start: trail[0]!, trail: trail.slice(0, i + 1) } })}
          >
            <b>{id}</b>
            {titleOf(id)}
          </button>
        ))}
      </div>
      <div className="pres-stage" ref={stage}>
        <div className="pres-cap">
          <b>{cur}</b>
          {titleOf(cur)}
        </div>
        <div className="pres-frame" style={{ width: frame.w * scale, height: fh * scale }}>
          {meta ? (
            <div
              ref={host}
              className="pres-host"
              style={{ width: frame.w, height: fh, transform: `scale(${scale})` }}
            />
          ) : (
            <div className="pres-planned">Planned · no HTML yet</div>
          )}
        </div>
      </div>
      <div className="nexts">
        {nexts.length ? (
          nexts.map((n, i) => (
            <button
              type="button"
              key={`${n.arrow.from}>${n.arrow.to}:${n.label}`}
              className={`nx${i === pick ? ' on' : ''}`}
              onMouseEnter={() => setPick(i)}
              onClick={() => go(n.to)}
            >
              <small>
                {n.label}
                {n === auto ? <i className="auto" style={{ animationDuration: `${n.after}ms` }} /> : null}
              </small>
              <b>{n.to}</b>
              {titleOf(n.to)}
            </button>
          ))
        ) : (
          <div className="nx end">The flow ends here.{trail.length > 1 ? ' ← goes back.' : ''}</div>
        )}
      </div>
      <div className="pres-foot">→ next · ← back · the buttons are the arrows' labels</div>
    </div>
  );
}
