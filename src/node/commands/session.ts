// What every editing command needs: the workspace service (the running server's, or a temporary one that writes the
// files itself when no server runs), the project and page the command is about, and a way to apply ops.
import fs from 'node:fs';
import path from 'node:path';
import type { Docs, SetOp } from '../../core/ops.ts';
import type { Actor, Id, Item, PageDoc } from '../../core/types.ts';
import { resolveWorkspace } from '../paths.ts';
import { exampleReadOnly, type ProjectState, type TxResult, WorkspaceService } from '../store/workspace.ts';
import type { CommandContext, ParsedArgs } from './registry.ts';

export class CommandError extends Error {}

export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : []);
export const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
};

export interface Session {
  service: WorkspaceService;
  st: ProjectState;
  pid: string;
  readonly docs: Docs;
  /** The page from --page, else the source of truth, else the first page. */
  page: string;
  /** Who runs the command: the CLI is used by agents, the app passes --actor human. */
  actor: Actor;
  /** "Claude" or "You", for activity summaries. */
  who: string;
  apply(ops: SetOp[], summary: string): TxResult;
  close(): Promise<void>;
}

/** A temporary service when no server runs. A lock keeps two CLI processes from writing at the same time. */
async function standalone(
  ctx: CommandContext,
  args: ParsedArgs,
): Promise<{ service: WorkspaceService; release: () => void }> {
  const ws = resolveWorkspace({ workspace: str(args.workspace), cwd: ctx.cwd });
  const lock = path.join(ws.root, '.adl', 'cli.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (let i = 0; ; i++) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch {
      const age = Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? 0);
      if (age > 30_000) fs.rmSync(lock, { force: true });
      else if (i > 100) throw new CommandError(`Another adl command holds ${lock}. Try again.`);
      else await new Promise((r) => setTimeout(r, 50));
    }
  }
  const service = new WorkspaceService(ws);
  service.writeDelay = 0;
  service.minWriteGap = 0;
  try {
    await service.load();
  } catch (e) {
    fs.rmSync(lock, { force: true });
    throw e;
  }
  return { service, release: () => fs.rmSync(lock, { force: true }) };
}

/** The project a command is about: --project, else the project folder we are in, else the only project. The built-in
 *  examples are only used when named with --project. */
export function pickProject(
  service: WorkspaceService,
  args: ParsedArgs,
  cwd: string,
  server?: CommandContext['server'],
): ProjectState {
  const want = str(args.project) ?? process.env.ADL_PROJECT;
  const all = [...service.projects.values()].filter((p) => !p.example);
  if (want) {
    const st = service.projects.get(want) ?? [...service.projects.values()].find((p) => p.docs.project.name === want);
    if (!st) throw new CommandError(`No project "${want}". Projects: ${all.map((p) => p.id).join(', ') || 'none'}`);
    return st;
  }
  const here = all.find((p) => cwd === p.dir || cwd.startsWith(p.dir + path.sep));
  if (here) return here;
  if (all.length === 1) return all[0]!;
  if (!all.length) throw new CommandError('No projects yet. Create one with `adl init <name>`.');
  // the project the person has open in the app (the last view message wins)
  const views = [...(server?.views.values() ?? [])];
  const open = views.length ? service.projects.get(views[views.length - 1]!.pid) : undefined;
  if (open && !open.example) return open;
  throw new CommandError(`Several projects: ${all.map((p) => p.id).join(', ')}. Pass --project <id>.`);
}

export function pickPage(docs: Docs, want: string | undefined): string {
  if (want) {
    if (docs.pages[want]) return want;
    const byName = Object.entries(docs.pages).find(([, p]) => p.name.toLowerCase() === want.toLowerCase());
    if (byName) return byName[0];
    throw new CommandError(`No page "${want}". Pages: ${docs.project.pages.join(', ')}`);
  }
  const p = docs.project.sourceOfTruth ?? docs.project.pages[0];
  if (!p || !docs.pages[p]) throw new CommandError('This project has no pages yet.');
  return p;
}

export async function openSession(args: ParsedArgs, ctx: CommandContext): Promise<Session> {
  let service: WorkspaceService;
  let release = () => {};
  if (ctx.server) service = ctx.server.service;
  else ({ service, release } = await standalone(ctx, args));
  let st: ProjectState;
  let page: string;
  try {
    st = pickProject(service, args, ctx.cwd, ctx.server);
    page = pickPage(st.docs, str(args.page));
  } catch (e) {
    release();
    throw e;
  }
  const actor: Actor = args.actor === 'human' ? 'human' : 'agent';
  return {
    service,
    st,
    pid: st.id,
    get docs() {
      return st.docs;
    },
    page,
    actor,
    who: actor === 'human' ? 'You' : 'Claude',
    apply(ops, summary) {
      const r = service.apply(st.id, ops, { actor, summary });
      if (!r.ok) throw new CommandError(r.error ?? 'The change was refused');
      return r;
    },
    async close() {
      if (!ctx.server) {
        await service.flush();
        service.close();
        release();
      }
    },
  };
}

/** Run `fn` with a session and always close it. */
export async function withSession<T>(
  args: ParsedArgs,
  ctx: CommandContext,
  fn: (s: Session) => Promise<T> | T,
): Promise<T> {
  const s = await openSession(args, ctx);
  try {
    return await fn(s);
  } finally {
    await s.close();
  }
}

/** `withSession` for commands that change the project: a built-in example is refused before anything is written. */
export function withEdit<T>(args: ParsedArgs, ctx: CommandContext, fn: (s: Session) => Promise<T> | T): Promise<T> {
  return withSession(args, ctx, (s) => {
    if (s.st.example) throw new CommandError(exampleReadOnly(s.st));
    return fn(s);
  });
}

/** Find an item: on the given page first, then the source of truth, then any page. */
export function findItem(docs: Docs, id: Id, page?: string): { page: string; item: Item } | undefined {
  const order = [page, docs.project.sourceOfTruth, ...docs.project.pages].filter(
    (p): p is string => !!p && !!docs.pages[p],
  );
  for (const p of order) {
    const item = docs.pages[p]!.items[id];
    if (item && !item.archived) return { page: p, item };
  }
  return undefined;
}

export function requireItem(docs: Docs, id: Id, page?: string): { page: string; item: Item } {
  const f = findItem(docs, id, page);
  if (!f) throw new CommandError(`"${id}" is on no page${page ? ` (looked on "${page}" first)` : ''}`);
  return f;
}

/** Screens on a page. Archived screens only count on the History page, where every screen is archived. */
export function screenCount(page: PageDoc): number {
  const history = page.kind === 'history';
  return Object.values(page.items).filter((i) => i.kind === 'screen' && (history || !i.archived)).length;
}

/** History page: how many screens were replaced, not picked, rejected or removed ("8 replaced · 3 rejected"). */
export function historyText(page: PageDoc): string {
  const n = new Map<string, number>();
  for (const i of Object.values(page.items))
    if (i.kind === 'screen' && i.archived) n.set(i.archived.reason, (n.get(i.archived.reason) ?? 0) + 1);
  return [...n].map(([reason, c]) => `${c} ${reason}`).join(' · ');
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
