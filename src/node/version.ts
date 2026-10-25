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

export function readVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')).version as string;
  } catch {
    return '0.0.0';
  }
}
