import { Check, ExternalLink, FolderOpen, Plus, RotateCcw, Volume2, VolumeX, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  addStatus,
  approve,
  approvedStatusId,
  deleteStatusDef,
  HISTORY_PAGE,
  pickProposal,
  rejectProposal,
  restoreFromHistory,
  setStatus,
  updateArrow,
  updateStatusDef,
} from '../../core/actions.ts';
import {
  BUILD_STATES,
  buildCountsText,
  buildDef,
  countBuild,
  countFlows,
  flowsThrough,
  NEEDS_NOTE,
  progressText,
  setBuild,
  usesBuild,
} from '../../core/build.ts';
import { pageKey } from '../../core/ops.ts';
import { portalsTo } from '../../core/reach.ts';
import {
  arrowStylesOf,
  countStatuses,
  countsText,
  inkFor,
  STATUS_SWATCHES,
  statusesOf,
  statusInk,
} from '../../core/status.ts';
import type { Arrow, BuildState, Id, Item, NoteColor, ScreenItem, StatusDef } from '../../core/types.ts';
import { api } from '../boot/connection.ts';
import { fileUrl } from '../engine/engine.ts';
import { app, navigate, toast } from '../state/app.ts';
import type { ProjectModel } from '../state/project.ts';
import { toggleScreenSound } from '../state/sound.ts';
import { useStore } from '../state/store.ts';
import { engineRef } from './CanvasView.tsx';
import { agoText } from './TopBar.tsx';

const BY_LABEL: Record<string, string> = { agent: 'made by Claude', human: 'made by you', import: 'imported' };

function open(project: ProjectModel, file: string, reveal = false) {
  void api(`/api/p/${encodeURIComponent(project.id)}/open`, {
    method: 'POST',
    body: JSON.stringify({ file, reveal }),
  }).catch((e: Error) => toast({ kind: 'warn', text: e.message }));
}

export function Inspector({ pageId }: { pageId: string }) {
  const project = useStore(app, (s) => s.project)!;
  const sel = useStore(app, (s) => s.selection);
  const arrowSel = useStore(app, (s) => s.arrowSel);
  useStore(app, (s) => s.docsVersion);
  const page = project.docs.pages[pageId];
  if (!page) return null;
  const close = () => app.set({ panel: false });
  let body: React.ReactNode;
  if (arrowSel.length === 1 && page.arrows[arrowSel[0]!])
    body = <ArrowPanel project={project} pageId={pageId} id={arrowSel[0]!} />;
  else if (sel.length === 1 && page.items[sel[0]!]) {
    const it = page.items[sel[0]!]!;
    if (it.archived) body = <HistoryPanel project={project} id={sel[0]!} item={it} />;
    else if (it.kind === 'screen') body = <ScreenPanel project={project} pageId={pageId} id={sel[0]!} item={it} />;
    else if (it.kind === 'note') body = <NotePanel project={project} pageId={pageId} id={sel[0]!} item={it} />;
    else if (it.kind === 'section')
      body = <SectionPanel project={project} pageId={pageId} id={sel[0]!} title={it.title} />;
    else body = <GenericPanel id={sel[0]!} item={it} />;
  } else if (sel.length > 1) body = <MultiPanel project={project} pageId={pageId} ids={sel} />;
  else body = <PagePanel project={project} pageId={pageId} />;
  return (
    <aside className="insp" aria-label="Inspector" data-testid="inspector" onPointerDown={(e) => e.stopPropagation()}>
      <button type="button" className="insp-close" onClick={close} aria-label="Close the panel">
        <X size={16} />
      </button>
      {body}
    </aside>
  );
}

function StatusList({
  project,
  current,
  onPick,
  onNew,
}: {
  project: ProjectModel;
  current?: string | undefined;
  onPick: (id: string) => void;
  onNew: () => void;
}) {
  const [menu, setMenu] = useState<string>();
  return (
    <div className="stl" role="radiogroup" aria-label="Status">
      {statusesOf(project.docs.project).map((s) => (
        // biome-ignore lint/a11y/useSemanticElements: the row holds its own menu button, which a native radio can't
        <div
          key={s.id}
          className={`st${current === s.id ? ' on' : ''}`}
          role="radio"
          aria-checked={current === s.id}
          tabIndex={0}
          onClick={() => onPick(s.id)}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onPick(s.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            if (s.createdBy !== 'builtin') setMenu(s.id);
          }}
          data-status={s.id}
        >
          <i style={{ background: s.color }} />
          <span className="lb">{s.label}</span>
          {s.role === 'approved' ? (
            <span className="by">no banner</span>
          ) : s.createdBy && BY_LABEL[s.createdBy] ? (
            <span className="by">{BY_LABEL[s.createdBy]}</span>
          ) : null}
          {current === s.id ? <Check size={14} className="ck" /> : null}
          {menu === s.id ? <StatusMenu project={project} status={s} close={() => setMenu(undefined)} /> : null}
        </div>
      ))}
      <button type="button" className="st add" onClick={onNew} data-testid="new-status">
        <Plus size={14} /> New status
      </button>
    </div>
  );
}

function StatusMenu({ project, status, close }: { project: ProjectModel; status: StatusDef; close: () => void }) {
  return (
    <div className="menu" style={{ right: 0, top: 30 }} onClick={(e) => e.stopPropagation()}>
      {STATUS_SWATCHES.map((c) => (
        <button
          type="button"
          key={c}
          className="mi"
          onClick={() => {
            project.apply(
              updateStatusDef(project.docs, status.id, { color: c, ink: inkFor(c) }),
              `Status colour: ${status.label}`,
            );
            close();
          }}
        >
          <i style={{ width: 12, height: 12, borderRadius: 4, background: c, display: 'inline-block' }} /> Colour
        </button>
      ))}
      <hr />
      <button
        type="button"
        className="mi danger"
        onClick={() => {
          const done = project.apply(deleteStatusDef(project.docs, status.id), `Deleted status ${status.label}`);
          close();
          if (done.length)
            toast({ kind: 'info', text: `Status “${status.label}” deleted; its screens have no status now` });
        }}
      >
        Delete status
      </button>
      <button type="button" className="mi muted" onClick={close}>
        Cancel
      </button>
    </div>
  );
}

function NewStatus({
  project,
  preview,
  onDone,
}: {
  project: ProjectModel;
  preview?: string | undefined;
  onDone: (id?: string) => void;
}) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(STATUS_SWATCHES[3]!);
  const [banner, setBanner] = useState(true);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const add = () => {
    const label = name.trim();
    if (!label) return;
    const r = addStatus(project.docs, { label, color, ink: inkFor(color), role: 'review', banner, createdBy: 'human' });
    project.apply(r.ops, `New status “${label}”`);
    onDone(r.id);
  };
  return (
    <div className="pop" data-testid="status-editor">
      <div className="pop-h">New status</div>
      <input
        ref={ref}
        className="field"
        value={name}
        placeholder="Name, e.g. Test on a small phone"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') add();
          if (e.key === 'Escape') onDone();
        }}
        aria-label="Status name"
      />
      <div className="sw" role="radiogroup" aria-label="Colour">
        {STATUS_SWATCHES.map((c) => (
          <button
            type="button"
            key={c}
            className={c === color ? 'on' : ''}
            style={{ background: c }}
            onClick={() => setColor(c)}
            aria-label={`Colour ${c}`}
          />
        ))}
      </div>
      <label className="toggle">
        Show a banner on the screen
        <input type="checkbox" checked={banner} onChange={(e) => setBanner(e.target.checked)} />
        <span className={`tg${banner ? ' on' : ''}`} />
      </label>
      <div className="pv-l">Preview with this screen's text</div>
      <div className="ban-preview" style={{ background: color, color: inkFor(color), opacity: banner ? 1 : 0.35 }}>
        <b>{name.trim() || 'Your status'}</b>
        {preview ? ` · ${preview}` : ''}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn sm" onClick={() => onDone()}>
          Cancel
        </button>
        <button type="button" className="btn sm primary" style={{ flex: 1 }} onClick={add} disabled={!name.trim()}>
          Add status
        </button>
      </div>
      <div className="arw">
        Saved in <b>project.json</b>, so every page can use it, and Claude can too.
      </div>
    </div>
  );
}

function ScreenPanel({
  project,
  pageId,
  id,
  item,
}: {
  project: ProjectModel;
  pageId: string;
  id: Id;
  item: ScreenItem;
}) {
  const meta = project.screenOf(id, item);
  const file = meta?.file ?? item.src ?? `screens/${item.screen ?? id}.html`;
  const st = statusesOf(project.docs.project).find((s) => s.id === item.status);
  const approved = st?.role === 'approved';
  const [creating, setCreating] = useState(false);
  const [banner, setBanner] = useState(item.banner ?? '');
  useEffect(() => setBanner(item.banner ?? ''), [item.banner, id]);
  const sound = useStore(app, (s) => s.sound);
  const page = project.docs.pages[pageId]!;
  const ins = Object.entries(page.arrows).filter(([, a]) => a.to === id && a.from !== id);
  const outs = Object.entries(page.arrows).filter(([, a]) => a.from === id);
  // portals elsewhere that stand for this screen: where other flows reach it
  const via = portalsTo(project.docs.pages, pageId, id);
  const goPortal = (pg: string, pid: Id) => {
    if (pg !== pageId) return navigate({ pid: project.id, page: pg, focus: pid });
    app.set({ selection: [pid], arrowSel: [] });
    engineRef.current?.fit([pid]);
  };
  const pick = (sid: string) => {
    if (sid === item.status) return;
    const def = statusesOf(project.docs.project).find((s) => s.id === sid);
    const done = project.apply(setStatus(project.docs, pageId, [id], sid), `${id}: ${def?.label ?? sid}`);
    if (done.length && def?.role === 'approved')
      toast({ kind: 'ok', text: `${id} approved`, code: `pages/${pageId}.json` });
  };
  const saveBanner = () => {
    const v = banner.trim();
    if (v !== (item.banner ?? ''))
      project.apply(
        [{ doc: pageKey(pageId), path: ['items', id, 'banner'], value: v || undefined }],
        `${id}: banner text`,
      );
  };
  const selectArrow = (aid: Id) => {
    app.set({ selection: [], arrowSel: [aid] });
    const a = page.arrows[aid]!;
    engineRef.current?.fit([a.from, a.to]);
  };
  if (item.proposalFor) return <ProposalPanel project={project} pageId={pageId} id={id} item={item} file={file} />;
  return (
    <>
      <div className="insp-h">
        <b>{id}</b> <span className="tt">{item.title ?? meta?.title ?? id}</span>
      </div>
      <div className="lbl">File</div>
      <div className="file">
        <span className="mono">{file}</span>
        <button type="button" onClick={() => open(project, file)} title="Open in your editor">
          <ExternalLink size={13} /> Open
        </button>
      </div>
      {!meta ? <div className="note-warn">Planned: Claude has not written this screen yet.</div> : null}
      <div className="lbl">Status</div>
      {creating ? (
        <NewStatus
          project={project}
          preview={item.banner}
          onDone={(sid) => {
            setCreating(false);
            if (sid) project.apply(setStatus(project.docs, pageId, [id], sid), `${id}: new status`);
          }}
        />
      ) : (
        <StatusList project={project} current={item.status} onPick={pick} onNew={() => setCreating(true)} />
      )}
      <div className="lbl">Banner text</div>
      <textarea
        className="ta"
        value={approved ? '' : banner}
        placeholder={
          approved ? 'Approved screens have no banner' : 'What needs to happen, e.g. “Bigger breathing circle?”'
        }
        disabled={approved}
        onChange={(e) => setBanner(e.target.value)}
        onBlur={saveBanner}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            (e.target as HTMLTextAreaElement).blur();
          }
        }}
        rows={2}
        data-testid="banner-text"
      />
      <button
        type="button"
        className={`btn-p${approved ? ' done' : ''}`}
        onClick={() =>
          !approved &&
          project.apply(approve(project.docs, pageId, [id]), `${id} approved`).length > 0 &&
          toast({ kind: 'ok', text: `${id} approved`, code: `pages/${pageId}.json` })
        }
        data-testid="approve"
      >
        {approved ? '✓ Approved' : 'Approve'}
      </button>
      <BuildBlock project={project} pageId={pageId} id={id} item={item} />
      <div className="lbl">Arrows</div>
      <div className="arw">
        {ins.length ? (
          <div>
            In:{' '}
            {ins.map(([aid, a], i) => (
              <span key={aid}>
                {i ? ' · ' : ''}
                <button type="button" className="lnk" onClick={() => selectArrow(aid)}>
                  <b>{a.label || 'no label'}</b>
                </button>{' '}
                from {a.from}
              </span>
            ))}
          </div>
        ) : via.length ? null : (
          <div>Nothing leads here yet</div>
        )}
        {via.length ? (
          <div data-testid="reached-via">
            Via portal:{' '}
            {via.map((v, i) => (
              <span key={`${v.page}/${v.id}`}>
                {i ? ' · ' : ''}
                <button type="button" className="lnk" onClick={() => goPortal(v.page, v.id)}>
                  <b>{v.text || v.id}</b>
                </button>
                {v.from.length ? ` from ${v.from.join(', ')}` : ''}
                {v.page !== pageId ? ` (page ${project.docs.pages[v.page]?.name ?? v.page})` : ''}
              </span>
            ))}
          </div>
        ) : null}
        {outs.length ? (
          <div>
            Out:{' '}
            {outs.map(([aid, a], i) => (
              <span key={aid}>
                {i ? ' · ' : ''}
                <button type="button" className="lnk" onClick={() => selectArrow(aid)}>
                  <b>{a.label || 'no label'}</b>
                </button>{' '}
                → {a.to}
              </span>
            ))}
          </div>
        ) : (
          <div>No way out yet</div>
        )}
      </div>
      {meta?.sounds?.length ? (
        <>
          <div className="lbl">Sounds</div>
          <ul className="snds" data-testid="screen-sounds">
            {meta.sounds.map((s) => (
              <li key={`${s.src}|${s.el}|${s.at ?? 0}`}>
                <span className="mono">{s.src.split('/').pop()}</span> on <span className="mono">{s.el}</span>
                {s.at ? ` · ${s.at} ms into its animation` : ''}
              </li>
            ))}
          </ul>
          <button type="button" className="btn sm" onClick={() => toggleScreenSound(id)}>
            {sound === id ? <VolumeX size={14} /> : <Volume2 size={14} />}
            {sound === id ? 'Turn the sound off' : 'Play with sound'}
          </button>
        </>
      ) : null}
      {meta && meta.warnings.filter(forPeople).length ? (
        <>
          <div className="lbl">Problems in this screen</div>
          <ul className="warns">
            {meta.warnings.filter(forPeople).map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}

function ProposalPanel({
  project,
  pageId,
  id,
  item,
  file,
}: {
  project: ProjectModel;
  pageId: string;
  id: Id;
  item: ScreenItem;
  file: string;
}) {
  const target = item.proposalFor!;
  const page = project.docs.pages[pageId]!;
  const t = page.items[target];
  const tTitle = t?.kind === 'screen' ? (t.title ?? project.screenOf(target, t)?.title ?? target) : target;
  const use = () => {
    try {
      const r = pickProposal(project.docs, pageId, id, 'human');
      if (!project.apply(r.ops, `${id} replaces ${target}`).length) return;
      app.set({ selection: [id] });
      toast({
        kind: 'ok',
        text: `${id} now replaces ${target}`,
        action: { label: 'Approve', run: () => project.apply(approve(project.docs, pageId, [id]), `${id} approved`) },
      });
    } catch (e) {
      toast({ kind: 'warn', text: (e as Error).message });
    }
  };
  const reject = () => {
    if (!project.apply(rejectProposal(project.docs, pageId, id, 'human'), `Rejected ${id}`).length) return;
    app.set({ selection: [] });
    toast({ kind: 'info', text: `${id} moved to History`, action: { label: 'Undo', run: () => project.undo() } });
  };
  return (
    <>
      <div className="insp-h">
        <b>{id}</b> <span className="tt">{item.title ?? project.screenOf(id, item)?.title ?? id}</span>
      </div>
      <div className="lbl">File</div>
      <div className="file">
        <span className="mono">{file}</span>
        <button type="button" onClick={() => open(project, file)}>
          <ExternalLink size={13} /> Open
        </button>
      </div>
      <div className="lbl">Proposal for</div>
      <div className="ta">
        {target} · {tTitle}
      </div>
      <button type="button" className="btn-p" onClick={use} data-testid="use-instead">
        Use instead of {target}
      </button>
      <button type="button" className="btn-s" onClick={reject} data-testid="reject">
        Reject
      </button>
      <div className="lbl">What happens</div>
      <div className="arw">
        {id} takes {target}'s place and its arrows. The old {target} and the other options move to the page{' '}
        <b>History</b>, nothing is deleted.
      </div>
    </>
  );
}

function HistoryPanel({ project, id, item }: { project: ProjectModel; id: Id; item: Item }) {
  const a = item.archived!;
  const when = new Date(a.at).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const restore = () => {
    try {
      const r = restoreFromHistory(project.docs, id);
      if (!project.apply(r.ops, `Restored ${id}`).length) return;
      navigate({ pid: project.id, page: r.page, focus: r.id });
      toast({ kind: 'ok', text: `${id} is back on ${project.docs.pages[r.page]?.name ?? r.page}` });
    } catch (e) {
      toast({ kind: 'warn', text: (e as Error).message });
    }
  };
  return (
    <>
      <div className="insp-h">
        <b>{id}</b> <span className="tt">{item.kind === 'screen' ? (item.title ?? id) : item.kind}</span>
      </div>
      <div className="lbl">In History since</div>
      <div className="ta">
        {when} ·{' '}
        {a.reason === 'replaced'
          ? `replaced by ${a.replacedBy}`
          : a.reason === 'not picked'
            ? `another option (${a.replacedBy}) was picked`
            : a.reason === 'rejected'
              ? 'rejected'
              : a.reason}{' '}
        · by {a.by === 'human' ? 'you' : 'Claude'}
      </div>
      {a.note ? <div className="arw">{a.note}</div> : null}
      <button type="button" className="btn-p" onClick={restore} data-testid="restore">
        <RotateCcw size={14} /> Restore to “{project.docs.pages[a.from]?.name ?? a.from}”
      </button>
    </>
  );
}

function ArrowPanel({ project, pageId, id }: { project: ProjectModel; pageId: string; id: Id }) {
  const a = project.docs.pages[pageId]!.arrows[id]!;
  const [label, setLabel] = useState(a.label ?? '');
  useEffect(() => setLabel(a.label ?? ''), [a.label, id]);
  const styles = arrowStylesOf(project.docs.project);
  const patch = (p: Partial<Record<keyof Arrow, unknown>>, summary: string) =>
    project.apply(updateArrow(project.docs, pageId, id, p as never, 'human'), summary);
  const fromItem = project.docs.pages[pageId]!.items[a.from];
  const anchors = fromItem ? (project.screenOf(a.from, fromItem)?.anchors ?? []) : [];
  return (
    <>
      <div className="insp-h">
        <b>Arrow</b>{' '}
        <span className="tt">
          {a.from} → {a.to}
        </span>
      </div>
      <div className="lbl">Label</div>
      <input
        className="field"
        value={label}
        placeholder="What the person does, or the condition"
        onChange={(e) => setLabel(e.target.value)}
        onBlur={() => label.trim() !== (a.label ?? '') && patch({ label: label.trim() || undefined }, 'Arrow label')}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        data-testid="arrow-label"
      />
      <div className="lbl">Style</div>
      <div className="chips">
        {Object.entries(styles).map(([sid, s]) => (
          <button
            type="button"
            key={sid}
            className={`chip${(a.style ?? 'flow') === sid ? ' on' : ''}`}
            onClick={() => patch({ style: sid === 'flow' ? undefined : sid }, `Arrow style: ${s.label}`)}
          >
            <i style={{ borderTopColor: s.color, borderTopStyle: s.dash ? 'dashed' : 'solid' }} />
            {s.label}
          </button>
        ))}
      </div>
      <div className="lbl">Trigger</div>
      <div className="chips">
        {(['tap', 'auto', 'condition', 'back', 'swipe', 'system'] as const).map((on) => (
          <button
            type="button"
            key={on}
            className={`chip${a.trigger?.on === on ? ' on' : ''}`}
            onClick={() =>
              patch(
                { trigger: a.trigger?.on === on ? undefined : { ...(a.trigger ?? {}), on } },
                `Arrow trigger: ${on}`,
              )
            }
          >
            {on}
          </button>
        ))}
      </div>
      {a.trigger?.on === 'tap' && anchors.length ? (
        <>
          <div className="lbl">Tapped element in {a.from}</div>
          <div className="chips">
            {anchors.map((el) => (
              <button
                type="button"
                key={el}
                className={`chip${a.trigger?.el === el ? ' on' : ''}`}
                onClick={() => patch({ trigger: { ...a.trigger!, el } }, `Arrow trigger element: ${el}`)}
              >
                {el}
              </button>
            ))}
          </div>
        </>
      ) : null}
      <div className="lbl">Ends</div>
      <div className="arw">
        From <b>{a.from}</b> to <b>{a.to}</b>. Drag an end on the canvas to attach it somewhere else.
      </div>
      <button type="button" className="btn-s" onClick={() => engineRef.ix?.deleteSelection()}>
        Delete arrow
      </button>
    </>
  );
}

const NOTE_COLORS: NoteColor[] = ['yellow', 'blue', 'green', 'pink', 'grey', 'orange', 'purple'];

function NotePanel({
  project,
  pageId,
  id,
  item,
}: {
  project: ProjectModel;
  pageId: string;
  id: Id;
  item: Item & { kind: 'note' };
}) {
  const set = (field: string, value: unknown, summary: string) =>
    project.apply([{ doc: pageKey(pageId), path: ['items', id, field], value }], summary);
  return (
    <>
      <div className="insp-h">
        <b>Note</b>{' '}
        <span className="tt">
          {item.by === 'agent' ? 'from Claude' : item.by === 'import' ? 'imported' : 'from you'}
        </span>
      </div>
      <div className="lbl">Text</div>
      <div className="ta" style={{ whiteSpace: 'pre-wrap' }}>
        {item.text}
      </div>
      <button type="button" className="btn-s" onClick={() => engineRef.ix?.editText(id)}>
        Edit text
      </button>
      <div className="lbl">Colour</div>
      <div className="chips">
        {NOTE_COLORS.map((c) => (
          <button
            type="button"
            key={c}
            className={`dot note-${c}${(item.color ?? 'yellow') === c ? ' on' : ''}`}
            onClick={() => set('color', c, 'Note colour')}
            aria-label={c}
          />
        ))}
      </div>
      <div className="lbl">Attached to</div>
      <div className="arw">
        {item.anchor ? (
          <>
            Screen <b>{item.anchor}</b>: it moves with it.{' '}
            <button type="button" className="lnk" onClick={() => set('anchor', undefined, 'Detached a note')}>
              Detach
            </button>
          </>
        ) : (
          'Nothing: it stays where it is.'
        )}
      </div>
      <button
        type="button"
        className={`btn-s${item.resolved ? ' on' : ''}`}
        onClick={() =>
          set('resolved', item.resolved ? undefined : true, item.resolved ? 'Reopened a note' : 'Resolved a note')
        }
      >
        {item.resolved ? 'Reopen' : 'Mark as resolved'}
      </button>
    </>
  );
}

function SectionPanel({
  project,
  pageId,
  id,
  title,
}: {
  project: ProjectModel;
  pageId: string;
  id: Id;
  title: string;
}) {
  const page = project.docs.pages[pageId]!;
  const counts = countStatuses(project.docs.project, page, id);
  const screens = Object.entries(page.items)
    .filter(([, i]) => i.parent === id && i.kind === 'screen')
    .map(([sid]) => sid);
  return (
    <>
      <div className="insp-h">
        <b>Section</b> <span className="tt">{title}</span>
      </div>
      <div className="lbl">Screens</div>
      <div className="arw">
        {screens.length} screen{screens.length === 1 ? '' : 's'} · {countsText(counts) || 'no statuses yet'}
      </div>
      <button type="button" className="btn-s" onClick={() => engineRef.ix?.renameSection(id)}>
        Rename
      </button>
      {screens.length ? (
        <BulkStatus project={project} pageId={pageId} ids={screens} label={`Set the status of all ${screens.length}`} />
      ) : null}
    </>
  );
}

function MultiPanel({ project, pageId, ids }: { project: ProjectModel; pageId: string; ids: Id[] }) {
  const page = project.docs.pages[pageId]!;
  const screens = ids.filter((i) => page.items[i]?.kind === 'screen' && !page.items[i]?.archived);
  return (
    <>
      <div className="insp-h">
        <b>{ids.length}</b> <span className="tt">items selected</span>
      </div>
      {screens.length ? (
        <BulkStatus
          project={project}
          pageId={pageId}
          ids={screens}
          label={`Status of ${screens.length} screen${screens.length === 1 ? '' : 's'}`}
        />
      ) : null}
      <button type="button" className="btn-s" onClick={() => engineRef.current?.fit(ids)}>
        Zoom to them
      </button>
    </>
  );
}

function BulkStatus({
  project,
  pageId,
  ids,
  label,
}: {
  project: ProjectModel;
  pageId: string;
  ids: Id[];
  label: string;
}) {
  return (
    <>
      <div className="lbl">{label}</div>
      <div className="chips">
        {statusesOf(project.docs.project).map((s) => (
          <button
            type="button"
            key={s.id}
            className="chip"
            onClick={() =>
              project.apply(setStatus(project.docs, pageId, ids, s.id), `${ids.length} screens: ${s.label}`)
            }
          >
            <i className="sq" style={{ background: s.color }} /> {s.label}
          </button>
        ))}
      </div>
      {statusesOf(project.docs.project).some((s) => s.id === approvedStatusId(project.docs.project)) ? null : null}
    </>
  );
}

function GenericPanel({ id, item }: { id: Id; item: Item }) {
  return (
    <>
      <div className="insp-h">
        <b>{id}</b> <span className="tt">{item.kind}</span>
      </div>
      {item.kind === 'portal' && item.target ? (
        <button type="button" className="btn-s" onClick={() => engineRef.ix?.followPortal(item.target!)}>
          Go to {item.target}
        </button>
      ) : null}
      {item.kind === 'text' ? (
        <button type="button" className="btn-s" onClick={() => engineRef.ix?.editText(id)}>
          Edit text
        </button>
      ) : null}
    </>
  );
}

/** Compiler hints about drawing cost are for Claude (`adl validate` lists them), not for the person reviewing. */
const PERF_HINT = /endless animations|backdrop-filter|of its own CSS/;
const forPeople = (message: string) => !PERF_HINT.test(message);

function PagePanel({ project, pageId }: { project: ProjectModel; pageId: string }) {
  const page = project.docs.pages[pageId]!;
  const counts = countStatuses(project.docs.project, page);
  const problems = project.problems.filter((p) => (!p.page || p.page === pageId) && forPeople(p.message));
  const isTruth = project.docs.project.sourceOfTruth === pageId;
  return (
    <>
      <div className="insp-h">
        <b>Page</b> <span className="tt">{page.name}</span>
      </div>
      <div className="hint">
        Select a screen, an arrow or a note to see and change it here: status, banner text, Approve, labels, colours.
      </div>
      <div className="lbl">File</div>
      <div className="file">
        <span className="mono">pages/{pageId}.json</span>
        <button type="button" onClick={() => open(project, `pages/${pageId}.json`)}>
          <ExternalLink size={13} /> Open
        </button>
      </div>
      <div className="lbl">Screens</div>
      <div className="arw">{countsText(counts) || 'No screens yet'}</div>
      {usesBuild(page) ? (
        <>
          <div className="lbl">Build check</div>
          <div className="arw" data-testid="build-progress">
            <div>
              Screens: <b>{progressText(countBuild(page)) || '0 tracked'}</b> · {buildCountsText(countBuild(page))}
            </div>
            {Object.keys(page.flows ?? {}).length ? (
              <div>
                Flows: <b>{progressText(countFlows(page))}</b> · {buildCountsText(countFlows(page))}
              </div>
            ) : null}
          </div>
          <button type="button" className="btn-s" onClick={() => app.set({ compare: 'screens' })}>
            Compare with the real product (C)
          </button>
        </>
      ) : null}
      {pageId !== HISTORY_PAGE ? (
        <button
          type="button"
          className={`btn-s${isTruth ? ' on' : ''}`}
          disabled={isTruth}
          onClick={() =>
            project.apply(
              [{ doc: 'project', path: ['sourceOfTruth'], value: pageId }],
              `${page.name} is the source of truth`,
            )
          }
        >
          {isTruth ? '✓ The source of truth (handoff builds from here)' : 'Make this the source of truth'}
        </button>
      ) : null}
      <div className="lbl">Problems</div>
      {problems.length ? (
        <ul className="warns">
          {problems.slice(0, 30).map((p, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a static list; two problems can share a message
            <li key={i} className={p.level}>
              {p.message}
            </li>
          ))}
        </ul>
      ) : (
        <div className="arw">None</div>
      )}
      <button type="button" className="btn-s" onClick={() => open(project, '.', true)}>
        <FolderOpen size={14} /> Show the project folder
      </button>
      <ActivityList project={project} />
    </>
  );
}

/** Who changed what, newest first. The person's changes Claude has not read yet are marked. */
function ActivityList({ project }: { project: ProjectModel }) {
  const seen = useStore(app, (s) => s.presence.seen?.[project.id]);
  const entries = project.activity.slice(-40).reverse();
  return (
    <>
      <div className="lbl">Activity</div>
      {entries.length ? (
        <ul className="activity" data-testid="activity">
          {entries.map((e) => (
            <li key={`${e.at}-${e.summary}`} className={`by-${e.actor}`}>
              <div className="who">
                <b>{e.actor === 'agent' ? 'Claude' : e.actor === 'human' ? 'You' : e.actor}</b> ·{' '}
                {agoText(Date.parse(e.at))}
                {e.actor === 'human' && (!seen || e.at > seen) ? (
                  <span className="new">Claude sees this next</span>
                ) : null}
              </div>
              <div className="what">{e.summary}</div>
              {e.details?.length && !(e.details.length === 1 && e.details[0] === e.summary) ? (
                <div className="det">{e.details.slice(0, 4).join(' · ')}</div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <div className="arw">Nothing yet</div>
      )}
    </>
  );
}

export { statusInk };

/** The build check for one screen: its state, why it deviates, the captures of the real product. */
function BuildBlock({
  project,
  pageId,
  id,
  item,
}: {
  project: ProjectModel;
  pageId: string;
  id: Id;
  item: ScreenItem;
}) {
  const b = item.build;
  const [note, setNote] = useState(b?.note ?? '');
  useEffect(() => setNote(b?.note ?? ''), [b?.note, id]);
  const page = project.docs.pages[pageId]!;
  const flows = flowsThrough(page, id);
  const apply = (state: BuildState, n: string | undefined) => {
    if (NEEDS_NOTE.has(state) && !(n ?? b?.note)?.trim()) {
      toast({ kind: 'warn', text: `${buildDef(state)!.label} needs a reason: write it below first` });
      return;
    }
    project.apply(setBuild(project.docs, pageId, [id], state, n, 'human'), `${id}: build ${buildDef(state)!.label}`);
  };
  if (!b)
    return (
      <>
        <div className="lbl">Build check</div>
        <button type="button" className="btn-s" onClick={() => apply('todo', undefined)}>
          Track how the real product matches it
        </button>
      </>
    );
  return (
    <>
      <div className="lbl">Build check</div>
      <div className="bed-states" data-testid="build-states">
        {BUILD_STATES.map((s) => (
          <button
            type="button"
            key={s.id}
            className={b.state === s.id ? 'on' : ''}
            style={{ '--c': s.color } as React.CSSProperties}
            onClick={() => apply(s.id, note.trim() !== (b.note ?? '') ? note.trim() : undefined)}
            title={s.hint}
            aria-pressed={b.state === s.id}
          >
            {s.label}
          </button>
        ))}
      </div>
      <textarea
        className="ta"
        rows={2}
        value={note}
        placeholder={NEEDS_NOTE.has(b.state) ? 'Why? (needed)' : 'Why it deviates, what is missing…'}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => note.trim() !== (b.note ?? '') && apply(b.state, note.trim())}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            (e.target as HTMLTextAreaElement).blur();
          }
        }}
        data-testid="build-note"
      />
      {b.captures?.length ? (
        <div className="caps">
          {b.captures.map((c) => (
            <a
              key={`${c.device}-${c.kind}`}
              href={fileUrl(project.id, c.src, c.at)}
              target="_blank"
              rel="noreferrer"
              title={`${c.device} ${c.kind}`}
            >
              {c.kind === 'image' || c.poster || c.thumb ? (
                <img
                  alt=""
                  src={fileUrl(project.id, c.kind === 'image' ? (c.thumb ?? c.src) : (c.poster ?? c.thumb)!, c.at)}
                />
              ) : null}
              <span>
                {c.device} · {c.kind === 'video' ? 'video' : 'still'}
              </span>
            </a>
          ))}
        </div>
      ) : (
        <div className="arw">No captures of the real product yet</div>
      )}
      {flows.length ? <div className="arw">In flows: {flows.join(', ')}</div> : null}
    </>
  );
}
