// Three-way merge of JSON documents. Used when an agent writes a page file while a person was editing the same page:
// base = the version the agent read, ours = the server's current version, theirs = what the agent wrote.
import { clone, jsonEqual } from './json.ts';

export interface Conflict {
  path: string[];
  base: unknown;
  ours: unknown;
  theirs: unknown;
  /** Which side's value was kept. */
  kept: 'ours' | 'theirs';
  reason: string;
}

export interface MergePolicy {
  /** When both sides changed the same value: return true to keep ours (default: theirs wins). */
  oursWins?: (path: string[], ours: unknown, theirs: unknown) => boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export function merge3(
  base: unknown,
  ours: unknown,
  theirs: unknown,
  policy: MergePolicy = {},
): { value: unknown; conflicts: Conflict[] } {
  const conflicts: Conflict[] = [];
  const rec = (b: unknown, o: unknown, t: unknown, path: string[]): unknown => {
    if (jsonEqual(o, t)) return clone(o);
    if (jsonEqual(b, o)) return clone(t);
    if (jsonEqual(b, t)) return clone(o);
    // both sides changed this value, differently
    if (o === undefined || t === undefined) {
      // one side deleted, the other changed it: the delete wins
      conflicts.push({
        path,
        base: b,
        ours: o,
        theirs: t,
        kept: o === undefined ? 'ours' : 'theirs',
        reason: 'deleted on one side, changed on the other',
      });
      return undefined;
    }
    if (isObj(o) && isObj(t) && (b === undefined || isObj(b))) {
      if (
        path.length === 2 &&
        (path[0] === 'items' || path[0] === 'arrows') &&
        'kind' in o &&
        'kind' in t &&
        o.kind !== t.kind
      ) {
        conflicts.push({
          path,
          base: b,
          ours: o,
          theirs: t,
          kept: 'theirs',
          reason: 'both sides created different items with the same id',
        });
        return clone(t);
      }
      const bo = (b ?? {}) as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of new Set([...Object.keys(o), ...Object.keys(t), ...Object.keys(bo)])) {
        const v = rec(bo[k], o[k], t[k], [...path, k]);
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    const keepOurs = policy.oursWins?.(path, o, t) ?? false;
    conflicts.push({
      path,
      base: b,
      ours: o,
      theirs: t,
      kept: keepOurs ? 'ours' : 'theirs',
      reason: 'both sides changed this value',
    });
    return clone(keepOurs ? o : t);
  };
  return { value: rec(base, ours, theirs, []), conflicts };
}

const GEOMETRY_FIELDS = new Set(['x', 'y', 'w', 'h', 'parent', 'fromSide', 'toSide', 'waypoints', 'anchor']);

/**
 * Page merge policy: the agent's write wins, except the geometry of items a person placed by hand (pinned on our side)
 * — so an agent rewriting a stale file never undoes a drag.
 */
export function mergePage(base: unknown, ours: unknown, theirs: unknown): { value: unknown; conflicts: Conflict[] } {
  const oursDoc = ours as {
    items?: Record<string, { pinned?: boolean }>;
    arrows?: Record<string, { pinned?: boolean }>;
  };
  return merge3(base, ours, theirs, {
    oursWins: (path) => {
      if (path.length !== 3) return false;
      const [coll, id, field] = path as [string, string, string];
      if (!GEOMETRY_FIELDS.has(field)) return false;
      if (coll === 'items') return oursDoc?.items?.[id]?.pinned === true;
      if (coll === 'arrows') return oursDoc?.arrows?.[id]?.pinned === true;
      return false;
    },
  });
}
