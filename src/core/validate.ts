// Structural checks over a whole project: schema problems, dangling references, unknown statuses and styles,
// navigation arrows without a label. File-level checks (screen files, scripts, CSS lints) live in the node layer.

import { portalIndex, portalTarget } from './reach.ts';
import { issuesOf, PageSchema, ProjectSchema } from './schema.ts';
import { arrowStylesOf, statusesOf } from './status.ts';
import type { PageDoc, ProjectDoc } from './types.ts';

export type Level = 'error' | 'warning' | 'info';

export interface Problem {
  level: Level;
  code: string;
  message: string;
  page?: string;
  id?: string;
  file?: string;
  line?: number;
}

export function validateProjectDoc(raw: unknown): Problem[] {
  const r = ProjectSchema.safeParse(raw);
  if (r.success) return [];
  return issuesOf(r.error).map((i) => ({
    level: 'error',
    code: 'schema',
    file: 'project.json',
    message: `${i.path || '(root)'}: ${i.message}`,
  }));
}

export function validatePageDoc(pageId: string, raw: unknown): Problem[] {
  const r = PageSchema.safeParse(raw);
  if (r.success) return [];
  return issuesOf(r.error).map((i) => ({
    level: 'error',
    code: 'schema',
    page: pageId,
    file: `pages/${pageId}.json`,
    message: `${i.path || '(root)'}: ${i.message}`,
  }));
}

export function validateRefs(project: ProjectDoc, pages: Record<string, PageDoc>): Problem[] {
  const out: Problem[] = [];
  const statuses = new Set(statusesOf(project).map((s) => s.id));
  const styles = arrowStylesOf(project);
  for (const pid of project.pages)
    if (!pages[pid])
      out.push({
        level: 'error',
        code: 'missing-page',
        page: pid,
        message: `project.json lists page "${pid}" but pages/${pid}.json is missing`,
      });
  for (const pid of Object.keys(pages))
    if (!project.pages.includes(pid))
      out.push({
        level: 'warning',
        code: 'unlisted-page',
        page: pid,
        message: `pages/${pid}.json is not listed in project.json "pages"`,
      });
  if (project.sourceOfTruth && !project.pages.includes(project.sourceOfTruth))
    out.push({
      level: 'error',
      code: 'bad-source-of-truth',
      message: `sourceOfTruth "${project.sourceOfTruth}" is not a page`,
    });
  const reached = portalIndex(pages);
  const truthPage = project.sourceOfTruth ?? project.pages[0];
  for (const [pid, page] of Object.entries(pages)) {
    const items = page.items ?? {};
    for (const [id, it] of Object.entries(items)) {
      if (it.parent !== undefined) {
        const p = items[it.parent];
        if (!p)
          out.push({
            level: 'error',
            code: 'dangling-parent',
            page: pid,
            id,
            message: `${id}: parent "${it.parent}" does not exist`,
          });
        else if (p.kind !== 'section')
          out.push({
            level: 'error',
            code: 'parent-not-section',
            page: pid,
            id,
            message: `${id}: parent "${it.parent}" is a ${p.kind}, not a section`,
          });
        else {
          const seen = new Set([id]);
          let cur: string | undefined = it.parent;
          while (cur) {
            if (seen.has(cur)) {
              out.push({
                level: 'error',
                code: 'parent-cycle',
                page: pid,
                id,
                message: `${id}: sections contain each other in a cycle`,
              });
              break;
            }
            seen.add(cur);
            cur = items[cur]?.parent;
          }
        }
      }
      if (it.kind === 'screen') {
        if (it.status && !statuses.has(it.status))
          out.push({
            level: 'warning',
            code: 'unknown-status',
            page: pid,
            id,
            message: `${id}: status "${it.status}" is not defined in project.json`,
          });
        // an archived option keeps proposalFor so a restore can make it an option again; that screen is on the
        // page it came from, not on History
        if (it.proposalFor !== undefined && !it.archived && !items[it.proposalFor])
          out.push({
            level: 'error',
            code: 'dangling-proposal',
            page: pid,
            id,
            message: `${id}: proposalFor "${it.proposalFor}" does not exist on this page`,
          });
      }
      if (it.kind === 'note' && it.anchor !== undefined && !it.archived && !items[it.anchor])
        out.push({
          level: 'warning',
          code: 'dangling-anchor',
          page: pid,
          id,
          message: `${id}: anchor "${it.anchor}" does not exist`,
        });
      if (it.kind === 'portal' && !it.archived && page.kind !== 'history') {
        if (!it.target)
          out.push({
            level: 'warning',
            code: 'portal-no-target',
            page: pid,
            id,
            message: `${id}: the portal leads nowhere (give it a target with adl portal --to)`,
          });
        else {
          const t = portalTarget(pid, it.target);
          const target = pages[t.page]?.items[t.id];
          if (!target)
            out.push({
              level: 'warning',
              code: 'dangling-portal',
              page: pid,
              id,
              message: `${id}: portal target "${it.target}" does not exist`,
            });
          else if (target.kind !== 'screen' && target.kind !== 'portal')
            out.push({
              level: 'warning',
              code: 'portal-not-screen',
              page: pid,
              id,
              message: `${id}: the portal points at a ${target.kind} ("${it.target}"), not a screen: present mode and the handoff cannot follow it`,
            });
        }
      }
      // a screen nothing leads to: no arrow, no portal, not a start. Checked on the source-of-truth page, the spec
      // that must be connected (other pages hold explorations and boards such as the design system)
      if (it.kind === 'screen' && !it.archived && pid === truthPage && !it.entry) {
        const arrowIn = Object.values(page.arrows ?? {}).some((a) => a.to === id && a.from !== id);
        if (!arrowIn && !reached.get(`${pid}/${id}`)?.length)
          out.push({
            level: 'warning',
            code: 'unreached',
            page: pid,
            id,
            message: `${id}: nothing leads here (no arrow, no portal, not a start)`,
          });
      }
    }
    for (const [aid, a] of Object.entries(page.arrows ?? {})) {
      if (!items[a.from])
        out.push({
          level: 'error',
          code: 'dangling-arrow',
          page: pid,
          id: aid,
          message: `arrow ${aid}: "from" item "${a.from}" does not exist`,
        });
      if (!items[a.to])
        out.push({
          level: 'error',
          code: 'dangling-arrow',
          page: pid,
          id: aid,
          message: `arrow ${aid}: "to" item "${a.to}" does not exist`,
        });
      if (a.style && !styles[a.style])
        out.push({
          level: 'warning',
          code: 'unknown-arrow-style',
          page: pid,
          id: aid,
          message: `arrow ${aid}: style "${a.style}" is not defined`,
        });
      const nav = (styles[a.style ?? 'flow'] ?? styles.flow)?.nav !== false;
      if (nav && !a.label?.trim())
        out.push({
          level: 'warning',
          code: 'unlabelled-arrow',
          page: pid,
          id: aid,
          message: `arrow ${aid}: navigation arrows need a label (what the person taps, or the condition)`,
        });
    }
  }
  return out;
}
