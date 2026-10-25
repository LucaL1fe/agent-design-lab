// ⌘K: find screens by id, caption, banner text and the words inside them, plus notes, arrow labels and sections, on
// every page. While the palette is open, matching screens stay bright and the rest dim; Enter jumps to a result (the
// canvas moves there and selects it, nothing stays dimmed), Shift+Enter to the next one.
import { Search as SearchIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../boot/connection.ts';
import type { Engine } from '../engine/engine.ts';
import { app, navigate } from '../state/app.ts';
import { searchProject } from '../state/search.ts';
import { useStore } from '../state/store.ts';

// the words inside screens, loaded once per project and screen version
let textCache: { pid: string; key: unknown; text: Record<string, string> } | undefined;

export function SearchPalette({ engine, pageId }: { engine: Engine; pageId: string }) {
  const project = useStore(app, (s) => s.project)!;
  const open = useStore(app, (s) => s.searchOpen);
  useStore(app, (s) => s.docsVersion);
  const [q, setQ] = useState('');
  const [cur, setCur] = useState(0);
  const [text, setText] = useState<Record<string, string>>(
    textCache?.pid === project.id && textCache.key === project.screens ? textCache.text : {},
  );
  const [active, setActive] = useState(false); // after a jump: Shift+Enter goes on to the next result, until Esc
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    input.current?.select();
    if (textCache?.pid === project.id && textCache.key === project.screens) return;
    const key = project.screens;
    api<Record<string, string>>(`/api/p/${encodeURIComponent(project.id)}/text`)
      .then((t) => {
        textCache = { pid: project.id, key, text: t };
        setText(t);
      })
      .catch(() => undefined);
  }, [open, project]);

  const hits = useMemo(() => searchProject(project, text, q), [project, text, q, project.docs]);
  const screenHits = hits.filter((h) => h.kind === 'screen');
  const pages = new Set(hits.map((h) => h.page));

  // while the palette is open: dim what does not match on this page, ring the current result
  useEffect(() => {
    if (!open || !q.trim()) {
      engine.setSearch(undefined);
      return;
    }
    const here = hits.filter((h) => h.page === pageId);
    const current = hits[cur];
    engine.setSearch(
      here.map((h) => h.id),
      current?.page === pageId ? current.id : undefined,
    );
  }, [engine, hits, cur, open, q, pageId]);

  const jump = (i: number) => {
    const h = hits[i];
    if (!h) return;
    setCur(i);
    setActive(true);
    app.set({ searchOpen: false });
    if (h.page !== pageId) navigate({ pid: project.id, page: h.page, focus: h.id });
    else {
      engine.fit([h.id]);
      app.set({ selection: [h.id] });
    }
  };

  // after the palette closed: Shift+Enter goes to the next result, Esc stops that. Registered once: other
  // key handlers can re-render this component during the same event, and a listener removed mid-dispatch never runs.
  const latest = useRef({ open, active, cur, hits, jump });
  latest.current = { open, active, cur, hits, jump };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const l = latest.current;
      if (l.open || !l.active) return;
      if ((e.target as HTMLElement)?.closest?.('input,textarea,[contenteditable="true"]')) return;
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        l.jump((l.cur + 1) % Math.max(1, l.hits.length));
      } else if (e.key === 'Escape') setActive(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  if (!open) return null;
  const close = () => {
    setActive(false);
    app.set({ searchOpen: false });
  };
  return (
    <>
      <div className="scrim" onPointerDown={close} />
      <div className="pal" role="dialog" aria-label="Search" data-testid="search">
        <div className="pal-in">
          <SearchIcon size={18} />
          <input
            ref={input}
            value={q}
            placeholder="Screens, words inside them, notes, arrow labels"
            aria-label="Search"
            onChange={(e) => {
              setQ(e.target.value);
              setCur(0);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') close();
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setCur((c) => Math.min(hits.length - 1, c + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setCur((c) => Math.max(0, c - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                jump(e.shiftKey ? (cur + 1) % Math.max(1, hits.length) : cur);
              }
            }}
          />
          <span className="kbd">esc</span>
        </div>
        {q.trim() ? (
          <div className="pal-sub">
            {hits.length
              ? `${screenHits.length} screen${screenHits.length === 1 ? '' : 's'}${hits.length > screenHits.length ? `, ${hits.length - screenHits.length} more` : ''} on ${pages.size} page${pages.size === 1 ? '' : 's'}`
              : 'Nothing found'}
          </div>
        ) : null}
        <div className="pal-list">
          {hits.slice(0, 80).map((h, i) => (
            <button
              type="button"
              key={`${h.page}/${h.kind}/${h.id}/${h.title}/${h.snippet?.join('') ?? ''}`}
              className={`pr${i === cur ? ' on' : ''}`}
              onMouseEnter={() => setCur(i)}
              onClick={() => jump(i)}
            >
              <b>{h.label}</b>
              {h.title ? <span className="t">{h.title}</span> : null}
              {h.snippet ? (
                <em>
                  “{h.snippet[0]}
                  <mark>{h.snippet[1]}</mark>
                  {h.snippet[2]}”
                </em>
              ) : null}
              <span className="pg">{project.docs.pages[h.page]?.name ?? h.page}</span>
            </button>
          ))}
        </div>
        <div className="pal-sub foot">Enter jumps there · Shift+Enter the next one</div>
      </div>
    </>
  );
}
