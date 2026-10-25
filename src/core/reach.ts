// How a screen is reached: arrows on its own page, and portals (on any page) that stand for it. A source of truth
// draws every screen once and reaches it from other flows through portals, so these must be easy to see and check.
import type { Id, PageDoc } from './types.ts';

/** A portal's target as page + item id ("S6" means the portal's own page). */
export function portalTarget(page: string, target: string): { page: string; id: Id } {
  const m = target.match(/^page:([^/]+)\/(.+)$/);
  return m ? { page: m[1]!, id: m[2]! } : { page, id: target };
}

export interface PortalRef {
  /** Page and id of the portal. */
  page: string;
  id: Id;
  /** Its first text line. */
  text: string;
  /** Items whose arrows lead into the portal. */
  from: Id[];
}

/** Every live portal, keyed by the item it stands for ("page/id"). */
export function portalIndex(pages: Record<string, PageDoc>): Map<string, PortalRef[]> {
  const out = new Map<string, PortalRef[]>();
  for (const [pid, p] of Object.entries(pages)) {
    if (p.kind === 'history') continue;
    for (const [iid, it] of Object.entries(p.items)) {
      if (it.kind !== 'portal' || !it.target || it.archived) continue;
      const t = portalTarget(pid, it.target);
      const key = `${t.page}/${t.id}`;
      const from = Object.values(p.arrows)
        .filter((a) => a.to === iid)
        .map((a) => a.from);
      if (!out.has(key)) out.set(key, []);
      out.get(key)!.push({ page: pid, id: iid, text: (it.text ?? '').split('\n')[0] ?? '', from });
    }
  }
  return out;
}

/** Portals on any page that stand for `id` on `page`. */
export function portalsTo(pages: Record<string, PageDoc>, page: string, id: Id): PortalRef[] {
  return portalIndex(pages).get(`${page}/${id}`) ?? [];
}
