// Local HTTP + WebSocket server. Binds to 127.0.0.1 only, checks Host/Origin against DNS rebinding and requires a
// per-server token for anything that changes files.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { type WebSocket, WebSocketServer } from 'ws';
import type {
  AgentPresence,
  AgentSession,
  ClientMessage,
  ProjectState as ProjectStateMsg,
  ServerMessage,
  WorkspaceInfo,
} from '../../protocol/messages.ts';
import { readSeen } from '../agent.ts';
import { type CommandContext, runCommandHttp } from '../commands/registry.ts';
// every command, so /api/cmd/* works for any embedder of startServer (not only the CLI)
import '../commands/index.ts';
import { commandForm } from '../commands/setup.ts';
import { mimeOf, safeJoin } from '../fsutil.ts';
import { type ResolvedWorkspace, resolveWorkspace } from '../paths.ts';
import type { SnapshotService } from '../snapshot/service.ts';
import { WorkspaceService } from '../store/workspace.ts';
import { packageRoot, readVersion } from '../version.ts';

export interface ServerOptions {
  workspace?: string;
  /** An already resolved workspace (wins over `workspace`). */
  ws?: ResolvedWorkspace;
  port?: number;
  dev?: boolean;
  /** Called with the service right after loading (snapshots, importer hooks). */
  onReady?: (s: RunningServer) => void | Promise<void>;
  quiet?: boolean;
  snapshots?: boolean;
  /** A short-lived helper server (CLI renders): not listed in ~/.adl/servers.json, no file watching. */
  ephemeral?: boolean;
  /** List the built-in examples in this workspace (default: yes, except for ephemeral servers). */
  examples?: boolean;
}

export interface RunningServer {
  url: string;
  port: number;
  token: string;
  ws: ResolvedWorkspace;
  service: WorkspaceService;
  snapshots?: SnapshotService;
  presence: AgentPresence;
  broadcast: (m: ServerMessage) => void;
  views: Map<string, Extract<ClientMessage, { t: 'view' }>>;
  close: () => Promise<void>;
}

const REGISTRY = path.join(os.homedir(), '.adl', 'servers.json');

interface RegistryEntry {
  pid: number;
  port: number;
  workspace: string;
  token: string;
  version: string;
  startedAt: string;
}

export function readRegistry(): RegistryEntry[] {
  try {
    const list = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) as RegistryEntry[];
    return list.filter((e) => {
      try {
        process.kill(e.pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function writeRegistry(list: RegistryEntry[]) {
  try {
    fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
    fs.writeFileSync(REGISTRY, JSON.stringify(list, null, 2), { mode: 0o600 });
  } catch {
    // registry is a convenience
  }
}

export function findServer(workspaceRoot: string): RegistryEntry | undefined {
  return readRegistry().find((e) => e.workspace === workspaceRoot);
}

async function listen(server: http.Server, port: number): Promise<number> {
  for (let p = port; p < port + 40; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      const onErr = () => {
        server.off('listening', onOk);
        resolve(false);
      };
      const onOk = () => {
        server.off('error', onErr);
        resolve(true);
      };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(p, '127.0.0.1');
    });
    if (ok) return (server.address() as import('node:net').AddressInfo).port;
  }
  throw new Error(`No free port between ${port} and ${port + 39}`);
}

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const ws = opts.ws ?? resolveWorkspace({ workspace: opts.workspace });
  fs.mkdirSync(ws.root, { recursive: true });
  const token = randomBytes(18).toString('base64url');
  const version = readVersion();
  const service = new WorkspaceService(ws, { examples: opts.examples ?? !opts.ephemeral });
  await service.load();
  if (!opts.ephemeral) service.watch();

  const sockets = new Set<WebSocket>();
  const views = new Map<string, Extract<ClientMessage, { t: 'view' }>>();
  const presence: AgentPresence = { state: 'none', at: Date.now(), seen: {}, agents: [] };
  const agentSessions = new Map<string, AgentSession>();
  for (const st of service.projects.values()) {
    const at = readSeen(st);
    if (at) presence.seen![st.id] = at;
  }
  const broadcast = (m: ServerMessage) => {
    const data = JSON.stringify(m);
    for (const s of sockets) if (s.readyState === 1) s.send(data);
  };
  service.on('tx', (e) => broadcast({ t: 'tx', ...e }));
  service.on('screens', (e) => broadcast({ t: 'screens', ...e }));
  service.on('problems', (e) => broadcast({ t: 'problems', ...e }));
  service.on('activity', (entry) => broadcast({ t: 'activity', entry }));
  service.on('projects', () => broadcast({ t: 'projects' }));
  service.on('reload', (e) => broadcast({ t: 'reload', pid: e.pid }));
  service.on('error', (e) => {
    if (!opts.quiet) console.error('[adl]', e);
  });

  let vite: import('vite').ViteDevServer | undefined;
  const appDir = path.join(packageRoot(), 'dist', 'app');
  const srcAppDir = path.join(packageRoot(), 'src', 'app');
  let port = 0;
  const running = {} as RunningServer;

  const allowedHost = (h: string | undefined) =>
    !!h && (h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!allowedHost(req.headers.host)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('Agent Design Lab only answers on localhost');
        return;
      }
      const origin = req.headers.origin;
      if (origin && !allowedHost(origin.replace(/^https?:\/\//, ''))) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (opts.dev && vite) {
        if (url.pathname === '/' || url.pathname.startsWith('/p/') || url.pathname === '/snap')
          return await sendIndex(res, url, url.pathname === '/snap' ? 'snap.html' : 'index.html');
        vite.middlewares(req, res, () => {
          res.writeHead(404);
          res.end();
        });
        return;
      }
      // production: static app
      if (url.pathname === '/snap') return await sendIndex(res, url, 'snap.html');
      const file = url.pathname !== '/' ? safeJoin(appDir, url.pathname.slice(1)) : undefined;
      if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, {
          'content-type': mimeOf(file),
          'cache-control': url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        });
        fs.createReadStream(file).pipe(res);
        return;
      }
      return await sendIndex(res, url, 'index.html');
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String((e as Error).stack ?? e));
    }
  });

  async function sendIndex(res: http.ServerResponse, url: URL, name: string) {
    let html: string;
    if (opts.dev && vite) {
      html = fs.readFileSync(path.join(srcAppDir, name), 'utf8');
      html = await vite.transformIndexHtml(url.pathname, html);
    } else {
      const f = path.join(appDir, name);
      if (!fs.existsSync(f)) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('The app is not built yet. Run `npm run build` in the agent-design-lab folder.');
        return;
      }
      html = fs.readFileSync(f, 'utf8');
    }
    const boot = JSON.stringify({ token, version, workspace: ws.root }).replace(/</g, '\\u003c');
    html = html.replace('</head>', `<script id="adl-boot" type="application/json">${boot}</script></head>`);
    const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' };
    if (!opts.dev)
      headers['content-security-policy'] =
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https:; font-src 'self' data: https:; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
    res.writeHead(200, headers);
    res.end(html);
  }

  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: http.IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      let s = '';
      req.on('data', (c) => {
        s += c;
        if (s.length > 20_000_000) reject(new Error('Request too large'));
      });
      req.on('end', () => resolve(s));
      req.on('error', reject);
    });
  const authed = (req: http.IncomingMessage) =>
    req.headers['x-adl-token'] === token || req.headers.authorization === `Bearer ${token}`;

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); // ['api', ...]
    const method = req.method ?? 'GET';
    if (parts[1] === 'health') return json(res, 200, { ok: true, version, workspace: ws.root, pid: process.pid });
    if (method !== 'GET' && method !== 'HEAD' && !authed(req))
      return json(res, 401, { error: 'missing or wrong token' });
    if (parts[1] === 'workspace' && method === 'GET') return json(res, 200, workspaceInfo());
    if (parts[1] === 'reload' && method === 'POST') {
      await service.load();
      return json(res, 200, { ok: true });
    }
    if (parts[1] === 'cmd' && parts[2] && method === 'POST') {
      const body = await readBody(req);
      const ctx: CommandContext = { server: running, cwd: ws.root };
      await service.settle();
      const r = await runCommandHttp(parts[2], body, ctx);
      return json(res, r.status, r.body);
    }
    if (parts[1] === 'agent' && method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as Partial<AgentPresence> & {
        path?: string;
        name?: string;
      };
      delete body.seen; // only `adl context` moves the marker
      if (body.path && body.session) service.noteWriter(body.path, body.session);
      delete body.path;
      const now = Date.now();
      // one entry per agent session, so several agents working at once all show
      const sid = body.session ?? 'agent';
      const prev = agentSessions.get(sid);
      // re-inserted on every update, so the map's order is the order of the last updates
      agentSessions.delete(sid);
      if (body.state !== 'none')
        agentSessions.set(sid, {
          ...prev,
          session: sid,
          ...(body.name ? { name: String(body.name) } : {}),
          state: body.state ?? prev?.state ?? 'connected',
          ...(body.text ? { text: body.text } : {}),
          at: now,
        });
      for (const [k, a] of agentSessions) if (now - a.at > 30 * 60_000) agentSessions.delete(k);
      delete (body as { name?: string }).name;
      Object.assign(presence, body, { at: now });
      // newest first; two updates in the same millisecond put the later one first (it came out oldest first)
      presence.agents = [...agentSessions.values()].reverse().sort((a, b) => b.at - a.at);
      broadcast({ t: 'agent', presence: { ...presence } });
      return json(res, 200, { ok: true });
    }
    if (parts[1] === 'p' && parts[2]) {
      const st = service.projects.get(parts[2]);
      if (!st) return json(res, 404, { error: `No project "${parts[2]}"` });
      const what = parts[3];
      if (what === 'state' && method === 'GET') {
        const body: ProjectStateMsg = {
          id: st.id,
          dir: st.dir,
          project: st.docs.project,
          pages: st.docs.pages,
          screens: service.screensMeta(st) as ProjectStateMsg['screens'],
          problems: st.problems,
          activity: st.activity.slice(-80),
          ...(st.example ? { example: true } : {}),
          snaps: running.snapshots?.snapsFor(st.id) ?? {},
        };
        return json(res, 200, body);
      }
      if (what === 'text' && method === 'GET') {
        // the words inside every screen, for ⌘K (loaded when the search opens, not with the project)
        const out: Record<string, string> = {};
        for (const e of st.screens.values()) if (e.compiled?.text) out[e.id] = e.compiled.text.slice(0, 6000);
        return json(res, 200, out);
      }
      if (what === 'c' && parts[4] && method === 'GET') {
        // the current version, or one that was just replaced (a tab may still be loading it)
        const c =
          [...st.screens.values()].find((s) => s.compiled?.hash === parts[4])?.compiled ?? st.recent.get(parts[4]);
        if (!c) return json(res, 404, { error: 'unknown screen version' });
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=31536000, immutable',
        });
        res.end(JSON.stringify(c));
        return;
      }
      if (what === 's' && parts[4] && method === 'GET') {
        const sh = st.sheets.get(parts[4]);
        if (!sh) return json(res, 404, { error: 'unknown stylesheet' });
        res.writeHead(200, {
          'content-type': 'text/css; charset=utf-8',
          'cache-control': 'public, max-age=31536000, immutable',
        });
        res.end(sh.css);
        return;
      }
      if (what === 'f' && method === 'GET') {
        const rel = parts.slice(4).join('/');
        if (rel.split('/').some((seg) => seg.startsWith('.'))) return json(res, 404, { error: 'not found' });
        const file = safeJoin(st.dir, rel);
        if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'not found' });
        res.writeHead(200, {
          'content-type': mimeOf(file),
          'cache-control': url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'no-cache',
        });
        fs.createReadStream(file).pipe(res);
        return;
      }
      if (what === 'snap' && parts[4] && method === 'GET') {
        const file = safeJoin(path.join(st.adl, 'cache', 'snap'), parts.slice(4).join('/'));
        if (!file || !fs.existsSync(file)) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': mimeOf(file), 'cache-control': 'public, max-age=31536000, immutable' });
        fs.createReadStream(file).pipe(res);
        return;
      }
      if (what === 'tx' && method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { ops: never[]; actor?: 'human' | 'agent'; summary?: string };
        const r = service.apply(st.id, body.ops, {
          actor: body.actor ?? 'agent',
          ...(body.summary ? { summary: body.summary } : {}),
        });
        return json(res, r.ok ? 200 : 400, r);
      }
      if (what === 'open' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as { file?: string; reveal?: boolean };
        const file = body.file ? safeJoin(st.dir, body.file) : st.dir;
        if (!file) return json(res, 400, { error: 'bad path' });
        await openInEditor(file, body.reveal === true);
        return json(res, 200, { ok: true });
      }
    }
    return json(res, 404, { error: 'not found' });
  }

  function workspaceInfo(): WorkspaceInfo {
    return {
      root: ws.root,
      version,
      setUp: !!ws.configFile,
      chrome: running.snapshots?.available ?? false,
      cli: commandForm(ws.configFile ? path.dirname(ws.configFile) : ws.root),
      // the built-in examples come last, after the person's own projects
      projects: [...service.projects.values()]
        .sort((a, b) => Number(!!a.example) - Number(!!b.example))
        .map((st) => {
          const pages = st.docs.project.pages.map((pid) => {
            const p = st.docs.pages[pid];
            const screens = p ? Object.values(p.items).filter((i) => i.kind === 'screen' && !i.archived).length : 0;
            return { id: pid, name: p?.name ?? pid, screens, ...(p?.kind ? { kind: p.kind } : {}) };
          });
          const truth = st.docs.project.sourceOfTruth ?? st.docs.project.pages[0];
          const thumbs =
            truth && st.docs.pages[truth]
              ? Object.entries(st.docs.pages[truth]!.items)
                  .filter(([, i]) => i.kind === 'screen')
                  .slice(0, 12)
                  .map(([id]) => id)
              : [];
          return {
            id: st.id,
            name: st.docs.project.name,
            dir: st.dir,
            pages,
            screens: st.screens.size,
            thumbs,
            ...(st.activity.length ? { lastActivity: st.activity[st.activity.length - 1]! } : {}),
            ...(st.example ? { example: true } : {}),
          };
        }),
    };
  }

  /** The built app's entry script (undefined in dev mode), so open tabs can tell the app was rebuilt. */
  const appBuild = () => {
    if (opts.dev) return undefined;
    try {
      return /assets\/(index-[\w-]+\.js)/.exec(fs.readFileSync(path.join(appDir, 'index.html'), 'utf8'))?.[1];
    } catch {
      return undefined;
    }
  };

  const wss = new WebSocketServer({ noServer: true, maxPayload: 50 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/ws') {
      const origin = req.headers.origin;
      const ownPage = !!origin && allowedHost(origin.replace(/^https?:\/\//, ''));
      // A page served from this exact origin gets in without the token: a tab opened before a restart still holds the
      // old one and must reconnect to send the changes it kept. Other origins never; clients without one need the token.
      if (
        !allowedHost(req.headers.host) ||
        (origin && !ownPage) ||
        (!ownPage && url.searchParams.get('token') !== token)
      ) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (s) => wss.emit('connection', s, req));
    }
    // other upgrades (Vite HMR) are handled by Vite's own listener
  });
  wss.on('connection', (s) => {
    sockets.add(s);
    let clientId = '';
    s.send(
      JSON.stringify({
        t: 'hello',
        serverId: token.slice(0, 8),
        version,
        token,
        build: appBuild(),
      } satisfies ServerMessage),
    );
    if (presence.state !== 'none') s.send(JSON.stringify({ t: 'agent', presence } satisfies ServerMessage));
    s.on('message', (raw) => {
      let m: ClientMessage;
      try {
        m = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      if (m.t === 'hello') clientId = m.clientId;
      else if (m.t === 'tx') {
        const r = service.apply(m.pid, m.ops, {
          actor: 'human',
          clientId,
          clientSeq: m.clientSeq,
          ...(m.summary ? { summary: m.summary } : {}),
        });
        if (!r.ok)
          s.send(
            JSON.stringify({
              t: 'error',
              message: r.error ?? 'change rejected',
              clientSeq: m.clientSeq,
            } satisfies ServerMessage),
          );
      } else if (m.t === 'view') {
        views.delete(clientId); // re-insert: the newest view is last (commands default to the project open there)
        views.set(clientId, m);
        running.snapshots?.setFocus(m.pid, m.visible);
      } else if (m.t === 'ping') s.send('{"t":"pong"}');
    });
    s.on('close', () => {
      sockets.delete(s);
      views.delete(clientId);
    });
  });

  if (opts.dev) {
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(packageRoot(), 'vite.config.ts'),
      server: { middlewareMode: true, hmr: { server } },
      appType: 'custom',
      logLevel: opts.quiet ? 'silent' : 'info',
    });
  }

  port = await listen(server, opts.port ?? 4317);
  const url = `http://localhost:${port}`;
  Object.assign(running, {
    url,
    port,
    token,
    ws,
    service,
    presence,
    broadcast,
    views,
    close: async () => {
      await service.flush();
      service.close();
      await running.snapshots?.close();
      for (const s of sockets) s.close();
      await vite?.close();
      await new Promise<void>((r) => server.close(() => r()));
      if (!opts.ephemeral) writeRegistry(readRegistry().filter((e) => e.pid !== process.pid || e.port !== port));
    },
  } satisfies Omit<RunningServer, 'snapshots'>);
  if (!opts.ephemeral)
    writeRegistry([
      ...readRegistry().filter((e) => e.workspace !== ws.root),
      { pid: process.pid, port, workspace: ws.root, token, version, startedAt: new Date().toISOString() },
    ]);
  await opts.onReady?.(running);
  return running;
}

async function openInEditor(file: string, reveal: boolean) {
  const { spawn } = await import('node:child_process');
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  const args = process.platform === 'darwin' ? (reveal ? ['-R', file] : [file]) : [reveal ? path.dirname(file) : file];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}
