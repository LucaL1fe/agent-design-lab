// Compare: the design next to the real product, as a checklist. One row per screen (or flow): the design, a capture
// per device (a recording where it moves), the build state and why it deviates. People change a state and write the
// reason right here; that is how they give feedback on the build without opening the product. C opens it, Esc closes.
import { Crosshair, Play, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BUILD_STATES,
  buildDef,
  captureDevices,
  countBuild,
  countFlows,
  NEEDS_NOTE,
  progressText,
  setBuild,
  setFlowBuild,
  shownCapture,
} from '../../core/build.ts';
import type { BuildInfo, BuildState, Capture, Flow, Id, PageDoc, ScreenItem } from '../../core/types.ts';
import { type Engine, fileUrl } from '../engine/engine.ts';
import { app, toast } from '../state/app.ts';
import type { ProjectModel } from '../state/project.ts';
import { useStore } from '../state/store.ts';

interface Row {
  id: Id;
  item: ScreenItem;
  title: string;
}

interface Group {
  id: Id | '';
  title: string;
  rows: Row[];
}

type Zoom = { kind: 'screen' | 'flow'; id: Id; device: string };

export function CompareView({ engine, pageId }: { engine: Engine; pageId: string }) {
  const project = useStore(app, (s) => s.project)!;
  const tab = useStore(app, (s) => s.compare);
  useStore(app, (s) => s.docsVersion);
  const page = project.docs.pages[pageId];
  if (!tab || !page) return null;
  return <Compare project={project} page={page} pageId={pageId} engine={engine} tab={tab} />;
}

/** Screens in reading order, grouped by their top-level section. */
function groupsOf(project: ProjectModel, page: PageDoc, pageId: string): Group[] {
  const rects = project.placement(pageId)?.rects;
  const top = (id: Id): Id | '' => {
    let cur = page.items[id]?.parent;
    let last: Id | '' = '';
    const seen = new Set<Id>();
    while (cur && !seen.has(cur)) {
      last = cur;
      seen.add(cur);
      cur = page.items[cur]?.parent;
    }
    return last;
  };
  const pos = (id: Id) => rects?.get(id) ?? { x: 0, y: 0 };
  const groups = new Map<Id | '', Group>();
  const screens = Object.entries(page.items).filter(
    ([, it]) => it.kind === 'screen' && !it.archived && (it as ScreenItem).build,
  ) as [Id, ScreenItem][];
  for (const [id, item] of screens) {
    const g = top(id);
    if (!groups.has(g)) {
      const sec = g ? page.items[g] : undefined;
      groups.set(g, { id: g, title: sec?.kind === 'section' ? sec.title : 'Not in a section', rows: [] });
    }
    groups.get(g)!.rows.push({ id, item, title: item.title ?? project.screenOf(id, item)?.title ?? '' });
  }
  const byPos = (a: Id, b: Id) => {
    const pa = pos(a);
    const pb = pos(b);
    return pa.y - pb.y || pa.x - pb.x;
  };
  for (const g of groups.values()) g.rows.sort((a, b) => byPos(a.id, b.id));
  return [...groups.values()].sort((a, b) => {
    if (!a.id) return 1;
    if (!b.id) return -1;
    return byPos(a.id, b.id);
  });
}

function Compare({
  project,
  page,
  pageId,
  engine,
  tab,
}: {
  project: ProjectModel;
  page: PageDoc;
  pageId: string;
  engine: Engine;
  tab: 'screens' | 'flows';
}) {
  const [filter, setFilter] = useState<BuildState | 'all' | 'open'>('open');
  const [section, setSection] = useState<Id | ''>('*');
  const [zoom, setZoom] = useState<Zoom>();
  const devices = useMemo(() => captureDevices(page), [page]);
  const groups = useMemo(() => groupsOf(project, page, pageId), [project, page, pageId]);
  const counts = countBuild(page);
  const flowCounts = countFlows(page);
  const flows = Object.entries(page.flows ?? {});

  const keep = (b: BuildInfo | undefined) => {
    const st = b?.state ?? 'todo';
    if (filter === 'all') return true;
    if (filter === 'open') return st !== 'matching';
    return st === filter;
  };

  const close = () => app.set({ compare: undefined });
  const latest = useRef({ zoom, close });
  latest.current = { zoom, close };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input,textarea')) return;
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (latest.current.zoom) setZoom(undefined);
      else latest.current.close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // the canvas underneath rests
  useEffect(() => {
    engine.setPausedAll(true);
    return () => engine.setPausedAll(app.get().animations === 'never');
  }, [engine]);

  const showOnCanvas = (ids: Id[], flow?: Id) => {
    app.set({ compare: undefined, selection: flow ? [] : ids, ...(flow ? { flowFocus: flow } : {}) });
    if (!flow) engine.fit(ids.filter((id) => engine.rects.has(id)));
    if (flow) toast({ kind: 'info', text: `Flow ${flow} on the canvas · Esc clears` });
  };

  const setScreen = (id: Id, state: BuildState, note: string | undefined) => {
    if (NEEDS_NOTE.has(state) && !(note ?? (page.items[id] as ScreenItem).build?.note)?.trim()) {
      toast({ kind: 'warn', text: `${buildDef(state)!.label} needs a reason: write it in the box first` });
      return;
    }
    project.apply(setBuild(project.docs, pageId, [id], state, note, 'human'), `${id}: ${buildDef(state)!.label}`);
  };
  const setFlow = (id: Id, state: BuildState, note: string | undefined) => {
    if (NEEDS_NOTE.has(state) && !(note ?? page.flows?.[id]?.build?.note)?.trim()) {
      toast({ kind: 'warn', text: `${buildDef(state)!.label} needs a reason: write it in the box first` });
      return;
    }
    project.apply(
      setFlowBuild(project.docs, pageId, id, state, note, 'human'),
      `flow ${id}: ${buildDef(state)!.label}`,
    );
  };

  const countOf = (st: BuildState) => (tab === 'screens' ? counts : flowCounts).find((c) => c.state === st)?.count ?? 0;
  const total = (tab === 'screens' ? counts : flowCounts).reduce((n, c) => n + c.count, 0);

  return (
    <div className="cmp" data-testid="compare" onPointerDown={(e) => e.stopPropagation()}>
      <div className="cmp-top">
        <b>Compare</b>
        <span className="muted">the design next to the real product · {page.name}</span>
        <div className="cmp-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'screens'}
            className={tab === 'screens' ? 'on' : ''}
            onClick={() => app.set({ compare: 'screens' })}
          >
            Screens <small>{progressText(counts) || '0'}</small>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'flows'}
            className={tab === 'flows' ? 'on' : ''}
            onClick={() => app.set({ compare: 'flows' })}
            data-testid="compare-flows-tab"
          >
            Flows <small>{progressText(flowCounts) || '0'}</small>
          </button>
        </div>
        <button type="button" className="x" onClick={close} aria-label="Close compare">
          Esc <X size={16} />
        </button>
      </div>
      <div className="cmp-filters">
        <button type="button" className={filter === 'open' ? 'on' : ''} onClick={() => setFilter('open')}>
          Not matching yet <small>{total - countOf('matching')}</small>
        </button>
        <button type="button" className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
          All <small>{total}</small>
        </button>
        {BUILD_STATES.map((s) => (
          <button
            type="button"
            key={s.id}
            className={filter === s.id ? 'on' : ''}
            onClick={() => setFilter(s.id)}
            style={{ '--c': s.color } as React.CSSProperties}
          >
            <i className="dot" /> {s.label} <small>{countOf(s.id)}</small>
          </button>
        ))}
        {tab === 'screens' && groups.length > 1 ? (
          <select value={section} onChange={(e) => setSection(e.target.value)} aria-label="Section">
            <option value="*">Every section</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.title}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <div className="cmp-body" style={{ '--devs': Math.max(1, devices.length) } as React.CSSProperties}>
        <div className="cmp-head">
          <span className="c-id">{tab === 'screens' ? 'Screen' : 'Flow'}</span>
          <span className="c-design">{tab === 'screens' ? 'Design' : 'Steps'}</span>
          {devices.map((d) => (
            <span key={d} className="c-dev">
              {d}
            </span>
          ))}
          <span className="c-state">Build</span>
        </div>
        {tab === 'screens'
          ? groups
              .filter((g) => section === '*' || g.id === section)
              .map((g) => {
                const rows = g.rows.filter((r) => keep(r.item.build));
                if (!rows.length) return null;
                return (
                  <div key={g.id || '-'} className="cmp-group">
                    <div className="cmp-gt">
                      {g.title} <small>{progressText(countBuild(page, g.id || undefined))}</small>
                    </div>
                    {rows.map((r) => (
                      <div key={r.id} className="cmp-row" data-id={r.id}>
                        <div className="c-id">
                          <button
                            type="button"
                            className="go"
                            onClick={() => showOnCanvas([r.id])}
                            title="Show on the canvas"
                          >
                            <b>{r.id}</b> <Crosshair size={12} />
                          </button>
                          <span>{r.title}</span>
                        </div>
                        <div className="c-design">
                          <DesignPic project={project} id={r.id} item={r.item} />
                        </div>
                        {devices.map((d) => (
                          <div key={d} className="c-dev">
                            <CapturePic
                              pid={project.id}
                              cap={shownCapture(r.item.build, d)}
                              onOpen={() => setZoom({ kind: 'screen', id: r.id, device: d })}
                            />
                          </div>
                        ))}
                        <div className="c-state">
                          <BuildEditor
                            build={r.item.build}
                            onSet={(st, note) => setScreen(r.id, st, note)}
                            onNote={(note) => setScreen(r.id, r.item.build?.state ?? 'todo', note)}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })
          : flows
              .filter(([, f]) => keep(f.build))
              .map(([fid, f]) => (
                <div key={fid} className="cmp-row flow" data-id={fid}>
                  <div className="c-id">
                    <button
                      type="button"
                      className="go"
                      onClick={() => showOnCanvas(f.steps, fid)}
                      title="Show the flow on the canvas"
                    >
                      <b>{fid}</b> <Crosshair size={12} />
                    </button>
                    <span>{f.title}</span>
                  </div>
                  <div className="c-design">
                    <Steps flow={f} page={page} onPick={(id) => showOnCanvas([id])} />
                  </div>
                  {devices.map((d) => (
                    <div key={d} className="c-dev">
                      <CapturePic
                        pid={project.id}
                        cap={shownCapture(f.build, d)}
                        onOpen={() => setZoom({ kind: 'flow', id: fid, device: d })}
                      />
                    </div>
                  ))}
                  <div className="c-state">
                    <BuildEditor
                      build={f.build}
                      onSet={(st, note) => setFlow(fid, st, note)}
                      onNote={(note) => setFlow(fid, f.build?.state ?? 'todo', note)}
                    />
                  </div>
                </div>
              ))}
        {tab === 'flows' && !flows.length ? (
          <div className="cmp-empty">No flows yet. An agent adds them with adl flow add.</div>
        ) : null}
      </div>
      {zoom ? <ZoomView project={project} page={page} zoom={zoom} devices={devices} onZoom={setZoom} /> : null}
    </div>
  );
}

function DesignPic({ project, id, item }: { project: ProjectModel; id: Id; item: ScreenItem }) {
  const snap = project.snapOf(id, item);
  if (!snap) return <div className="pic none">no picture yet</div>;
  return <img className="pic" loading="lazy" alt={`${id} design`} src={`${snap.url}-256.webp`} />;
}

function CapturePic({ pid, cap, onOpen }: { pid: string; cap: Capture | undefined; onOpen: () => void }) {
  if (!cap) return <div className="pic none">no capture</div>;
  const still = cap.kind === 'video' ? (cap.poster ?? cap.thumb) : (cap.thumb ?? cap.src);
  return (
    <button type="button" className="capbtn" onClick={onOpen} title={cap.label ?? 'Open it big'}>
      {still ? (
        <img className="pic" loading="lazy" alt="" src={fileUrl(pid, still, cap.at)} />
      ) : (
        <div className="pic none">video</div>
      )}
      {cap.kind === 'video' ? (
        <span className="playmark">
          <Play size={14} /> video
        </span>
      ) : null}
    </button>
  );
}

function Steps({ flow, page, onPick }: { flow: Flow; page: PageDoc; onPick: (id: Id) => void }) {
  return (
    <div className="steps">
      {flow.steps.map((id, i) => {
        const it = page.items[id];
        const st = it?.kind === 'screen' ? it.build?.state : undefined;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: a flow can visit the same screen twice; the step is the key
          <span key={`${id}-${i}`} className="step">
            {i ? <i className="arr">→</i> : null}
            <button
              type="button"
              onClick={() => onPick(id)}
              style={{ '--c': buildDef(st)?.color ?? '#4a4a46' } as React.CSSProperties}
              title={st ? buildDef(st)!.label : 'not in the build check'}
            >
              {id}
            </button>
          </span>
        );
      })}
    </div>
  );
}

function BuildEditor({
  build,
  onSet,
  onNote,
}: {
  build: BuildInfo | undefined;
  onSet: (state: BuildState, note: string | undefined) => void;
  onNote: (note: string) => void;
}) {
  const [note, setNote] = useState(build?.note ?? '');
  useEffect(() => setNote(build?.note ?? ''), [build?.note]);
  const cur = build?.state ?? 'todo';
  return (
    <div className="bed">
      <div className="bed-states">
        {BUILD_STATES.map((s) => (
          <button
            type="button"
            key={s.id}
            className={cur === s.id ? 'on' : ''}
            style={{ '--c': s.color } as React.CSSProperties}
            onClick={() => onSet(s.id, note.trim() !== (build?.note ?? '') ? note.trim() : undefined)}
            title={s.hint}
            aria-pressed={cur === s.id}
          >
            {s.label}
          </button>
        ))}
      </div>
      <textarea
        className="ta"
        rows={2}
        value={note}
        placeholder={NEEDS_NOTE.has(cur) ? 'Why? (needed)' : 'A note (why it deviates, what is missing…)'}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => note.trim() !== (build?.note ?? '') && onNote(note.trim())}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            (e.target as HTMLTextAreaElement).blur();
          }
        }}
      />
      {build?.at ? (
        <div className="bed-by">
          {build.by === 'human' ? 'you' : build.by === 'agent' ? 'Claude' : (build.by ?? '')} ·{' '}
          {new Date(build.at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
        </div>
      ) : null}
    </div>
  );
}

/** One screen or flow big: the design (or the flow's steps) next to the capture, video with controls. */
function ZoomView({
  project,
  page,
  zoom,
  devices,
  onZoom,
}: {
  project: ProjectModel;
  page: PageDoc;
  zoom: Zoom;
  devices: string[];
  onZoom: (z: Zoom | undefined) => void;
}) {
  const it = zoom.kind === 'screen' ? (page.items[zoom.id] as ScreenItem | undefined) : undefined;
  const flow = zoom.kind === 'flow' ? page.flows?.[zoom.id] : undefined;
  const build = it?.build ?? flow?.build;
  const cap = shownCapture(build, zoom.device);
  const image = build?.captures?.find((c) => c.device === zoom.device && c.kind === 'image');
  const snap = it ? project.snapOf(zoom.id, it) : undefined;
  return (
    <div className="cmp-zoom" onClick={() => onZoom(undefined)} onKeyDown={() => undefined} role="dialog">
      <div className="cz-panel" onClick={(e) => e.stopPropagation()} onKeyDown={() => undefined} role="document">
        <div className="cz-top">
          <b>{zoom.kind === 'flow' ? `Flow ${zoom.id}` : zoom.id}</b>
          <span>{it?.title ?? project.screenOf(zoom.id, it ?? { kind: 'screen' })?.title ?? flow?.title ?? ''}</span>
          <div className="viewsw">
            {devices.map((d) => (
              <button
                type="button"
                key={d}
                className={d === zoom.device ? 'on' : ''}
                onClick={() => onZoom({ ...zoom, device: d })}
              >
                {d}
              </button>
            ))}
          </div>
          <button type="button" className="x" onClick={() => onZoom(undefined)} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="cz-body">
          {snap ? (
            <figure>
              <figcaption>Design</figcaption>
              <img alt="design" src={`${snap.url}-512.webp`} />
            </figure>
          ) : flow ? (
            <figure className="cz-steps">
              <figcaption>Steps</figcaption>
              <Steps flow={flow} page={page} onPick={(id) => onZoom({ kind: 'screen', id, device: zoom.device })} />
            </figure>
          ) : null}
          <figure>
            <figcaption>Real product · {zoom.device}</figcaption>
            {cap?.kind === 'video' ? (
              <video
                key={cap.src + (cap.at ?? '')}
                src={fileUrl(project.id, cap.src, cap.at)}
                poster={cap.poster ? fileUrl(project.id, cap.poster, cap.at) : undefined}
                controls
                autoPlay
                muted
                loop
                playsInline
              />
            ) : cap ? (
              <img alt="capture" src={fileUrl(project.id, cap.src, cap.at)} />
            ) : (
              <div className="pic none">no capture for this device</div>
            )}
          </figure>
          {cap?.kind === 'video' && image ? (
            <figure>
              <figcaption>Screenshot · {zoom.device}</figcaption>
              <img alt="screenshot" src={fileUrl(project.id, image.src, image.at)} />
            </figure>
          ) : null}
        </div>
        {build?.note ? <div className="cz-note">{build.note}</div> : null}
      </div>
    </div>
  );
}
