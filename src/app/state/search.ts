// Search over a project: ids, captions, banners, the words inside screens, notes, sections and arrow labels. Pure, so
// the palette stays instant and the matching is unit-tested.
import { HISTORY_PAGE } from '../../core/actions.ts';
import { findStatus } from '../../core/status.ts';
import type { Id } from '../../core/types.ts';
import type { ProjectModel } from './project.ts';

export interface Hit {
  page: string;
  id: Id;
  kind: 'screen' | 'note' | 'arrow' | 'section';
  label: string;
  title: string;
  snippet?: [string, string, string];
  score: number;
}

/** Lower case without accents or variation selectors. */
export const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** `norm(s)` plus, for every position in it, the position in `s` it came from (removing marks shifts indexes). */
export interface Normed {
  n: string;
  map: number[];
}
export function normMap(s: string): Normed {
  let n = '';
  const map: number[] = [];
  let i = 0;
  for (const ch of s) {
    const c = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (let k = 0; k < c.length; k++) map.push(i);
    n += c;
    i += ch.length;
  }
  map.push(s.length);
  return { n, map };
}

// screen texts are long and searched on every keystroke: normalize each one once
const normed = new WeakMap<object, Map<string, Normed>>();
function normedText(text: Record<string, string>, sid: string): Normed | undefined {
  const t = text[sid];
  if (!t) return undefined;
  let m = normed.get(text);
  if (!m) {
    m = new Map();
    normed.set(text, m);
  }
  let v = m.get(sid);
  if (!v) {
    v = normMap(t);
    m.set(sid, v);
  }
  return v;
}

/** Find `nq` (already normalized) in `s`; the snippet is cut from the original text around the match. */
function find(s: string, nq: string, pre?: Normed): Hit['snippet'] | undefined {
  const { n, map } = pre ?? normMap(s);
  const at = n.indexOf(nq);
  if (at < 0) return undefined;
  const a = map[at]!;
  const b = map[at + nq.length] ?? s.length;
  const start = Math.max(0, a - 14);
  const end = Math.min(s.length, b + 48);
  const clean = (x: string) => x.replace(/\s+/g, ' ');
  return [
    (start > 0 ? '…' : '') + clean(s.slice(start, a)),
    s.slice(a, b),
    clean(s.slice(b, end)) + (end < s.length ? '…' : ''),
  ];
}

/** All matches for `q` in a project (pure apart from the inputs; tested). */
export function searchProject(
  project: Pick<ProjectModel, 'docs' | 'screens'>,
  text: Record<string, string>,
  q: string,
  limit = 1000,
): Hit[] {
  const nq = norm(q.trim());
  if (!nq) return [];
  const hits: Hit[] = [];
  const docs = project.docs;
  for (const pid of docs.project.pages) {
    if (pid === HISTORY_PAGE) continue;
    const page = docs.pages[pid];
    if (!page) continue;
    for (const [id, it] of Object.entries(page.items)) {
      if (it.archived) continue;
      if (it.kind === 'screen') {
        const sid = it.screen ?? id;
        const title = it.title ?? project.screens[sid]?.title ?? '';
        const nid = norm(id);
        let score = 0;
        let snip: Hit['snippet'];
        if (nid === nq) score = 100;
        else if (nid.startsWith(nq)) score = 80;
        else if (norm(title).includes(nq)) score = 60;
        else {
          const st = it.status ? findStatus(docs.project, it.status) : undefined;
          snip = find(it.banner ?? '', nq) ?? find(st?.label ?? '', nq);
          if (snip) score = 45;
          else {
            snip = find(text[sid] ?? '', nq, normedText(text, sid));
            if (snip) score = 30;
          }
        }
        if (score)
          hits.push({ page: pid, id, kind: 'screen', label: id, title, score, ...(snip ? { snippet: snip } : {}) });
      } else if (it.kind === 'note' || it.kind === 'text') {
        const snip = find(it.text, nq);
        if (snip)
          hits.push({
            page: pid,
            id,
            kind: 'note',
            label: it.kind === 'note' ? 'note' : 'text',
            title: it.kind === 'note' && it.anchor ? `on ${it.anchor}` : '',
            snippet: snip,
            score: 20,
          });
      } else if (it.kind === 'section' && norm(it.title).includes(nq)) {
        hits.push({ page: pid, id, kind: 'section', label: 'section', title: it.title, score: 50 });
      }
    }
    for (const a of Object.values(page.arrows)) {
      const snip = find(a.label ?? '', nq);
      if (snip)
        hits.push({
          page: pid,
          id: a.from,
          kind: 'arrow',
          label: 'arrow',
          title: `${a.from} → ${a.to}`,
          snippet: snip,
          score: 15,
        });
    }
  }
  const pageOrder = new Map(docs.project.pages.map((p, i) => [p, i]));
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      (pageOrder.get(a.page) ?? 0) - (pageOrder.get(b.page) ?? 0) ||
      a.id.localeCompare(b.id, undefined, { numeric: true }),
  );
  return hits.slice(0, limit);
}
