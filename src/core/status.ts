import type { ArrowStyleDef, PageDoc, ProjectDoc, StatusDef, StatusRole } from './types.ts';

/** The statuses every new project starts with. Projects can edit, reorder and add their own. */
export const DEFAULT_STATUSES: StatusDef[] = [
  { id: 'approved', label: 'Approved', color: '#45C08A', role: 'approved', banner: false, createdBy: 'builtin' },
  { id: 'new', label: 'New', color: '#E58A64', role: 'review', createdBy: 'builtin' },
  // after a fix: the agent says what changed in the banner, the person looks again
  { id: 'changed', label: 'Changed', color: '#B79CFF', role: 'review', createdBy: 'builtin' },
  { id: 'to-decide', label: 'To decide', color: '#FFD43B', role: 'review', createdBy: 'builtin' },
  { id: 'needs-fix', label: 'Needs a fix', color: '#FF9F43', role: 'todo', createdBy: 'builtin' },
  { id: 'missing', label: 'Missing', color: '#FFD43B', role: 'todo', createdBy: 'builtin' },
  { id: 'existing', label: 'Already built', color: '#5A5A54', role: 'existing', createdBy: 'builtin' },
];

export const DEFAULT_ARROW_STYLES: Record<string, ArrowStyleDef> = {
  flow: { label: 'Flow', color: '#8C8C8C' },
  new: { label: 'New step', color: '#E0B400', dash: [6, 6] },
  proposal: { label: 'Proposal', color: '#8C8C8C', dash: [6, 6], nav: false },
  loop: { label: 'Loop', color: '#8BE34A' },
};

/** The 7 colours offered when a person creates a status. */
export const STATUS_SWATCHES = ['#FFD43B', '#FF9F43', '#FF6B6B', '#8DB6FF', '#B79CFF', '#7FD69B', '#9A9A93'];

export function statusesOf(project: Pick<ProjectDoc, 'statuses'> | undefined): StatusDef[] {
  return project?.statuses?.length ? project.statuses : DEFAULT_STATUSES;
}

export function findStatus(
  project: Pick<ProjectDoc, 'statuses'> | undefined,
  id: string | undefined,
): StatusDef | undefined {
  if (!id) return undefined;
  return statusesOf(project).find((s) => s.id === id);
}

export function arrowStylesOf(project: Pick<ProjectDoc, 'arrowStyles'> | undefined): Record<string, ArrowStyleDef> {
  return { ...DEFAULT_ARROW_STYLES, ...(project?.arrowStyles ?? {}) };
}

export function arrowStyle(
  project: Pick<ProjectDoc, 'arrowStyles'> | undefined,
  id: string | undefined,
): ArrowStyleDef {
  const all = arrowStylesOf(project);
  return all[id ?? 'flow'] ?? all.flow!;
}

/** Whether a banner is drawn above the screen. Unknown status ids still get a banner, so typos are visible. */
export function showsBanner(project: Pick<ProjectDoc, 'statuses'> | undefined, statusId: string | undefined): boolean {
  if (!statusId) return false;
  const s = findStatus(project, statusId);
  if (!s) return true;
  return s.banner !== false;
}

function luminance(hex: string): number {
  const m = hex.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  if (!m) return 0.5;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => {
    const c = Number.parseInt(h!, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Dark or light text, whichever reads better on the colour. */
export function inkFor(color: string): string {
  return luminance(color) > 0.32 ? '#1F1A0A' : '#F4F4F0';
}

export function statusInk(s: StatusDef): string {
  return s.ink ?? inkFor(s.color);
}

export function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'status'
  );
}

export interface StatusCount {
  id: string;
  label: string;
  role: StatusRole | 'none';
  count: number;
}

/** Counts per status for the screens in a page, optionally limited to one section. */
export function countStatuses(
  project: Pick<ProjectDoc, 'statuses'> | undefined,
  page: Pick<PageDoc, 'items'>,
  parent?: string,
): StatusCount[] {
  const counts = new Map<string, number>();
  for (const it of Object.values(page.items)) {
    if (it.kind !== 'screen' || it.archived) continue;
    if (parent !== undefined && it.parent !== parent) continue;
    const key = it.status ?? '';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out: StatusCount[] = [];
  for (const s of statusesOf(project)) {
    const n = counts.get(s.id);
    if (n) out.push({ id: s.id, label: s.label, role: s.role, count: n });
    counts.delete(s.id);
  }
  for (const [id, n] of counts) out.push({ id, label: id || 'No status', role: 'none', count: n });
  return out;
}

/** "3 approved · 1 as today · 1 to decide" */
export function countsText(counts: StatusCount[]): string {
  return counts.map((c) => `${c.count} ${c.label.toLowerCase()}`).join(' · ');
}
