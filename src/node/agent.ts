// The agent's side of the loop: the "seen" marker (which changes by the person the agent has been told about) and
// presence (what the agent is doing, shown in the app's pill).
import fs from 'node:fs';
import path from 'node:path';
import type { RunningServer } from './server/server.ts';
import type { ProjectState } from './store/workspace.ts';

const seenFile = (st: ProjectState) => path.join(st.adl, 'agent-seen.json');

interface SeenFile {
  /** The newest marker of any agent (the app's pill counts from here). */
  at?: string;
  /** Per agent session: up to where that agent has been told about the person's changes. */
  sessions?: Record<string, string>;
}

function readFile(st: ProjectState): SeenFile {
  try {
    return JSON.parse(fs.readFileSync(seenFile(st), 'utf8')) as SeenFile;
  } catch {
    return {};
  }
}

/** Up to where `session` (or, without one, any agent) has seen the person's changes. A session that never looked
 *  starts from the newest marker of any agent, so it is not flooded with old history. */
export function readSeen(st: ProjectState, session?: string): string | undefined {
  const f = readFile(st);
  return (session && f.sessions?.[session]) || f.at;
}

/** A new agent session starts from the newest marker of any agent at that moment (called when it starts), so another
 *  agent looking later cannot make it miss the person's changes. */
export function startSeen(st: ProjectState, session: string) {
  const f = readFile(st);
  if (f.sessions?.[session] || !f.at) return;
  fs.mkdirSync(path.dirname(seenFile(st)), { recursive: true });
  fs.writeFileSync(seenFile(st), `${JSON.stringify({ at: f.at, sessions: { ...f.sessions, [session]: f.at } })}\n`);
}

/** Everything in the activity log so far has been shown to this agent (the marker is the newest entry's time). */
export function markSeen(
  st: ProjectState,
  server: RunningServer | undefined,
  session?: string,
  at = st.activity[st.activity.length - 1]?.at ?? new Date(0).toISOString(),
) {
  const f = readFile(st);
  const sessions = { ...f.sessions };
  if (session) sessions[session] = at;
  // keep the 50 most recent sessions
  const keep = Object.entries(sessions)
    .sort((a, b) => (a[1] < b[1] ? 1 : -1))
    .slice(0, 50);
  const latest = !f.at || at > f.at ? at : f.at;
  fs.mkdirSync(path.dirname(seenFile(st)), { recursive: true });
  fs.writeFileSync(seenFile(st), `${JSON.stringify({ at: latest, sessions: Object.fromEntries(keep) })}\n`);
  if (server) {
    server.presence.seen = { ...server.presence.seen, [st.id]: latest };
    server.broadcast({ t: 'agent', presence: { ...server.presence } });
  }
}
