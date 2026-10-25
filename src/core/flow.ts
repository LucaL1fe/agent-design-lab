// Screens in the order a person meets them: entry screens first, then breadth first along navigation arrows
// (proposal links are not paths). Used by renders, present mode and the handoff.
import { arrowStylesOf } from './status.ts';
import type { Id, PageDoc, ProjectDoc, ScreenItem } from './types.ts';

/** Screens of a page (or one section) in flow order. */
export function screensInFlow(page: PageDoc, project?: Pick<ProjectDoc, 'arrowStyles'>, section?: Id): Id[] {
  const ids = Object.entries(page.items)
    .filter(([, it]) => it.kind === 'screen' && !it.archived && (!section || it.parent === section))
    .map(([id]) => id);
  return flowOrder(page, ids, undefined, project);
}

/** `ids` in flow order; with `start`, only the screens reachable from it. */
export function flowOrder(page: PageDoc, ids: Id[], start?: Id, project?: Pick<ProjectDoc, 'arrowStyles'>): Id[] {
  const want = new Set(ids);
  const next = new Map<Id, Id[]>();
  const hasIn = new Set<Id>();
  const styles = arrowStylesOf(project);
  for (const a of Object.values(page.arrows)) {
    if (styles[a.style ?? 'flow']?.nav === false) continue;
    if (!next.has(a.from)) next.set(a.from, []);
    next.get(a.from)!.push(a.to);
    hasIn.add(a.to);
  }
  const out: Id[] = [];
  const seen = new Set<Id>();
  const walk = (root: Id) => {
    const q = [root];
    while (q.length) {
      const id = q.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (want.has(id)) out.push(id);
      q.push(...(next.get(id) ?? []).filter((n) => want.has(n)));
    }
  };
  if (start) walk(start);
  else {
    for (const id of ids) if ((page.items[id] as ScreenItem).entry) walk(id);
    for (const id of ids) if (!hasIn.has(id)) walk(id);
    for (const id of ids) walk(id);
  }
  return out;
}
