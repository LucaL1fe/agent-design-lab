import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export function sha(data: string | Buffer, len = 16): string {
  return createHash('sha256').update(data).digest('hex').slice(0, len);
}

/** Write via a temp file in the same folder and rename, so readers never see a half-written file. */
export async function writeAtomic(file: string, data: string | Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(4).toString('hex')}.tmp`);
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

export function writeAtomicSync(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export async function readText(file: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

export function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Resolve `rel` inside `root`; undefined if it would escape the root (also through symlinks). */
export function safeJoin(root: string, rel: string): string | undefined {
  const decoded = decodeURIComponent(rel).replace(/\\/g, '/');
  if (decoded.includes('\0')) return undefined;
  const full = path.resolve(root, '.' + path.posix.normalize('/' + decoded));
  const rootReal = realOr(root);
  const fullReal = realOr(full);
  if (fullReal !== rootReal && !fullReal.startsWith(rootReal + path.sep)) return undefined;
  return full;
}

function realOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    // the file may not exist yet: resolve its folder
    const dir = path.dirname(p);
    if (dir === p) return p;
    return path.join(realOr(dir), path.basename(p));
  }
}

/** Wait until a file's size and mtime stop changing (agents and editors write in several steps). */
export async function waitStable(file: string, ms = 60, tries = 20): Promise<fs.Stats | undefined> {
  let last: string | undefined;
  for (let i = 0; i < tries; i++) {
    let st: fs.Stats;
    try {
      st = await fsp.stat(file);
    } catch {
      return undefined;
    }
    const key = `${st.size}:${st.mtimeMs}`;
    if (key === last) return st;
    last = key;
    await new Promise((r) => setTimeout(r, ms));
  }
  try {
    return await fsp.stat(file);
  } catch {
    return undefined;
  }
}

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

export function mimeOf(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}
