// App-wide UI state: route, workspace, the open project, the tool, selection, toasts, agent presence.
import type { Id } from '../../core/types.ts';
import type { AgentPresence, ServerMessage, WorkspaceInfo } from '../../protocol/messages.ts';
import { api, type ConnState, connection } from '../boot/connection.ts';
import type { ProjectModel } from './project.ts';
import { Store } from './store.ts';

export type Tool = 'select' | 'hand' | 'text' | 'section' | 'note' | 'arrow';

export interface Toast {
  id: number;
  kind: 'ok' | 'agent' | 'warn' | 'info';
  text: string;
  code?: string;
  action?: { label: string; run: () => void };
  ms?: number;
}

export interface Route {
  pid?: string | undefined;
  page?: string | undefined;
  focus?: string | undefined;
}

export interface AppState {
  route: Route;
  workspace?: WorkspaceInfo | undefined;
  workspaceError?: string | undefined;
  project?: ProjectModel | undefined;
  projectError?: string | undefined;
  /** bumps when the project's documents change, so React re-reads derived data */
  docsVersion: number;
  tool: Tool;
  selection: Id[];
  /** selected arrow ids */
  arrowSel: Id[];
  toasts: Toast[];
  presence: AgentPresence;
  conn: ConnState;
  /** the server serves a newer build of the app than this tab runs */
  outdated: boolean;
  snap: { done: number; total: number; running: boolean };
  zoom: number;
  panel: boolean;
  menu?: 'page' | 'zoom' | 'project' | 'context' | undefined;
  /** page whose name is being edited in the page menu */
  pageRename?: string | undefined;
  searchOpen: boolean;
  presenting?: { start: Id; trail: Id[] } | undefined;
  /** notes or labels being edited */
  editing?: { kind: 'label' | 'note' | 'text' | 'section' | 'banner' | 'portal'; id: Id } | undefined;
  hint?: string | undefined;
  animations: 'auto' | 'always' | 'never';
}

function routeFromLocation(): Route {
  const m = location.pathname.match(/^\/p\/([^/]+)(?:\/([^/]+))?/);
  const focus =
    location.hash.length > 1 && !location.hash.startsWith('#v=')
      ? decodeURIComponent(location.hash.slice(1))
      : undefined;
  if (!m) return {};
  return {
    pid: decodeURIComponent(m[1]!),
    ...(m[2] ? { page: decodeURIComponent(m[2]) } : {}),
    ...(focus ? { focus } : {}),
  };
}

function loadAnimations(): AppState['animations'] {
  try {
    const v = localStorage.getItem('adl:animations');
    return v === 'always' || v === 'never' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export const app = new Store<AppState>({
  route: routeFromLocation(),
  docsVersion: 0,
  tool: 'select',
  selection: [],
  arrowSel: [],
  toasts: [],
  presence: { state: 'none', at: 0 },
  conn: 'connecting',
  outdated: false,
  snap: { done: 0, total: 0, running: false },
  zoom: 1,
  panel: loadPanel(),
  searchOpen: false,
  animations: loadAnimations(),
});

let toastSeq = 0;
export function toast(t: Omit<Toast, 'id'>) {
  const id = ++toastSeq;
  app.set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
  setTimeout(() => dismiss(id), t.ms ?? (t.action ? 7000 : 4200));
  return id;
}
export function dismiss(id: number) {
  app.set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
}

export function navigate(route: Route, replace = false) {
  const path = route.pid
    ? `/p/${encodeURIComponent(route.pid)}${route.page ? `/${encodeURIComponent(route.page)}` : ''}`
    : '/';
  const url = path + (route.focus ? `#${encodeURIComponent(route.focus)}` : '');
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  app.set({
    route,
    selection: [],
    arrowSel: [],
    menu: undefined,
    searchOpen: false,
    presenting: undefined,
    editing: undefined,
  });
}

window.addEventListener('popstate', () => app.set({ route: routeFromLocation(), selection: [], arrowSel: [] }));

export async function loadWorkspace() {
  try {
    const w = await api<WorkspaceInfo>('/api/workspace');
    app.set({ workspace: w, workspaceError: undefined });
  } catch (e) {
    app.set({ workspaceError: (e as Error).message });
  }
}

/** Copy a project (a built-in example) into the workspace and open the copy. */
export async function copyProject(pid: string) {
  try {
    const r = await api<{ ok: boolean; text: string; data?: { id: string } }>('/api/cmd/copy', {
      method: 'POST',
      body: JSON.stringify({ args: [pid] }),
    });
    if (!r.ok) throw new Error(r.text);
    await loadWorkspace();
    if (r.data?.id) navigate({ pid: r.data.id });
    toast({ kind: 'ok', text: 'Copied: this one is yours to edit' });
  } catch (e) {
    toast({ kind: 'warn', text: (e as Error).message });
  }
}

const OWN_BUILD = /assets\/(index-[\w-]+\.js)/.exec(
  document.querySelector<HTMLScriptElement>('script[src*="/assets/index-"]')?.src ?? '',
)?.[1];

export function initConnection() {
  connection.onState((s) => app.set({ conn: s }));
  connection.on((m: ServerMessage) => {
    const s = app.get();
    s.project?.handle(m);
    if (m.t === 'projects') void loadWorkspace();
    else if (m.t === 'hello') {
      // back after the server was away: catch up on what changed meanwhile (kept changes are re-applied on top)
      if (connection.reconnected) {
        void loadWorkspace();
        void s.project?.reload();
      }
      if (m.build && OWN_BUILD && m.build !== OWN_BUILD) app.set({ outdated: true });
    } else if (m.t === 'agent') app.set({ presence: m.presence });
    else if (m.t === 'snapProgress' && (!s.project || m.pid === s.project.id))
      app.set({ snap: { done: m.done, total: m.total, running: m.running } });
    else if (m.t === 'navigate') {
      window.focus();
      const u = new URL(m.url, location.href);
      if (u.pathname !== location.pathname || u.hash !== location.hash) {
        history.pushState(null, '', u.pathname + u.hash);
        app.set({ route: routeFromLocation() });
      }
    } else if (m.t === 'reload' && s.project && m.pid === s.project.id) void s.project.reload();
    else if (m.t === 'activity' && m.entry.actor === 'agent' && s.project && m.entry.pid === s.project.id) {
      toast({ kind: 'agent', text: m.entry.summary });
      void loadWorkspace();
    }
  });
  connection.connect();
}

function loadPanel(): boolean {
  try {
    return localStorage.getItem('adl:panel') === '1';
  } catch {
    return false;
  }
}

export function setAnimations(v: AppState['animations']) {
  try {
    localStorage.setItem('adl:animations', v);
  } catch {
    // private mode
  }
  app.set({ animations: v });
}
