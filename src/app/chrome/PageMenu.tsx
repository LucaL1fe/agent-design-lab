import { MoreHorizontal, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { addPage, deletePage, duplicatePage, HISTORY_PAGE, renamePage, reorderPages } from '../../core/actions.ts';
import { pageKey } from '../../core/ops.ts';
import { app, navigate, toast } from '../state/app.ts';
import { useStore } from '../state/store.ts';

export function PageMenu({ pageId }: { pageId: string }) {
  const project = useStore(app, (s) => s.project)!;
  useStore(app, (s) => s.docsVersion);
  // in app state, not component state: creating a page navigates, which may remount this menu
  const renaming = useStore(app, (s) => s.pageRename);
  const setRenaming = (pid: string | undefined) => app.set({ pageRename: pid });
  useEffect(() => () => app.set({ pageRename: undefined }), []);
  const [more, setMore] = useState<string>();
  const [showUnplaced, setShowUnplaced] = useState(false);
  const docs = project.docs;
  const pages = docs.project.pages.filter((p) => docs.pages[p] && p !== HISTORY_PAGE);
  const count = (pid: string) =>
    Object.values(docs.pages[pid]?.items ?? {}).filter((i) => i.kind === 'screen' && !i.archived).length;
  const go = (pid: string) => navigate({ pid: project.id, page: pid });
  const newPage = () => {
    const r = addPage(docs, 'New page', undefined, pageId);
    project.apply(r.ops, 'Added a page');
    go(r.id);
    app.set({ menu: 'page', pageRename: r.id });
  };
  const rename = (pid: string, name: string) => {
    const v = name.trim();
    setRenaming(undefined);
    if (v && v !== docs.pages[pid]?.name) project.apply(renamePage(docs, pid, v), `Renamed a page to “${v}”`);
  };
  const move = (pid: string, d: -1 | 1) => {
    // History is not in the list, so it keeps its place at the end
    const order = [...pages];
    const i = order.indexOf(pid);
    const j = i + d;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    const rest = docs.project.pages.filter((x) => !order.includes(x));
    project.apply(reorderPages(docs, [...order, ...rest]), 'Reordered pages');
  };
  const remove = (pid: string) => {
    const name = docs.pages[pid]?.name ?? pid;
    if (!project.apply(deletePage(docs, pid), `Deleted the page “${name}”`).length) return;
    if (pid === pageId) go(docs.project.pages.find((p) => p !== pid && p !== HISTORY_PAGE) ?? '');
    toast({
      kind: 'info',
      text: `Page “${name}” deleted. A copy is in .adl/trash`,
      action: { label: 'Undo', run: () => project.undo() },
    });
  };
  // screens that have an HTML file but are on no page
  const placed = new Set<string>();
  for (const p of Object.values(docs.pages))
    for (const [id, it] of Object.entries(p.items)) if (it.kind === 'screen') placed.add(it.screen ?? id);
  const unplaced = Object.keys(project.screens)
    .filter((id) => !placed.has(id))
    .sort();
  const place = (sid: string) => {
    const page = docs.pages[pageId];
    if (!page) return;
    const id = page.items[sid] ? `${sid}~${Object.keys(page.items).length}` : sid;
    project.apply(
      [
        {
          doc: pageKey(pageId),
          path: ['items', id],
          value: id === sid ? { kind: 'screen' } : { kind: 'screen', screen: sid },
        },
      ],
      `Placed ${sid}`,
    );
    app.set({ selection: [id], menu: undefined });
  };
  return (
    <div
      className="menu"
      style={{ left: 12, top: 58, width: 290 }}
      role="menu"
      onPointerDown={(e) => e.stopPropagation()}
      data-testid="page-menu"
    >
      {pages.map((p) => (
        <div key={p} className="mi-row">
          {renaming === p ? (
            <input
              className="rename"
              autoFocus
              defaultValue={docs.pages[p]!.name}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') rename(p, (e.target as HTMLInputElement).value);
                if (e.key === 'Escape') setRenaming(undefined);
              }}
              onBlur={(e) => rename(p, e.target.value)}
              aria-label="Page name"
            />
          ) : (
            <button
              type="button"
              className="mi"
              role="menuitemradio"
              aria-checked={p === pageId}
              onClick={() => go(p)}
              onDoubleClick={() => setRenaming(p)}
            >
              <span className="chk">{p === pageId ? '✓' : ''}</span>
              <span className="nm">{docs.pages[p]!.name}</span>
              {docs.project.sourceOfTruth === p ? (
                <span className="truth" title="The source of truth: handoff builds from this page">
                  truth
                </span>
              ) : null}
              <span className="r">{count(p)}</span>
            </button>
          )}
          <button
            type="button"
            className="more"
            aria-label={`More for ${docs.pages[p]!.name}`}
            onClick={() => setMore(more === p ? undefined : p)}
          >
            <MoreHorizontal size={15} />
          </button>
          {more === p ? (
            <div className="menu sub" onClick={() => setMore(undefined)}>
              <button type="button" className="mi" onClick={() => setRenaming(p)}>
                Rename
              </button>
              <button
                type="button"
                className="mi"
                onClick={() => {
                  const r = duplicatePage(docs, p);
                  project.apply(r.ops, 'Duplicated a page');
                  go(r.id);
                }}
              >
                Duplicate
              </button>
              {pages.indexOf(p) > 0 ? (
                <button type="button" className="mi" onClick={() => move(p, -1)}>
                  Move up
                </button>
              ) : null}
              {pages.indexOf(p) < pages.length - 1 ? (
                <button type="button" className="mi" onClick={() => move(p, 1)}>
                  Move down
                </button>
              ) : null}
              {docs.project.sourceOfTruth !== p ? (
                <button
                  type="button"
                  className="mi"
                  onClick={() =>
                    project.apply(
                      [{ doc: 'project', path: ['sourceOfTruth'], value: p }],
                      'Changed the source of truth',
                    )
                  }
                >
                  Make it the source of truth
                </button>
              ) : null}
              {pages.length > 1 ? (
                <button type="button" className="mi danger" onClick={() => remove(p)}>
                  Delete page
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ))}
      {docs.pages[HISTORY_PAGE] ? (
        <button type="button" className="mi muted" onClick={() => go(HISTORY_PAGE)}>
          <span className="chk">{pageId === HISTORY_PAGE ? '✓' : ''}</span>
          History
          <span className="r">{count(HISTORY_PAGE)}</span>
        </button>
      ) : null}
      <hr />
      <button type="button" className="mi muted" onClick={newPage} data-testid="new-page">
        <span className="chk">
          <Plus size={14} />
        </span>
        New page
      </button>
      {unplaced.length ? (
        <>
          <button type="button" className="mi muted" onClick={() => setShowUnplaced(!showUnplaced)}>
            <span className="chk" />
            Screens not on any page
            <span className="r">{unplaced.length}</span>
          </button>
          {showUnplaced ? (
            <div className="unplaced">
              {unplaced.slice(0, 60).map((id) => (
                <button
                  type="button"
                  key={id}
                  className="mi"
                  onClick={() => place(id)}
                  title={`Place ${id} on this page`}
                >
                  <span className="chk" />
                  <span className="mono">{id}</span>
                  <span className="r">{project.screens[id]?.title ?? ''}</span>
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
