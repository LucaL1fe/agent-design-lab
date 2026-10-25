// The single writer. Holds every project in memory, applies transactions from people (WebSocket) and agents (CLI/API),
// writes canonical files, watches the folder, merges files that agents write directly, compiles screens.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { describeChanges } from '../../core/describe.ts';
import { resolveFrame } from '../../core/frames.ts';
import { type JsonError, jsonEqual, parseJson, stringifyPage, stringifyProject } from '../../core/json.ts';
import { type Conflict, merge3, mergePage } from '../../core/merge.ts';
import { applyOps, type DocKey, type Docs, diffDoc, pageIdOf, pageKey, type SetOp } from '../../core/ops.ts';
import { issuesOf, PageSchema, ProjectSchema } from '../../core/schema.ts';
import type { Actor, PageDoc, ProjectDoc } from '../../core/types.ts';
import { type Problem, validateRefs } from '../../core/validate.ts';
import { type CompileContext, type CompiledScreen, type CompiledSheet, compileScreen } from '../compile/screen.ts';
import { exists, readText, sha, waitStable, writeAtomic } from '../fsutil.ts';
import { builtinExamples, discoverProjects, exampleIdOf, projectIdOf, type ResolvedWorkspace } from '../paths.ts';

const HISTORY_DEPTH = 60;

export interface ScreenEntry {
  id: string;
  file: string;
  fileHash?: string;
  compiled?: CompiledScreen;
  error?: string;
}

export interface ScreenMeta {
  id: string;
  file: string;
  hash: string;
  title?: string;
  frame?: string;
  anchors: string[];
  gos: CompiledScreen['gos'];
  warnings: string[];
  cost: CompiledScreen['cost'];
  sheets: string[];
  /** Measured content height for auto-height frames (from snapshots). */
  autoH?: number;
}

export interface ActivityEntry {
  at: string;
  actor: Actor;
  pid: string;
  page?: string;
  summary: string;
  ids?: string[];
  /** What changed, line by line (for `adl context` and the Activity panel). */
  details?: string[];
}

export interface TxResult {
  ok: boolean;
  ops: SetOp[];
  revs: Record<string, number>;
  error?: string;
  conflicts?: Conflict[];
}

export interface ProjectState {
  id: string;
  dir: string;
  /** Folder for this project's local state (caches, activity, history, renders): `<project>/.adl`; for a built-in
   *  example `<workspace>/.adl/example/<id>`, so nothing is ever written into the package. */
  adl: string;
  /** A built-in example: listed in every workspace, read-only (`adl copy` makes an editable copy). */
  example?: boolean;
  docs: Docs;
  /** rev → document, per document key (merge bases for agent writes). */
  /** Per document and rev: every content that rev has stood for (the server's own version, plus agent writes that
   *  kept the rev they read). Agents' writes are merged against the closest one. */
  history: Map<DocKey, Map<number, unknown[]>>;
  /** Last content we know is on disk per document (parsed), used when an agent's rev is unknown. */
  disk: Map<DocKey, unknown>;
  /** Hash of the bytes we wrote or last read, per project-relative file. */
  fileHashes: Map<string, string>;
  screens: Map<string, ScreenEntry>;
  /** Compiled versions that were just replaced, by hash: a tab that saw the old version can still load it. */
  recent: Map<string, CompiledScreen>;
  sheets: Map<string, CompiledSheet>;
  sheetCache: CompileContext['sheetCache'];
  invalid: Map<string, JsonError & { file: string }>;
  problems: Problem[];
  writeTimers: Map<DocKey, NodeJS.Timeout>;
  lastWrite: Map<DocKey, number>;
  activity: ActivityEntry[];
  autoH: Map<string, number>;
  /** Per agent session: the last version of each document it wrote (its next write usually builds on it). */
  agentWrites: Map<string, Map<DocKey, unknown>>;
}

export interface WorkspaceEvents {
  tx: {
    pid: string;
    actor: Actor;
    ops: SetOp[];
    revs: Record<string, number>;
    summary?: string;
    clientId?: string;
    clientSeq?: number;
    conflicts?: Conflict[];
  };
  screens: { pid: string; changed: ScreenMeta[]; removed: string[] };
  problems: { pid: string; problems: Problem[] };
  projects: { ids: string[] };
  activity: ActivityEntry;
  reload: { pid: string };
}

export class WorkspaceService extends EventEmitter {
  readonly ws: ResolvedWorkspace;
  readonly projects = new Map<string, ProjectState>();
  private watcher?: fs.FSWatcher;
  private reconcileTimer?: NodeJS.Timeout;
  private pending = new Map<string, NodeJS.Timeout>();
  private remoteCss = new Map<string, string | undefined>();
  private logJobs = new Set<Promise<unknown>>();
  /** Which agent session is writing which file (reported by the Claude Code hook just before a Write/Edit). */
  private writers = new Map<string, { session: string; at: number }>();
  writeDelay = 300;
  minWriteGap = 1000;
  readonly baseUrl: string;
  /** Also load the built-in examples (the server does; short-lived CLI services do not). */
  readonly examples: boolean;

  constructor(ws: ResolvedWorkspace, opts: { baseUrl?: string; examples?: boolean } = {}) {
    super();
    this.ws = ws;
    this.baseUrl = opts.baseUrl ?? '';
    this.examples = opts.examples ?? false;
  }

  emitEvent<K extends keyof WorkspaceEvents>(name: K, data: WorkspaceEvents[K]) {
    this.emit(name, data);
  }

  // ---------- loading ----------

  async load(): Promise<void> {
    const dirs = discoverProjects(this.ws);
    const seen = new Set<string>();
    for (const dir of dirs) {
      let id = projectIdOf(this.ws, dir);
      while (seen.has(id)) id += '-2';
      seen.add(id);
      if (this.projects.get(id)?.dir === dir) continue;
      await this.loadProject(id, dir);
    }
    // the built-in examples, unless the workspace holds that folder itself (the repo's own `adl open examples`)
    for (const dir of this.examples ? builtinExamples().filter((d) => !dirs.includes(d)) : []) {
      let id = exampleIdOf(dir);
      while (seen.has(id)) id += '-2';
      seen.add(id);
      if (this.projects.get(id)?.dir === dir) continue;
      await this.loadProject(id, dir, true);
    }
    for (const id of [...this.projects.keys()]) if (!seen.has(id)) this.projects.delete(id);
    this.emitEvent('projects', { ids: [...this.projects.keys()] });
  }

  private async loadProject(id: string, dir: string, example = false): Promise<ProjectState | undefined> {
    const st: ProjectState = {
      id,
      dir,
      adl: example ? path.join(this.ws.root, '.adl', 'example', id) : path.join(dir, '.adl'),
      ...(example ? { example } : {}),
      docs: { project: undefined as unknown as ProjectDoc, pages: {} },
      history: new Map(),
      disk: new Map(),
      fileHashes: new Map(),
      screens: new Map(),
      recent: new Map(),
      sheets: new Map(),
      sheetCache: new Map(),
      invalid: new Map(),
      problems: [],
      writeTimers: new Map(),
      lastWrite: new Map(),
      activity: [],
      autoH: new Map(),
      agentWrites: new Map(),
    };
    const pj = await this.readDoc(st, 'project.json', 'project');
    if (!pj) {
      st.docs.project = { adl: 1, rev: 0, name: path.basename(dir), pages: [] };
      st.problems.push({
        level: 'error',
        code: 'project-invalid',
        file: 'project.json',
        message: 'project.json is missing or broken',
      });
    } else st.docs.project = pj as ProjectDoc;
    for (const pid of st.docs.project.pages) {
      const doc = await this.readDoc(st, `pages/${pid}.json`, pageKey(pid));
      if (doc) st.docs.pages[pid] = doc as PageDoc;
    }
    this.loadActivity(st);
    this.projects.set(id, st);
    await this.scanScreens(st);
    this.revalidate(st);
    return st;
  }

  /** Read + parse + schema-check a JSON document; records it as the disk version. */
  private async readDoc(st: ProjectState, rel: string, key: DocKey): Promise<unknown | undefined> {
    const text = await readText(path.join(st.dir, rel));
    if (text === undefined) return undefined;
    st.fileHashes.set(rel, sha(text));
    const r = parseJson(text);
    if (!r.ok) {
      st.invalid.set(rel, { ...r.error, file: rel });
      return undefined;
    }
    const schema = key === 'project' ? ProjectSchema : PageSchema;
    const v = schema.safeParse(r.value);
    if (!v.success) {
      const first = issuesOf(v.error)[0];
      st.invalid.set(rel, { message: `${first?.path || '(root)'}: ${first?.message}`, line: 1, col: 1, file: rel });
      return undefined;
    }
    st.invalid.delete(rel);
    const doc = v.data as unknown as { rev: number };
    st.disk.set(key, doc);
    this.remember(st, key, doc);
    return doc;
  }

  private remember(st: ProjectState, key: DocKey, doc: unknown) {
    const rev = (doc as { rev?: number })?.rev ?? 0;
    let h = st.history.get(key);
    if (!h) {
      h = new Map();
      st.history.set(key, h);
    }
    const list = h.get(rev) ?? [];
    if (!list.some((d) => jsonEqual(d, doc))) list.push(doc);
    if (list.length > 8) list.shift();
    h.delete(rev);
    h.set(rev, list);
    if (h.size > HISTORY_DEPTH) h.delete(h.keys().next().value!);
  }

  /** An agent session is about to write this file (from the hook's PreToolUse). */
  noteWriter(file: string, session: string) {
    let abs = path.resolve(file);
    try {
      abs = fs.realpathSync(abs);
    } catch {
      // a new file: its folder decides
      try {
        abs = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
      } catch {
        // keep as given
      }
    }
    this.writers.set(abs, { session, at: Date.now() });
    if (this.writers.size > 200) this.writers.delete(this.writers.keys().next().value!);
  }

  private writerOf(abs: string): string | undefined {
    const w = this.writers.get(abs);
    return w && Date.now() - w.at < 120_000 ? w.session : undefined;
  }

  /** The merge base for an agent's write. Its rev may stand for several versions: the server's own and other agents'
   *  writes that kept the rev they read. Known writer: its own last write when it builds on that, else the server's
   *  version (never another agent's write, which would delete that agent's work). Unknown writer: the closest one. */
  private baseFor(
    st: ProjectState,
    key: DocKey,
    theirs: Record<string, unknown>,
    session?: string,
  ): Record<string, unknown> | undefined {
    const rev = typeof theirs.rev === 'number' ? theirs.rev : -1;
    const candidates = (st.history.get(key)?.get(rev) ?? []) as Record<string, unknown>[];
    if (session) {
      const own = st.agentWrites.get(session)?.get(key) as Record<string, unknown> | undefined;
      if (own && own.rev === rev) return own;
      return candidates[0] ?? (st.disk.get(key) as Record<string, unknown> | undefined);
    }
    if (!candidates.length) return st.disk.get(key) as Record<string, unknown> | undefined;
    if (candidates.length === 1) return candidates[0];
    const strip = (d: Record<string, unknown>) => ({ ...d, rev: 0 });
    let best = candidates[0]!;
    let bestN = Number.POSITIVE_INFINITY;
    // newest first, so ties go to the latest version of that rev
    for (const c of [...candidates].reverse()) {
      const n = diffDoc(key, strip(c), strip(theirs)).length;
      if (n < bestN) {
        best = c;
        bestN = n;
      }
    }
    return best;
  }

  // ---------- screens ----------

  private screenFiles(st: ProjectState): { id: string; file: string }[] {
    const root = path.join(st.dir, 'screens');
    const out: { id: string; file: string }[] = [];
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.html?$/i.test(e.name))
          out.push({
            id: e.name.replace(/\.html?$/i, ''),
            file: path.relative(st.dir, full).split(path.sep).join('/'),
          });
      }
    };
    walk(root);
    // duplicate base names in subfolders: use the relative path (without screens/ and .html) as the id
    const counts = new Map<string, number>();
    for (const s of out) counts.set(s.id, (counts.get(s.id) ?? 0) + 1);
    return out.map((s) =>
      counts.get(s.id)! > 1 ? { id: s.file.replace(/^screens\//, '').replace(/\.html?$/i, ''), file: s.file } : s,
    );
  }

  private async scanScreens(st: ProjectState): Promise<{ changed: ScreenMeta[]; removed: string[] }> {
    const files = this.screenFiles(st);
    const ids = new Set(files.map((f) => f.id));
    const removed: string[] = [];
    for (const id of [...st.screens.keys()])
      if (!ids.has(id)) {
        st.screens.delete(id);
        removed.push(id);
      }
    const changed: ScreenMeta[] = [];
    for (const f of files) {
      const meta = await this.compileOne(st, f.id, f.file);
      if (meta) changed.push(meta);
    }
    return { changed, removed };
  }

  /** Compile one screen if its file or any dependency changed. Returns metadata when the compiled output changed. */
  async compileOne(st: ProjectState, id: string, file: string, force = false): Promise<ScreenMeta | undefined> {
    const abs = path.join(st.dir, file);
    const text = await readText(abs);
    const prev = st.screens.get(id);
    const keep = (c: CompiledScreen | undefined) => {
      if (!c) return;
      st.recent.delete(c.hash);
      st.recent.set(c.hash, c);
      while (st.recent.size > 64) st.recent.delete(st.recent.keys().next().value!);
    };
    if (text === undefined) {
      if (prev) {
        keep(prev.compiled);
        st.screens.delete(id);
      }
      return undefined;
    }
    const fileHash = sha(text);
    const depsKey = prev?.compiled
      ? prev.compiled.deps.map((d) => `${d}:${this.fileHash(st, d) ?? '-'}`).join('|')
      : '';
    if (
      !force &&
      prev?.compiled &&
      prev.fileHash === fileHash &&
      (prev as ScreenEntry & { depsKey?: string }).depsKey === depsKey
    )
      return undefined;
    const entry: ScreenEntry & { depsKey?: string } = { id, file, fileHash };
    try {
      const { screen, sheets } = compileScreen(text, this.compileCtx(st, id, file));
      entry.compiled = screen;
      for (const s of sheets) st.sheets.set(s.hash, s);
      entry.depsKey = screen.deps.map((d) => `${d}:${this.fileHash(st, d) ?? '-'}`).join('|');
    } catch (e) {
      entry.error = (e as Error).message;
    }
    st.screens.set(id, entry);
    if (prev?.compiled && prev.compiled.hash !== entry.compiled?.hash) keep(prev.compiled);
    if (prev?.compiled && entry.compiled && prev.compiled.hash === entry.compiled.hash) return undefined;
    return entry.compiled ? this.metaOf(st, entry) : undefined;
  }

  private fileHashCache = new Map<string, { mtime: number; size: number; hash: string }>();
  fileHash(st: ProjectState, rel: string): string | undefined {
    const abs = path.join(st.dir, rel);
    let s: fs.Stats;
    try {
      s = fs.statSync(abs);
    } catch {
      return undefined;
    }
    const c = this.fileHashCache.get(abs);
    if (c && c.mtime === s.mtimeMs && c.size === s.size) return c.hash;
    const hash = sha(fs.readFileSync(abs));
    this.fileHashCache.set(abs, { mtime: s.mtimeMs, size: s.size, hash });
    return hash;
  }

  private compileCtx(st: ProjectState, id: string, file: string): CompileContext {
    return {
      file,
      id,
      fileUrl: (rel) =>
        `${this.baseUrl}/api/p/${encodeURIComponent(st.id)}/f/${rel.split('/').map(encodeURIComponent).join('/')}?v=${this.fileHash(st, rel)?.slice(0, 8) ?? '0'}`,
      readFile: (rel) => {
        try {
          return fs.readFileSync(path.join(st.dir, rel), 'utf8');
        } catch {
          return undefined;
        }
      },
      fileHash: (rel) => this.fileHash(st, rel),
      sheetCache: st.sheetCache,
      remote: (url) => this.remoteCss.get(url),
    };
  }

  metaOf(st: ProjectState, e: ScreenEntry): ScreenMeta {
    const c = e.compiled!;
    const autoH = st.autoH.get(c.hash);
    return {
      id: e.id,
      file: e.file,
      hash: c.hash,
      ...(c.title ? { title: c.title } : {}),
      ...(c.frame ? { frame: c.frame } : {}),
      anchors: c.anchors,
      gos: c.gos,
      warnings: c.warnings,
      cost: c.cost,
      sheets: c.sheets,
      ...(autoH ? { autoH } : {}),
    };
  }

  screensMeta(st: ProjectState): Record<string, ScreenMeta> {
    const out: Record<string, ScreenMeta> = {};
    for (const e of st.screens.values()) if (e.compiled) out[e.id] = this.metaOf(st, e);
    return out;
  }

  /** Size of a screen item's frame (auto heights use the measured height). */
  frameSize(st: ProjectState, screenId: string, frameOverride?: string): { w: number; h: number } {
    const c = st.screens.get(screenId)?.compiled;
    const f = resolveFrame(frameOverride ?? c?.frame, st.docs.project) ??
      resolveFrame(undefined, st.docs.project) ?? { w: 393, h: 852 };
    const h = f.h === 'auto' ? ((c ? st.autoH.get(c.hash) : undefined) ?? 1200) : f.h;
    return { w: f.w, h };
  }

  setAutoHeight(pid: string, hash: string, h: number) {
    const st = this.projects.get(pid);
    if (!st) return;
    if (st.autoH.get(hash) === h) return;
    st.autoH.set(hash, h);
    const e = [...st.screens.values()].find((s) => s.compiled?.hash === hash);
    if (e) this.emitEvent('screens', { pid, changed: [this.metaOf(st, e)], removed: [] });
  }

  // ---------- transactions ----------

  apply(
    pid: string,
    ops: SetOp[],
    meta: { actor: Actor; summary?: string; clientId?: string; clientSeq?: number },
  ): TxResult {
    const st = this.projects.get(pid);
    if (!st) return { ok: false, ops: [], revs: {}, error: `No project "${pid}"` };
    if (st.example) return { ok: false, ops: [], revs: {}, error: exampleReadOnly(st) };
    let r: ReturnType<typeof applyOps>;
    try {
      r = applyOps(st.docs, ops);
    } catch (e) {
      return { ok: false, ops: [], revs: {}, error: (e as Error).message };
    }
    // basic integrity: project.json must stay valid
    if (r.touched.has('project') && !ProjectSchema.safeParse(r.docs.project).success)
      return { ok: false, ops: [], revs: {}, error: 'This change would make project.json invalid' };
    const revs: Record<string, number> = {};
    const before = st.docs;
    let docs = r.docs;
    for (const key of r.touched) {
      const doc = key === 'project' ? docs.project : docs.pages[pageIdOf(key)!];
      if (doc) {
        const rev = revOf(st.docs, key) + 1;
        const next = { ...doc, rev };
        docs =
          key === 'project'
            ? { ...docs, project: next as ProjectDoc }
            : { ...docs, pages: { ...docs.pages, [pageIdOf(key)!]: next as PageDoc } };
        revs[key] = rev;
        this.remember(st, key, next);
      } else revs[key] = 0;
    }
    st.docs = docs;
    for (const key of r.touched) this.scheduleWrite(st, key);
    if (r.ops.length) {
      this.emitEvent('tx', {
        pid,
        actor: meta.actor,
        ops: r.ops,
        revs,
        ...(meta.summary ? { summary: meta.summary } : {}),
        ...(meta.clientId ? { clientId: meta.clientId } : {}),
        ...(meta.clientSeq !== undefined ? { clientSeq: meta.clientSeq } : {}),
      });
      if (meta.summary) {
        const details = describeChanges(before, docs, r.ops);
        this.log(st, {
          at: new Date().toISOString(),
          actor: meta.actor,
          pid,
          summary: meta.summary,
          ...(pageOfOps(r.ops) ? { page: pageOfOps(r.ops)! } : {}),
          ...(details.length ? { details } : {}),
        });
      }
      this.revalidate(st);
    } else if (meta.clientId) {
      // nothing changed, but the client still needs its ack
      this.emitEvent('tx', {
        pid,
        actor: meta.actor,
        ops: [],
        revs,
        clientId: meta.clientId,
        ...(meta.clientSeq !== undefined ? { clientSeq: meta.clientSeq } : {}),
      });
    }
    return { ok: true, ops: r.ops, revs };
  }

  // ---------- writing ----------

  private scheduleWrite(st: ProjectState, key: DocKey) {
    const t = st.writeTimers.get(key);
    if (t) clearTimeout(t);
    const since = Date.now() - (st.lastWrite.get(key) ?? 0);
    const delay = Math.max(this.writeDelay, this.minWriteGap - since);
    st.writeTimers.set(
      key,
      setTimeout(() => {
        st.writeTimers.delete(key);
        void this.writeNow(st, key);
      }, delay),
    );
  }

  private async writeNow(st: ProjectState, key: DocKey) {
    const rel = key === 'project' ? 'project.json' : `pages/${pageIdOf(key)}.json`;
    const abs = path.join(st.dir, rel);
    const doc = key === 'project' ? st.docs.project : st.docs.pages[pageIdOf(key)!];
    st.lastWrite.set(key, Date.now());
    if (!doc) {
      // page deleted: keep a copy in .adl/trash
      if (exists(abs)) {
        const trash = path.join(st.adl, 'trash', `${pageIdOf(key)}-${Date.now()}.json`);
        await fsp.mkdir(path.dirname(trash), { recursive: true });
        await fsp.rename(abs, trash).catch(() => undefined);
      }
      st.fileHashes.delete(rel);
      st.disk.delete(key);
      return;
    }
    const text = key === 'project' ? stringifyProject(doc as never) : stringifyPage(doc as never);
    st.fileHashes.set(rel, sha(text));
    st.disk.set(key, doc);
    st.invalid.delete(rel);
    await writeAtomic(abs, text);
    await this.keepVersion(st, rel, text);
  }

  /** Content-addressed copy of every saved version in .adl/history (restore from the History panel or `adl history`). */
  private async keepVersion(st: ProjectState, rel: string, text: string) {
    try {
      const dir = path.join(st.adl, 'history', rel.replace(/[/\\]/g, '__'));
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, `${Date.now()}-${sha(text, 8)}.json`), text);
    } catch {
      // history is best effort
    }
  }

  async flush(): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const st of this.projects.values()) {
      for (const [key, t] of st.writeTimers) {
        clearTimeout(t);
        st.writeTimers.delete(key);
        jobs.push(this.writeNow(st, key));
      }
    }
    await Promise.all([...jobs, ...this.logJobs]);
  }

  // ---------- watching ----------

  watch(): void {
    if (this.watcher) return;
    try {
      this.watcher = fs.watch(this.ws.root, { recursive: true }, (_ev, name) => {
        if (!name) return;
        this.onPath(path.join(this.ws.root, name.toString()));
      });
      this.watcher.on('error', () => undefined);
    } catch {
      // recursive watching unsupported: the reconcile scan still picks changes up
    }
    for (const p of this.ws.extraProjects) {
      try {
        fs.watch(p, { recursive: true }, (_e, name) => name && this.onPath(path.join(p, name.toString())));
      } catch {
        // ignore
      }
    }
    this.reconcileTimer = setInterval(() => void this.reconcile(), 5000);
    this.reconcileTimer.unref?.();
  }

  close(): void {
    this.watcher?.close();
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    for (const t of this.pending.values()) clearTimeout(t);
  }

  private projectOf(abs: string): ProjectState | undefined {
    let best: ProjectState | undefined;
    for (const st of this.projects.values())
      if (abs === st.dir || abs.startsWith(st.dir + path.sep)) if (!best || st.dir.length > best.dir.length) best = st;
    return best;
  }

  /** Debounced per path: JSON quickly, HTML/CSS after the file is stable. */
  onPath(abs: string) {
    if (
      abs.includes(`${path.sep}.adl${path.sep}`) ||
      abs.endsWith('.tmp') ||
      abs.includes(`${path.sep}node_modules${path.sep}`) ||
      path.basename(abs).startsWith('.')
    )
      return;
    const t = this.pending.get(abs);
    if (t) clearTimeout(t);
    const delay = abs.endsWith('.json') ? 30 : 80;
    this.pending.set(
      abs,
      setTimeout(() => {
        this.pending.delete(abs);
        void this.handlePath(abs).catch((e) => this.emit('error', e));
      }, delay),
    );
  }

  private async handlePath(abs: string) {
    const st = this.projectOf(abs);
    if (!st) {
      if (path.basename(abs) === 'project.json') await this.load();
      return;
    }
    const rel = path.relative(st.dir, abs).split(path.sep).join('/');
    if (rel === 'project.json') return this.onDocFile(st, rel, 'project');
    const pm = rel.match(/^pages\/([a-z0-9][a-z0-9-]*)\.json$/);
    if (pm) return this.onDocFile(st, rel, pageKey(pm[1]!));
    // any other file: screens and anything screens depend on
    await waitStable(abs);
    const changed: ScreenMeta[] = [];
    const removed: string[] = [];
    if (/^screens\/.+\.html?$/i.test(rel)) {
      const r = await this.scanScreens(st);
      changed.push(...r.changed);
      removed.push(...r.removed);
    } else {
      for (const e of [...st.screens.values()]) {
        if (!e.compiled?.deps.includes(rel)) continue;
        const m = await this.compileOne(st, e.id, e.file);
        if (m) changed.push(m);
      }
    }
    if (changed.length || removed.length) {
      this.emitEvent('screens', { pid: st.id, changed, removed });
      this.revalidate(st);
    }
  }

  /** Someone (usually an agent) wrote project.json or a page file. */
  private async onDocFile(st: ProjectState, rel: string, key: DocKey) {
    const abs = path.join(st.dir, rel);
    await waitStable(abs, 25, 10);
    const text = await readText(abs);
    if (text === undefined) {
      // the file was deleted from outside: forget the page (it stays in memory until the project lists it again)
      if (key !== 'project' && st.docs.pages[pageIdOf(key)!] && !st.writeTimers.has(key)) {
        st.invalid.set(rel, { file: rel, message: 'The file was deleted', line: 1, col: 1 });
        this.revalidate(st);
      }
      return;
    }
    const h = sha(text);
    if (st.fileHashes.get(rel) === h) return; // our own write, or unchanged
    st.fileHashes.set(rel, h);
    let parsed = parseJson(text);
    if (!parsed.ok) {
      // editors sometimes show us a half-written file: try again shortly before reporting it
      for (const ms of [50, 150, 400]) {
        await new Promise((r) => setTimeout(r, ms));
        const again = await readText(abs);
        if (again === undefined) return;
        parsed = parseJson(again);
        if (parsed.ok) break;
      }
    }
    if (!parsed.ok) {
      st.invalid.set(rel, { ...parsed.error, file: rel });
      this.revalidate(st);
      return;
    }
    const schema = key === 'project' ? ProjectSchema : PageSchema;
    const v = schema.safeParse(parsed.value);
    if (!v.success) {
      const first = issuesOf(v.error)[0];
      st.invalid.set(rel, {
        message: `${first?.path || '(root)'}: ${first?.message}`,
        line: findLine(text, first?.path),
        col: 1,
        file: rel,
      });
      this.revalidate(st);
      return;
    }
    st.invalid.delete(rel);
    const theirs = v.data as unknown as Record<string, unknown>;
    const ours = (key === 'project' ? st.docs.project : st.docs.pages[pageIdOf(key)!]) as unknown as
      | Record<string, unknown>
      | undefined;
    const session = this.writerOf(abs);
    const base = this.baseFor(st, key, theirs, session);
    let merged: Record<string, unknown>;
    let conflicts: Conflict[] = [];
    if (!ours) merged = theirs;
    else {
      const strip = (d: Record<string, unknown> | undefined) => (d ? { ...d, rev: 0 } : d);
      const m =
        key === 'project'
          ? merge3(strip(base), strip(ours), strip(theirs))
          : mergePage(strip(base), strip(ours), strip(theirs));
      merged = m.value as Record<string, unknown>;
      conflicts = m.conflicts;
    }
    st.disk.set(key, theirs);
    // the agent's file keeps the rev it read; from now on that rev also means this content (the next read gets it)
    this.remember(st, key, theirs);
    if (session) {
      if (!st.agentWrites.has(session)) st.agentWrites.set(session, new Map());
      st.agentWrites.get(session)!.set(key, theirs);
    }
    const ops = diffDoc(key, ours ? { ...ours, rev: 0 } : undefined, { ...merged, rev: 0 }).filter(
      (o) => o.path[0] !== 'rev',
    );
    if (key === 'project') {
      // pages listed for the first time: load their files
      const pages = (merged.pages as string[] | undefined) ?? [];
      for (const pid of pages) if (!st.docs.pages[pid]) await this.loadPageFile(st, pid);
    }
    if (ops.length) {
      const res = this.apply(st.id, ops, { actor: 'agent', summary: summarize(key, ops) });
      if (conflicts.length) this.emitEvent('tx', { pid: st.id, actor: 'agent', ops: [], revs: res.revs, conflicts });
      // keep the agent's file untouched when it already matches what we hold (no surprise rewrites under the agent)
      const now = key === 'project' ? st.docs.project : st.docs.pages[pageIdOf(key)!];
      if (now && jsonEqual({ ...now, rev: 0 }, { ...theirs, rev: 0 })) {
        const t = st.writeTimers.get(key);
        if (t) {
          clearTimeout(t);
          st.writeTimers.delete(key);
        }
      }
    }
  }

  private async loadPageFile(st: ProjectState, pid: string) {
    const doc = await this.readDoc(st, `pages/${pid}.json`, pageKey(pid));
    if (doc) {
      st.docs = { ...st.docs, pages: { ...st.docs.pages, [pid]: doc as PageDoc } };
      this.emitEvent('reload', { pid: st.id });
    }
  }

  /** Every 5 s: pick up anything the watcher missed (renames, git checkouts, network drives). */
  async reconcile() {
    for (const st of this.projects.values()) for (const p of await this.stalePaths(st)) this.onPath(p);
  }

  /** Files on disk that differ from what is in memory (page and project files, and a screens rescan when any screen
   *  file was added, removed or changed). */
  private async stalePaths(st: ProjectState): Promise<string[]> {
    const out: string[] = [];
    for (const rel of ['project.json', ...st.docs.project.pages.map((p) => `pages/${p}.json`)]) {
      const text = await readText(path.join(st.dir, rel));
      if (text !== undefined && st.fileHashes.get(rel) !== sha(text)) out.push(path.join(st.dir, rel));
    }
    const files = this.screenFiles(st);
    const known = new Map([...st.screens.values()].map((s) => [s.id, s.fileHash]));
    let dirty = files.length !== known.size;
    if (!dirty) for (const f of files) if (!known.has(f.id)) dirty = true;
    if (!dirty) {
      for (const e of st.screens.values()) {
        const h = this.fileHash(st, e.file);
        if (h !== e.fileHash) {
          dirty = true;
          break;
        }
      }
    }
    if (dirty) out.push(path.join(st.dir, 'screens', '__scan__.html'));
    return out;
  }

  /** Catch up with the disk now, before a command reads the workspace: an agent that edits a screen and runs
   *  `adl render` straight away got the version from before its edit (the watcher waits 30-80 ms and more). */
  async settle(): Promise<void> {
    const paths = new Set(this.pending.keys());
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    for (const st of this.projects.values()) for (const p of await this.stalePaths(st)) paths.add(p);
    for (const p of paths) await this.handlePath(p).catch((e) => this.emit('error', e));
  }

  // ---------- problems ----------

  revalidate(st: ProjectState) {
    const problems: Problem[] = [];
    for (const e of st.invalid.values())
      problems.push({
        level: 'error',
        code: 'invalid-file',
        file: e.file,
        line: e.line,
        message: `${e.file}:${e.line}:${e.col} ${e.message}. Showing the last good version.`,
      });
    problems.push(...validateRefs(st.docs.project, st.docs.pages));
    for (const e of st.screens.values()) {
      if (e.error) problems.push({ level: 'error', code: 'compile', file: e.file, message: `${e.file}: ${e.error}` });
      for (const w of e.compiled?.warnings ?? [])
        problems.push({ level: 'warning', code: 'screen', file: e.file, id: e.id, message: `${e.id}: ${w}` });
    }
    const key = JSON.stringify(problems);
    if (key !== JSON.stringify(st.problems)) {
      st.problems = problems;
      this.emitEvent('problems', { pid: st.id, problems });
    }
  }

  // ---------- activity ----------

  log(st: ProjectState, entry: ActivityEntry) {
    // strictly increasing times, so "everything after the agent's marker" never loses a same-millisecond entry
    const last = st.activity[st.activity.length - 1]?.at;
    if (last && entry.at <= last) entry = { ...entry, at: new Date(Date.parse(last) + 1).toISOString() };
    st.activity.push(entry);
    if (st.activity.length > 500) st.activity.splice(0, st.activity.length - 500);
    this.emitEvent('activity', entry);
    const file = path.join(st.adl, 'activity.jsonl');
    const job = fsp
      .mkdir(path.dirname(file), { recursive: true })
      .then(() => fsp.appendFile(file, JSON.stringify(entry) + '\n'))
      .catch(() => undefined);
    this.logJobs.add(job);
    void job.finally(() => this.logJobs.delete(job));
  }

  private loadActivity(st: ProjectState) {
    try {
      const lines = fs.readFileSync(path.join(st.adl, 'activity.jsonl'), 'utf8').trim().split('\n').slice(-500);
      for (const l of lines) {
        try {
          st.activity.push(JSON.parse(l));
        } catch {
          // skip broken lines
        }
      }
    } catch {
      // no activity yet
    }
  }

  setRemoteCss(url: string, text: string | undefined) {
    this.remoteCss.set(url, text);
  }
}

/** Why a built-in example cannot be changed, and what to do instead. */
export function exampleReadOnly(st: ProjectState): string {
  return `"${st.docs.project.name}" is a built-in example and stays as it is. Make a copy to edit it: adl copy ${st.id}`;
}

function revOf(docs: Docs, key: DocKey): number {
  const d = key === 'project' ? docs.project : docs.pages[pageIdOf(key)!];
  return (d as { rev?: number } | undefined)?.rev ?? 0;
}

function pageOfOps(ops: SetOp[]): string | undefined {
  for (const o of ops) {
    const p = pageIdOf(o.doc);
    if (p) return p;
  }
  return undefined;
}

function findLine(text: string, p?: string): number {
  if (!p) return 1;
  const last = p
    .split('.')
    .filter((s) => !/^\d+$/.test(s))
    .pop();
  if (!last) return 1;
  const i = text.indexOf(`"${last}"`);
  return i < 0 ? 1 : text.slice(0, i).split('\n').length;
}

/** Human-readable summary of what changed in a file the agent wrote, for toasts and the activity log. */
export function summarize(key: DocKey, ops: SetOp[]): string {
  if (key === 'project') return 'Claude changed project.json';
  const page = pageIdOf(key);
  const added = new Set<string>();
  const removed = new Set<string>();
  const changed = new Set<string>();
  let arrows = 0;
  for (const o of ops) {
    if (o.path[0] === 'items' && o.path.length === 2) {
      if (o.prev === undefined) added.add(o.path[1]!);
      else if (o.value === undefined) removed.add(o.path[1]!);
      else changed.add(o.path[1]!);
    } else if (o.path[0] === 'items') changed.add(o.path[1]!);
    else if (o.path[0] === 'arrows') arrows++;
  }
  const parts: string[] = [];
  const list = (s: Set<string>) => [...s].slice(0, 4).join(', ') + (s.size > 4 ? ` +${s.size - 4}` : '');
  if (added.size) parts.push(`added ${list(added)}`);
  if (changed.size) parts.push(`changed ${list(changed)}`);
  if (removed.size) parts.push(`removed ${list(removed)}`);
  if (arrows) parts.push(`${arrows} arrow change${arrows === 1 ? '' : 's'}`);
  return `Claude ${parts.join(' · ') || 'edited'} on ${page}`;
}
