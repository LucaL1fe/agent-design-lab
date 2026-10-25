// Where designs live. A workspace is a folder with an adl.json (or any folder we are pointed at); every subfolder with a
// project.json is a project. In a clone of the repo, adl.json points the workspace at ./workspace.
import fs from 'node:fs';
import path from 'node:path';
import { parseJson } from '../core/json.ts';
import { packageRoot } from './version.ts';

export interface WorkspaceConfig {
  adl: 1;
  workspace?: string;
  projects?: string[];
}

export interface ResolvedWorkspace {
  /** Folder that holds the projects. */
  root: string;
  /** The adl.json that decided it, if any. */
  configFile?: string;
  config?: WorkspaceConfig;
  /** Extra project folders listed in adl.json "projects" (absolute). */
  extraProjects: string[];
}

function readConfig(file: string): WorkspaceConfig | undefined {
  try {
    const r = parseJson<WorkspaceConfig>(fs.readFileSync(file, 'utf8'));
    return r.ok && r.value && r.value.adl === 1 ? r.value : undefined;
  } catch {
    return undefined;
  }
}

/** The real path (symlinks such as macOS /tmp → /private/tmp resolved), or the path itself if it does not exist. */
export function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** --workspace, then ADL_WORKSPACE, then the nearest adl.json above `cwd`, then `cwd` itself. Paths are real paths, so
 *  the same folder reached through a symlink finds the same running server. */
export function resolveWorkspace(opts: { workspace?: string | undefined; cwd?: string } = {}): ResolvedWorkspace {
  const ws = resolveWorkspaceRaw(opts);
  return {
    ...ws,
    root: real(ws.root),
    ...(ws.configFile ? { configFile: real(ws.configFile) } : {}),
    extraProjects: ws.extraProjects.map(real),
  };
}

function resolveWorkspaceRaw(opts: { workspace?: string | undefined; cwd?: string }): ResolvedWorkspace {
  const cwd = opts.cwd ?? process.cwd();
  const explicit = opts.workspace ?? process.env.ADL_WORKSPACE;
  if (explicit) return fromFolder(path.resolve(cwd, explicit));
  let dir = cwd;
  for (;;) {
    const f = path.join(dir, 'adl.json');
    if (fs.existsSync(f)) {
      const config = readConfig(f);
      if (config) {
        const root = config.workspace ? path.resolve(dir, config.workspace) : dir;
        return { root, configFile: f, config, extraProjects: (config.projects ?? []).map((p) => path.resolve(dir, p)) };
      }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return fromFolder(cwd);
}

function fromFolder(dir: string): ResolvedWorkspace {
  const f = path.join(dir, 'adl.json');
  const config = fs.existsSync(f) ? readConfig(f) : undefined;
  if (config?.workspace && path.resolve(dir, config.workspace) !== dir) {
    return {
      root: path.resolve(dir, config.workspace),
      configFile: f,
      config,
      extraProjects: (config.projects ?? []).map((p) => path.resolve(dir, p)),
    };
  }
  return {
    root: dir,
    ...(config ? { configFile: f, config } : {}),
    extraProjects: (config?.projects ?? []).map((p) => path.resolve(dir, p)),
  };
}

/** Project folders: the workspace itself (if it is a project), its direct subfolders with a project.json, and extras. */
export function discoverProjects(ws: ResolvedWorkspace): string[] {
  const out = new Set<string>();
  if (fs.existsSync(path.join(ws.root, 'project.json'))) out.add(ws.root);
  if (fs.existsSync(ws.root)) {
    for (const e of fs.readdirSync(ws.root, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const dir = path.join(ws.root, e.name);
      if (fs.existsSync(path.join(dir, 'project.json'))) out.add(dir);
    }
  }
  for (const p of ws.extraProjects) if (fs.existsSync(path.join(p, 'project.json'))) out.add(p);
  return [...out];
}

/** Stable, URL-safe project id from its folder. */
export function projectIdOf(ws: ResolvedWorkspace, dir: string): string {
  const rel = path.relative(ws.root, dir);
  const base = rel && !rel.startsWith('..') ? rel : path.basename(dir);
  return (
    base
      .replace(/[\\/]+/g, '--')
      .replace(/[^A-Za-z0-9_.-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  );
}

/** The examples that ship with Agent Design Lab (examples/<name> in the package). Every workspace shows them, read-only;
 *  `adl copy` makes an editable copy. */
export function builtinExamples(): string[] {
  const dir = path.join(packageRoot(), 'examples');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'project.json')))
    .map((e) => real(path.join(dir, e.name)));
}

/** Id of a built-in example: "example-" + its folder name. */
export function exampleIdOf(dir: string): string {
  return `example-${path.basename(dir).replace(/[^A-Za-z0-9_.-]+/g, '-')}`;
}
