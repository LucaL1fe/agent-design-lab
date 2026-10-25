// Every change to the documents is a list of path-based set operations. They are applied to an immutable snapshot
// (copy-on-write along the changed path) and carry the previous value, so every transaction can be inverted.
import { clone, jsonEqual } from './json.ts';
import type { Actor, PageDoc, ProjectDoc } from './types.ts';

/** "project" or "page:<pageId>". */
export type DocKey = 'project' | `page:${string}`;

export interface SetOp {
  doc: DocKey;
  /** Path inside the document. [] replaces the whole document (create / delete a page). */
  path: readonly string[];
  /** New value; undefined deletes the key (or the page). */
  value?: unknown;
  /** Value before the op (filled in by applyOps). */
  prev?: unknown;
}

export interface Transaction {
  id: string;
  actor: Actor;
  ops: SetOp[];
  summary?: string;
  at?: string;
}

export interface Docs {
  project: ProjectDoc;
  pages: Record<string, PageDoc>;
}

export function pageKey(pageId: string): DocKey {
  return `page:${pageId}`;
}

export function pageIdOf(doc: DocKey): string | undefined {
  return doc.startsWith('page:') ? doc.slice(5) : undefined;
}

export function getIn(obj: unknown, path: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** Copy-on-write set. Intermediate objects are created when missing; `undefined` deletes the key. */
export function setIn<T>(obj: T, path: readonly string[], value: unknown): T {
  if (!path.length) return value as T;
  const [head, ...rest] = path as [string, ...string[]];
  const src = (obj && typeof obj === 'object' ? obj : {}) as Record<string, unknown>;
  const copy: Record<string, unknown> = Array.isArray(src)
    ? ([...src] as unknown as Record<string, unknown>)
    : { ...src };
  if (!rest.length) {
    if (value === undefined) delete copy[head];
    else copy[head] = value;
  } else {
    const next = setIn(src[head], rest, value);
    if (next === undefined) delete copy[head];
    else copy[head] = next;
  }
  return copy as T;
}

function readDoc(docs: Docs, key: DocKey): unknown {
  if (key === 'project') return docs.project;
  return docs.pages[pageIdOf(key)!];
}

function writeDoc(docs: Docs, key: DocKey, value: unknown): Docs {
  if (key === 'project') return { ...docs, project: value as ProjectDoc };
  const id = pageIdOf(key)!;
  const pages = { ...docs.pages };
  if (value === undefined) delete pages[id];
  else pages[id] = value as PageDoc;
  return { ...docs, pages };
}

export interface ApplyResult {
  docs: Docs;
  /** The ops with `prev` filled in; no-op ops (value equal to prev) are dropped. */
  ops: SetOp[];
  /** Documents that changed. */
  touched: Set<DocKey>;
}

export function applyOps(docs: Docs, ops: readonly SetOp[]): ApplyResult {
  let cur = docs;
  const done: SetOp[] = [];
  const touched = new Set<DocKey>();
  for (const op of ops) {
    const doc = readDoc(cur, op.doc);
    if (op.path.length && doc === undefined) continue; // the page is gone; nothing to change
    let path = op.path;
    let value = op.value;
    // setting below a missing object: record the op at the first missing level, so undo removes what it created
    for (let k = 1; k < path.length; k++) {
      const v = getIn(doc, path.slice(0, k));
      if (v === undefined || v === null || typeof v !== 'object') {
        if (value === undefined) {
          path = [];
          break;
        }
        value = setIn(undefined, path.slice(k), value);
        path = path.slice(0, k);
        break;
      }
    }
    if (op.path.length && !path.length) continue; // deleting inside something that does not exist
    const prev = path.length ? getIn(doc, path) : doc;
    if (jsonEqual(prev, value)) continue;
    const next = path.length ? setIn(doc, path, clone(value)) : clone(value);
    cur = writeDoc(cur, op.doc, next);
    done.push({ doc: op.doc, path: [...path], value: clone(value), prev: clone(prev) });
    touched.add(op.doc);
  }
  return { docs: cur, ops: done, touched };
}

/** The ops that undo `ops` (reverse order, value and prev swapped). */
export function invertOps(ops: readonly SetOp[]): SetOp[] {
  return [...ops].reverse().map((op) => ({ doc: op.doc, path: [...op.path], value: op.prev, prev: op.value }));
}

/**
 * Undo that respects later changes by others: an op is only undone while the current value still equals what this
 * transaction wrote. Returns the inverse ops that can be applied and the paths that were skipped.
 */
export function safeInverse(docs: Docs, ops: readonly SetOp[]): { ops: SetOp[]; skipped: SetOp[] } {
  const apply: SetOp[] = [];
  const skipped: SetOp[] = [];
  let cur = docs;
  for (const op of [...ops].reverse()) {
    const doc = readDoc(cur, op.doc);
    const now = op.path.length ? getIn(doc, op.path) : doc;
    if (jsonEqual(now, op.value)) {
      const inv: SetOp = { doc: op.doc, path: [...op.path], value: op.prev, prev: op.value };
      apply.push(inv);
      cur = applyOps(cur, [inv]).docs;
    } else skipped.push(op);
  }
  return { ops: apply, skipped };
}

/** Readable path for logs: page:truth items.T4.status */
export function opLabel(op: SetOp): string {
  return `${op.doc} ${op.path.join('.') || '(document)'}`;
}

/** Ops that turn document `a` into document `b`, at item/arrow-field granularity for pages. */
export function diffDoc(key: DocKey, a: unknown, b: unknown): SetOp[] {
  if (a === undefined || b === undefined || a === null || b === null) {
    return jsonEqual(a, b) ? [] : [{ doc: key, path: [], value: clone(b), prev: clone(a) }];
  }
  const ops: SetOp[] = [];
  const walk = (x: unknown, y: unknown, path: string[], depth: number) => {
    if (jsonEqual(x, y)) return;
    const isObj = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v);
    if (depth < 3 && isObj(x) && isObj(y)) {
      const xo = x as Record<string, unknown>;
      const yo = y as Record<string, unknown>;
      for (const k of new Set([...Object.keys(xo), ...Object.keys(yo)])) walk(xo[k], yo[k], [...path, k], depth + 1);
      return;
    }
    ops.push({ doc: key, path, value: clone(y), prev: clone(x) });
  };
  walk(a, b, [], 0);
  return ops;
}
