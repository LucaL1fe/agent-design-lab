import { ChevronDown, Home as HomeIcon, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { app, copyProject, navigate } from '../state/app.ts';
import { useStore } from '../state/store.ts';

export function agoText(at: number): string {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

export function AgentPill() {
  const p = useStore(app, (s) => s.presence);
  const project = useStore(app, (s) => s.project);
  useStore(app, (s) => s.docsVersion);
  // changes the person made that Claude will be told about on its next turn
  const seen = project ? p.seen?.[project.id] : undefined;
  const unseen = project ? project.activity.filter((e) => e.actor === 'human' && (!seen || e.at > seen)).length : 0;
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 5000);
    return () => clearInterval(t);
  }, []);
  // several agents can work at once: the newest one speaks for the pill, the tooltip lists them all
  const now = Date.now();
  const live = (p.agents ?? []).filter((a) => a.state !== 'none' && now - a.at < 10 * 60_000);
  const cur = live[0] ?? p;
  const who = live.length > 1 ? `${live.length} agents` : 'Claude';
  const fresh = now - cur.at < 90_000;
  const active = (cur.state === 'writing' || cur.state === 'running') && now - cur.at < 20_000;
  let text = 'Claude · not connected';
  let cls = 'agent';
  if (active) {
    text = `${who} · ${cur.text ?? (cur.state === 'writing' ? 'writing' : 'working')}`;
    cls = 'agent on';
  } else if (cur.state !== 'none' && (fresh || cur.state === 'connected' || cur.state === 'idle')) {
    text =
      unseen > 0
        ? `${who} · ${live.length > 1 ? 'see' : 'sees'} ${unseen} change${unseen === 1 ? '' : 's'}`
        : cur.text && now - cur.at < 30_000
          ? `${who} · ${cur.text}`
          : `${who} · connected`;
    cls = 'agent connected';
  }
  const title =
    cur.state === 'none'
      ? 'Open Claude Code in this folder: it connects through the skill'
      : live.length > 1
        ? live.map((a, i) => `${a.name || `Claude ${i + 1}`} · ${a.text ?? a.state} · ${agoText(a.at)}`).join('\n')
        : `Last seen ${agoText(cur.at)}`;
  return (
    <span className={cls} title={title} data-testid="agent-pill">
      <i />
      {text}
    </span>
  );
}

export function TopBar() {
  const project = useStore(app, (s) => s.project);
  const pid = useStore(app, (s) => s.route.pid);
  const conn = useStore(app, (s) => s.conn);
  const outdated = useStore(app, (s) => s.outdated);
  const menu = useStore(app, (s) => s.menu);
  const workspace = useStore(app, (s) => s.workspace);
  useStore(app, (s) => s.docsVersion);
  return (
    <header className="topbar">
      <button
        type="button"
        className="homebtn"
        title="All projects"
        aria-label="All projects"
        onClick={() => navigate({})}
      >
        <HomeIcon size={18} strokeWidth={1.8} />
      </button>
      {pid ? (
        <button
          type="button"
          className="crumb"
          onClick={() => app.set({ menu: menu === 'project' ? undefined : 'project' })}
          aria-haspopup="menu"
        >
          {project?.docs.project.name ?? pid} <ChevronDown />
        </button>
      ) : (
        <span className="crumb" style={{ cursor: 'default' }}>
          Agent Design Lab
        </span>
      )}
      {pid && project?.example ? (
        <>
          <span
            className="exbadge"
            data-testid="example-badge"
            title="A built-in example: look around as much as you like; changes need your own copy"
          >
            Example · view only
          </span>
          <button
            type="button"
            className="btn sm primary"
            data-testid="copy-example"
            onClick={() => void copyProject(project.id)}
          >
            Make a copy
          </button>
        </>
      ) : null}
      {menu === 'project' && workspace ? (
        <div className="menu" style={{ left: 50, top: 40 }} role="menu">
          <div className="lbl">Projects</div>
          {workspace.projects.map((p) => (
            <button type="button" key={p.id} className="mi" role="menuitem" onClick={() => navigate({ pid: p.id })}>
              <span className="chk">{p.id === pid ? '✓' : ''}</span>
              {p.name}
              <span className="r">{p.screens}</span>
            </button>
          ))}
          <hr />
          <button type="button" className="mi muted" onClick={() => navigate({})}>
            <span className="chk" />
            All projects
          </button>
        </div>
      ) : null}
      <span className="sp" />
      {conn !== 'open' ? (
        <span className="conn">
          {conn === 'connecting' ? 'Connecting…' : 'Reconnecting… changes wait until the server is back'}
        </span>
      ) : outdated ? (
        <button
          type="button"
          className="conn upd"
          onClick={() => location.reload()}
          title="Agent Design Lab was updated while this tab was open"
        >
          New version · Reload
        </button>
      ) : null}
      <AgentPill />
      {pid ? (
        <button
          type="button"
          className="searchbtn"
          onClick={() => app.set({ searchOpen: true })}
          title="Search screens, notes and arrows"
        >
          <Search size={15} />
          <span className="kbd">⌘K</span>
        </button>
      ) : null}
    </header>
  );
}
