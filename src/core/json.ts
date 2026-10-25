// Canonical JSON for ADL documents: stable key order, one item/arrow/status per line, whole-number geometry.
// The same document always produces the same bytes, so git diffs stay small and writes can be detected by hash.

const ITEM_ORDER = [
  'kind',
  'screen',
  'src',
  'frame',
  'parent',
  'x',
  'y',
  'w',
  'h',
  'z',
  'title',
  'text',
  'size',
  'color',
  'status',
  'banner',
  'entry',
  'proposalFor',
  'anchor',
  'target',
  'by',
  'resolved',
  'pinned',
  'archived',
];
const ARROW_ORDER = ['from', 'to', 'label', 'style', 'trigger', 'fromEl', 'fromSide', 'toSide', 'waypoints'];
const PAGE_ORDER = ['$schema', 'adl', 'rev', 'name', 'kind'];
const PAGE_TAIL = ['items', 'arrows'];
const PROJECT_ORDER = [
  '$schema',
  'adl',
  'rev',
  'name',
  'pages',
  'sourceOfTruth',
  'frame',
  'presets',
  'styles',
  'fonts',
  'statuses',
  'defaultStatus',
  'arrowStyles',
  'snapshotAt',
];
const STATUS_ORDER = ['id', 'label', 'color', 'ink', 'role', 'banner', 'createdBy'];
const GEOMETRY = new Set(['x', 'y', 'w', 'h']);

function ordered(obj: Record<string, unknown>, order: string[], tail: string[] = []): string[] {
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  const head = order.filter((k) => keys.includes(k));
  const rest = keys.filter((k) => !order.includes(k) && !tail.includes(k)).sort();
  return [...head, ...rest, ...tail.filter((k) => keys.includes(k))];
}

function num(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}

/** One-line JSON with `": "` and `", "` separators and an optional key order. */
export function inline(v: unknown, order?: string[], round = false): string {
  if (v === null) return 'null';
  if (typeof v === 'number') return num(round ? Math.round(v) : v);
  if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map((x) => inline(x, undefined, round)).join(', ') + ']';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = order ? ordered(o, order) : Object.keys(o).filter((k) => o[k] !== undefined);
    if (!keys.length) return '{}';
    return (
      '{' +
      keys.map((k) => JSON.stringify(k) + ': ' + inline(o[k], undefined, round || GEOMETRY.has(k))).join(', ') +
      '}'
    );
  }
  return 'null';
}

function roundItem(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) out[k] = GEOMETRY.has(k) && typeof v === 'number' ? Math.round(v) : v;
  return out;
}

function mapBlock(map: Record<string, unknown>, order: string[], indent: string, round: boolean): string {
  const ids = Object.keys(map).filter((k) => map[k] !== undefined);
  if (!ids.length) return '{}';
  const lines = ids.map((id) => {
    const v = map[id] as Record<string, unknown>;
    const val = round ? roundItem(v) : v;
    return `${indent}  ${JSON.stringify(id)}: ${inline(val, order)}`;
  });
  return '{\n' + lines.join(',\n') + `\n${indent}}`;
}

function arrowLine(a: Record<string, unknown>): Record<string, unknown> {
  const out = { ...a };
  if (Array.isArray(out.waypoints))
    out.waypoints = (out.waypoints as number[][]).map((p) => p.map((n) => Math.round(n)));
  return out;
}

export function stringifyPage(doc: Record<string, unknown>): string {
  const keys = ordered(doc, PAGE_ORDER, PAGE_TAIL);
  const parts = keys.map((k) => {
    if (k === 'items')
      return `  "items": ${mapBlock((doc.items ?? {}) as Record<string, unknown>, ITEM_ORDER, '  ', true)}`;
    if (k === 'arrows') {
      const arrows = Object.fromEntries(
        Object.entries((doc.arrows ?? {}) as Record<string, Record<string, unknown>>).map(([id, a]) => [
          id,
          arrowLine(a),
        ]),
      );
      return `  "arrows": ${mapBlock(arrows, ARROW_ORDER, '  ', false)}`;
    }
    return `  ${JSON.stringify(k)}: ${inline(doc[k])}`;
  });
  return '{\n' + parts.join(',\n') + '\n}\n';
}

export function stringifyProject(doc: Record<string, unknown>): string {
  const keys = ordered(doc, PROJECT_ORDER);
  const parts = keys.map((k) => {
    const v = doc[k];
    if (k === 'statuses' && Array.isArray(v)) {
      if (!v.length) return '  "statuses": []';
      return '  "statuses": [\n' + v.map((s) => '    ' + inline(s, STATUS_ORDER)).join(',\n') + '\n  ]';
    }
    if ((k === 'presets' || k === 'arrowStyles') && v && typeof v === 'object') {
      return `  ${JSON.stringify(k)}: ${mapBlock(v as Record<string, unknown>, ['label', 'w', 'h', 'color', 'dash', 'width', 'nav', 'radius', 'background'], '  ', false)}`;
    }
    return `  ${JSON.stringify(k)}: ${inline(v)}`;
  });
  return '{\n' + parts.join(',\n') + '\n}\n';
}

export interface JsonError {
  message: string;
  line: number;
  col: number;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: JsonError };

/** Position of the first syntax error, found with a small strict scanner (V8 no longer reports positions). */
export function findJsonError(text: string): { pos: number; expected: string } {
  let i = 0;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const fail = (expected: string): never => {
    throw { pos: i, expected };
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      ws();
      if (text[i] === '}') {
        i++;
        return;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('a "quoted" key');
        str();
        ws();
        if (text[i] !== ':') fail('":" after the key');
        i++;
        value();
        ws();
        if (text[i] === ',') {
          i++;
          ws();
          if (text[i] === '}') fail('another key (no trailing comma allowed)');
          continue;
        }
        if (text[i] === '}') {
          i++;
          return;
        }
        fail('"," or "}"');
      }
    }
    if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') {
        i++;
        return;
      }
      for (;;) {
        value();
        ws();
        if (text[i] === ',') {
          i++;
          ws();
          if (text[i] === ']') fail('another value (no trailing comma allowed)');
          continue;
        }
        if (text[i] === ']') {
          i++;
          return;
        }
        fail('"," or "]"');
      }
    }
    if (c === '"') {
      str();
      return;
    }
    const m = text.slice(i).match(/^(-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?|true|false|null)/);
    if (!m) fail('a value');
    i += m![0].length;
  };
  const str = () => {
    i++;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === '\\') i += 2;
      else if (ch === '"') {
        i++;
        return;
      } else if (ch === '\n') fail('a closing quote');
      else i++;
    }
    fail('a closing quote');
  };
  try {
    value();
    ws();
    if (i < text.length) fail('the end of the file');
  } catch (e) {
    return e as { pos: number; expected: string };
  }
  return { pos: -1, expected: '' };
}

/** JSON.parse with a line/column for errors (agents fix files faster when told where). */
export function parseJson<T = unknown>(text: string): ParseResult<T> {
  const clean = text.replace(/^\uFEFF/, '');
  try {
    return { ok: true, value: JSON.parse(clean) as T };
  } catch (e) {
    if (!clean.trim()) return { ok: false, error: { message: 'The file is empty', line: 1, col: 1 } };
    const { pos, expected } = findJsonError(clean);
    const at = pos < 0 ? clean.length : pos;
    const before = clean.slice(0, at);
    const line = before.split('\n').length;
    const col = at - before.lastIndexOf('\n');
    const raw = e instanceof Error ? e.message.split('\n')[0]! : String(e);
    return { ok: false, error: { message: expected ? `Expected ${expected}` : raw, line, col } };
  }
}

/** Deep structural equality for JSON values (key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => jsonEqual(v, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => jsonEqual(ao[k], bo[k]));
}

export function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}
