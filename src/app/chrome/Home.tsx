import { Copy, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ProjectSummary } from '../../protocol/messages.ts';
import { api } from '../boot/connection.ts';
import { app, loadWorkspace, navigate, toast } from '../state/app.ts';
import { useStore } from '../state/store.ts';

const EXAMPLE = 'Design an onboarding flow for a meditation app';

function ago(iso?: string): string {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 172800) return 'yesterday';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function copy(text: string) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast({ kind: 'ok', text: 'Copied' }))
    .catch(() => toast({ kind: 'warn', text: 'Copy failed: select the text instead' }));
}

function Thumb({ p }: { p: ProjectSummary }) {
  // the first screens of the source-of-truth page, as small still pictures
  const [snaps, setSnaps] = useState<string[]>([]);
  useEffect(() => {
    let off = false;
    api<{ snaps: Record<string, { url: string }>; screens: Record<string, { hash: string }> }>(
      `/api/p/${encodeURIComponent(p.id)}/state`,
    )
      .then((s) => {
        const out: string[] = [];
        for (const id of p.thumbs) {
          const h = s.screens[id]?.hash;
          const k = h ? Object.keys(s.snaps).find((key) => key.startsWith(`${h}@`)) : undefined;
          if (k) out.push(s.snaps[k]!.url);
          if (out.length >= 6) break;
        }
        if (!off) setSnaps(out);
      })
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, [p.id, p.thumbs]);
  return (
    <div className="thumb">
      {snaps.map((u, i) => (
        <img
          key={u}
          alt=""
          src={`${u}-128.webp`}
          style={{ left: 18 + i * 40, top: 22 + (i % 2) * 14, width: 62, height: 134 }}
        />
      ))}
    </div>
  );
}

function NewProject({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const create = async () => {
    const n = name.trim();
    if (!n) return;
    try {
      const r = await api<{ ok: boolean; text: string; data?: { id: string } }>('/api/cmd/init', {
        method: 'POST',
        body: JSON.stringify({ args: [n] }),
      });
      if (!r.ok) throw new Error(r.text);
      await loadWorkspace();
      onDone();
      if (r.data?.id) navigate({ pid: r.data.id });
    } catch (e) {
      toast({ kind: 'warn', text: (e as Error).message });
    }
  };
  return (
    <div className="card new" data-testid="new-project-form">
      <div style={{ color: 'var(--text)', fontWeight: 600 }}>New project</div>
      <input
        autoFocus
        value={name}
        placeholder="Project name"
        aria-label="Project name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void create();
          if (e.key === 'Escape') onDone();
        }}
        style={{
          width: '100%',
          background: 'var(--canvas)',
          border: '1px solid var(--line-2)',
          borderRadius: 8,
          padding: '8px 10px',
          outline: 'none',
          color: 'var(--text)',
        }}
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn sm" onClick={onDone}>
          Cancel
        </button>
        <button type="button" className="btn sm primary" onClick={() => void create()}>
          Create
        </button>
      </div>
    </div>
  );
}

function ProjectCard({ p }: { p: ProjectSummary }) {
  const screens = p.pages.reduce((a, x) => a + x.screens, 0);
  return (
    <button type="button" className="card" onClick={() => navigate({ pid: p.id })} data-testid={`project-${p.id}`}>
      <Thumb p={p} />
      <div className="ct">
        {p.name}
        {p.example ? <span className="exbadge">Example</span> : null}
      </div>
      <div className="cm">
        {p.pages.length} page{p.pages.length === 1 ? '' : 's'} · {screens} screens
      </div>
      <div className="cm2">
        {p.example ? (
          'Look around, then make a copy to edit it'
        ) : (
          <>
            <i className={p.lastActivity?.actor === 'agent' ? 'agent-dot' : ''} />
            {p.lastActivity
              ? `${p.lastActivity.actor === 'agent' ? 'Claude' : 'You'} · ${ago(p.lastActivity.at)}`
              : 'No changes yet'}
          </>
        )}
      </div>
    </button>
  );
}

export function Home() {
  const ws = useStore(app, (s) => s.workspace);
  const err = useStore(app, (s) => s.workspaceError);
  const [creating, setCreating] = useState(false);
  if (err)
    return (
      <div className="home">
        <div className="empty">
          <div className="big">The server is not answering</div>
          <div>{err}</div>
        </div>
      </div>
    );
  if (!ws) return <div className="home" />;
  const own = ws.projects.filter((p) => !p.example);
  const examples = ws.projects.filter((p) => p.example);
  return (
    <div className="home">
      <div className="home-h">
        <div>
          <div className="h1">Projects</div>
          <div className="path">{ws.root}</div>
        </div>
      </div>
      {own.length === 0 ? (
        <div className="empty" data-testid="empty-home">
          <div className="big">Nothing designed here yet</div>
          <div style={{ color: 'var(--muted)', fontSize: 15 }}>Open Claude Code in this folder and say:</div>
          <div className="say">
            <span className="q">“{EXAMPLE}”</span>
            <button type="button" className="btn sm" onClick={() => copy(EXAMPLE)}>
              <Copy size={14} /> Copy
            </button>
          </div>
          <div style={{ color: 'var(--muted)' }}>
            Claude builds the screens here as HTML and links them with arrows. They show up on this page as soon as
            Claude saves them.
          </div>
          {creating ? (
            <NewProject onDone={() => setCreating(false)} />
          ) : (
            <div style={{ color: 'var(--faint)', fontSize: 13 }}>
              Or{' '}
              <button type="button" className="linkbtn" onClick={() => setCreating(true)} data-testid="new-project">
                start an empty project
              </button>{' '}
              (<code>{ws.cli} init my-app</code>)
            </div>
          )}
          {examples.length ? (
            <>
              <div style={{ color: 'var(--muted)', marginTop: 12 }}>Or look around an example first:</div>
              <div className="cards" style={{ width: '100%' }}>
                {examples.map((p) => (
                  <ProjectCard key={p.id} p={p} />
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : (
        <div className="cards">
          {own.map((p) => (
            <ProjectCard key={p.id} p={p} />
          ))}
          {creating ? (
            <NewProject onDone={() => setCreating(false)} />
          ) : (
            <button type="button" className="card new" onClick={() => setCreating(true)}>
              <span className="plus">
                <Plus size={20} />
              </span>
              <span style={{ fontSize: 16, color: 'var(--text)', fontWeight: 600 }}>New project</span>
              <span style={{ fontSize: 13 }}>Ask Claude, or run</span>
              <code>{ws.cli} init my-app</code>
            </button>
          )}
          {examples.map((p) => (
            <ProjectCard key={p.id} p={p} />
          ))}
        </div>
      )}
    </div>
  );
}
