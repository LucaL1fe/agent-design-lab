import fs from 'node:fs';
import path from 'node:path';

let root: string | undefined;

/** The agent-design-lab package folder (works from src/ in development and from dist/ when installed). */
export function packageRoot(): string {
  if (root) return root;
  let dir = import.meta.dirname;
  for (;;) {
    const pj = path.join(dir, 'package.json');
    if (fs.existsSync(pj)) {
      try {
        if (JSON.parse(fs.readFileSync(pj, 'utf8')).name === 'agent-design-lab') {
          root = dir;
          return dir;
        }
      } catch {
        // keep looking
      }
    }
    const up = path.dirname(dir);
    if (up === dir) throw new Error('agent-design-lab package.json not found');
    dir = up;
  }
}

/** When this copy's server and command line code last changed (ms): the newest code file under `dirs`. The version
 *  number stays the same between commits, so this is how a command tells that the server it talks to runs older code. */
export function codeChangedAt(dirs?: string[]): number {
  const root = dirs ? '' : packageRoot();
  let newest = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|js|mjs)$/.test(e.name)) newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  };
  for (const d of dirs ?? ['src/node', 'src/core', 'dist/node'].map((d) => path.join(root, d))) walk(d);
  return newest;
}

/** Did a server that started at `startedAt` (ISO time) load older code than the code changed at `changedAt` (ms)? */
export function serverIsStale(startedAt: string, changedAt: number): boolean {
  const started = Date.parse(startedAt);
  return Number.isFinite(started) && changedAt > started;
}

export function readVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')).version as string;
  } catch {
    return '0.0.0';
  }
}
