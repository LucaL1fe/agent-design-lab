// `adl handoff`: the source of truth as a build spec. Everything a builder (person or agent, in another repo) needs to
// build exactly this: HANDOFF.md (rules, flows, every screen with its transitions, requirements, animations and copy),
// spec.json, tokens.json (DTCG), components.md, flows.mmd, reference PNGs and the source files.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { type DefaultTreeAdapterMap, parse } from 'parse5';
import postcss from 'postcss';
import { flowOrder } from '../../core/flow.ts';
import { frameLabel, resolveFrame } from '../../core/frames.ts';
import { placePage } from '../../core/layout.ts';
import { arrowStylesOf, findStatus } from '../../core/status.ts';
import type { Arrow, Id, Item, NoteItem, PageDoc, ScreenItem, StatusRole } from '../../core/types.ts';
import type { SnapshotService } from '../snapshot/service.ts';
import type { ProjectState, WorkspaceService } from '../store/workspace.ts';
import { parseTokens, type Token, toDtcg } from './tokens.ts';

export interface Transition {
  to: Id;
  label: string;
  trigger?: Arrow['trigger'];
  /** False when the target is not part of this handoff (not approved yet). */
  included: boolean;
}

export interface HandoffScreen {
  id: Id;
  title: string;
  source: string;
  png: string;
  frame: { w: number; h: number | 'auto'; name: string };
  /** Only when the screen sets its own moment (adl:snapshot): its reference picture froze animations here. */
  snapshotAt?: number;
  status: { id: string; label: string; role: StatusRole | 'none' };
  banner?: string;
  section?: { id: Id; title: string };
  entry: boolean;
  requirements: string[];
  strings: string[];
  anchors: string[];
  animations: { selector: string; animation: string }[];
  transitions: Transition[];
  from: { id: Id; label: string }[];
}

export interface Spec {
  adl: 1;
  generated: string;
  project: { id: string; name: string };
  page: { id: string; name: string };
  snapshotAt: number;
  tokens: Token[];
  flows: { name: string; screens: Id[] }[];
  screens: HandoffScreen[];
  excluded: { id: Id; title: string; status: string; banner?: string }[];
  openNotes: { id: Id; text: string; on?: Id }[];
}

type Node = DefaultTreeAdapterMap['node'];
type El = DefaultTreeAdapterMap['element'];

/** Visible text of an HTML document in reading order, one entry per text run. */
export function stringsOf(html: string): string[] {
  const doc = parse(html);
  const out: string[] = [];
  const walk = (n: Node, hidden: boolean) => {
    if (n.nodeName === '#text') {
      const t = (n as unknown as { value: string }).value.replace(/\s+/g, ' ').trim();
      if (t && !hidden && out[out.length - 1] !== t) out.push(t);
      return;
    }
    const el = n as El;
    const tag = el.tagName;
    const skip =
      hidden ||
      tag === 'style' ||
      tag === 'script' ||
      tag === 'title' ||
      tag === 'head' ||
      el.attrs?.some((a) => a.name === 'aria-hidden' && a.value === 'true') === true;
    for (const c of (el as unknown as { childNodes?: Node[] }).childNodes ?? []) walk(c, skip);
    const tpl = (el as unknown as { content?: { childNodes: Node[] } }).content;
    if (tpl) for (const c of tpl.childNodes) walk(c, skip);
  };
  walk(doc as unknown as Node, false);
  return out;
}

/** Animation declarations in a screen's own <style> blocks. */
export function animationsOf(html: string): { selector: string; animation: string }[] {
  const out: { selector: string; animation: string }[] = [];
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    try {
      postcss.parse(m[1]!).walkDecls(/^animation(-name)?$/, (d) => {
        const rule = d.parent as postcss.Rule;
        if (rule?.type === 'rule' && d.value !== 'none') out.push({ selector: rule.selector, animation: d.value });
      });
    } catch {
      // a broken style block: the validate command reports it
    }
  }
  return out;
}

const INCLUDE_DEFAULT: StatusRole[] = ['approved', 'existing'];

export function buildSpec(
  service: WorkspaceService,
  st: ProjectState,
  opts: { page?: string; all?: boolean; statuses?: string[] } = {},
): Spec {
  const docs = st.docs;
  const pageId = opts.page ?? docs.project.sourceOfTruth ?? docs.project.pages[0];
  const page = pageId ? docs.pages[pageId] : undefined;
  if (!pageId || !page) throw new Error('This project has no source-of-truth page');
  const project = docs.project;
  const styles = arrowStylesOf(project);
  const roleOf = (it: ScreenItem) => findStatus(project, it.status)?.role ?? 'none';
  const included = (it: ScreenItem) =>
    opts.all === true ||
    (opts.statuses?.length
      ? opts.statuses.includes(it.status ?? '')
      : INCLUDE_DEFAULT.includes(roleOf(it) as StatusRole));
  const screens = Object.entries(page.items).filter(
    (e): e is [Id, ScreenItem] => e[1].kind === 'screen' && !e[1].archived,
  );
  const inSet = new Set(screens.filter(([, it]) => included(it)).map(([id]) => id));
  const titleOf = (id: Id) => {
    const it = page.items[id] as ScreenItem | undefined;
    return (it && (it.title ?? st.screens.get(it.screen ?? id)?.compiled?.title)) || id;
  };
  const nav = (a: Arrow) => styles[a.style ?? 'flow']?.nav !== false;

  // flows: one per section, in reading order on the canvas (top to bottom, left to right), then loose screens
  const placement = placePage(page, (id, it) =>
    it.kind === 'screen'
      ? service.frameSize(st, (it as ScreenItem).screen ?? id, (it as ScreenItem).frame)
      : { w: 300, h: 200 },
  );
  const at = (id: Id) => placement.rects.get(id) ?? { x: 0, y: 0, w: 0, h: 0 };
  const sections = Object.entries(page.items)
    .filter(([, it]) => it.kind === 'section' && !it.archived)
    .sort(([a], [b]) => at(a).y - at(b).y || at(a).x - at(b).x);
  const flows: Spec['flows'] = [];
  const placed = new Set<Id>();
  for (const [sid, sec] of sections) {
    const ids = flowOrder(
      page,
      [...inSet].filter((id) => page.items[id]!.parent === sid),
      undefined,
      project,
    );
    if (ids.length) flows.push({ name: (sec as Extract<Item, { kind: 'section' }>).title, screens: ids });
    for (const id of ids) placed.add(id);
  }
  const loose = flowOrder(
    page,
    [...inSet].filter((id) => !placed.has(id)),
    undefined,
    project,
  );
  if (loose.length) flows.push({ name: sections.length ? 'Other screens' : page.name, screens: loose });

  const notesOn = new Map<Id, string[]>();
  const openNotes: Spec['openNotes'] = [];
  for (const [nid, it] of Object.entries(page.items)) {
    if (it.kind !== 'note' || it.archived || (it as NoteItem).resolved) continue;
    const n = it as NoteItem;
    if (n.anchor && inSet.has(n.anchor)) {
      if (!notesOn.has(n.anchor)) notesOn.set(n.anchor, []);
      notesOn.get(n.anchor)!.push(n.text);
    } else openNotes.push({ id: nid, text: n.text, ...(n.anchor ? { on: n.anchor } : {}) });
  }

  const order = flows.flatMap((f) => f.screens);
  const out: HandoffScreen[] = [];
  for (const id of order) {
    const it = page.items[id] as ScreenItem;
    const sid = it.screen ?? id;
    const entry = st.screens.get(sid);
    const file = entry ? path.join(st.dir, entry.file) : undefined;
    const html = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const f = resolveFrame(it.frame ?? entry?.compiled?.frame, project) ?? { w: 393, h: 852 };
    const def = findStatus(project, it.status);
    const sec = it.parent ? page.items[it.parent] : undefined;
    out.push({
      id,
      title: titleOf(id),
      source: `source/${entry?.file ?? `screens/${sid}.html`}`,
      png: `png/${id}.png`,
      frame: {
        w: f.w,
        h: f.h,
        name: frameLabel(it.frame ?? entry?.compiled?.frame ?? project.frame ?? 'iphone-16', project),
      },
      ...(entry?.compiled?.snapshotAt !== undefined ? { snapshotAt: entry.compiled.snapshotAt } : {}),
      status: { id: def?.id ?? it.status ?? '', label: def?.label ?? it.status ?? 'none', role: def?.role ?? 'none' },
      ...(it.banner ? { banner: it.banner } : {}),
      ...(sec?.kind === 'section' ? { section: { id: it.parent!, title: sec.title } } : {}),
      entry: it.entry === true,
      requirements: notesOn.get(id) ?? [],
      strings: html ? stringsOf(html) : [],
      anchors: entry?.compiled?.anchors ?? [],
      animations: html ? animationsOf(html) : [],
      transitions: Object.values(page.arrows)
        .filter((a) => a.from === id && nav(a) && page.items[a.to])
        .map((a) => ({
          to: a.to,
          label: a.label ?? '',
          ...(a.trigger ? { trigger: a.trigger } : {}),
          included: inSet.has(a.to),
        })),
      from: Object.values(page.arrows)
        .filter((a) => a.to === id && nav(a) && inSet.has(a.from))
        .map((a) => ({ id: a.from, label: a.label ?? '' })),
    });
  }
  const excluded = screens
    .filter(([id]) => !inSet.has(id))
    .map(([id, it]) => ({
      id,
      title: titleOf(id),
      status: findStatus(project, it.status)?.label ?? it.status ?? 'no status',
      ...(it.banner ? { banner: it.banner } : {}),
    }));
  const tokensFile = path.join(st.dir, 'styles', 'tokens.css');
  return {
    adl: 1,
    generated: new Date().toISOString(),
    project: { id: st.id, name: project.name },
    page: { id: pageId, name: page.name },
    snapshotAt: project.snapshotAt ?? 1200,
    tokens: fs.existsSync(tokensFile) ? parseTokens(fs.readFileSync(tokensFile, 'utf8')) : [],
    flows,
    screens: out,
    excluded,
    openNotes,
  };
}

// ---------- writing ----------

const md = (s: string) => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ');

function triggerText(t: Arrow['trigger'] | undefined): string {
  if (!t) return '';
  if (t.on === 'tap') return t.el ? `tap \`${t.el}\`` : 'tap';
  if (t.on === 'auto') return `automatically after ${(t.after ?? 0) / 1000} s`;
  if (t.on === 'condition') return t.when ? `when ${t.when}` : 'on a condition';
  return t.on + (t.when ? `, when ${t.when}` : '');
}

export function handoffMarkdown(spec: Spec, cli: string): string {
  const byId = new Map(spec.screens.map((s) => [s.id, s]));
  const name = (id: Id) => `${id} · ${byId.get(id)?.title ?? spec.excluded.find((e) => e.id === id)?.title ?? id}`;
  const L: string[] = [];
  L.push(`# Handoff: ${spec.project.name}`);
  L.push('');
  L.push(
    `The approved design of **${spec.project.name}** (page “${spec.page.name}”), generated by Agent Design Lab on ${spec.generated.slice(0, 10)}: ${spec.screens.length} screens in ${spec.flows.length} flow${spec.flows.length === 1 ? '' : 's'}. This folder is the spec: build exactly this.`,
  );
  L.push('');
  L.push('## How to build it');
  L.push('');
  L.push(
    '1. **Match the reference pictures exactly** (`png/<id>.png`, 2x): layout, spacing, type, colour, copy and the moment of every animation. The HTML and CSS in `source/` are the design itself: port its values and CSS instead of re-inventing them.',
  );
  L.push(
    '2. **Theme from the tokens** (`tokens.json`, the same values as `source/styles/tokens.css`) and build the shared components in `components.md` once.',
  );
  L.push(
    '3. **Keep the anchors:** put `data-adl-anchor="<name>"` on the elements listed per screen. The check taps them to test the transitions.',
  );
  L.push(
    '4. **Implement every transition** with its trigger, in the flows below. Use the copy as written, word for word.',
  );
  L.push(
    `5. **Verify:** copy \`adl-routes.example.json\` to \`adl-routes.json\`, fill in the URL of each screen in your app, start the app and run \`npx agent-design-lab handoff check --handoff <this folder>\`${cli !== 'npx agent-design-lab' ? ` (on the machine that made it: \`${cli} handoff check --handoff <this folder>\`)` : ''} until it passes. It compares each screen with its picture, looks for missing text and taps each transition; \`check/report.md\` and the side-by-side pictures in \`check/\` show what differs.`,
  );
  L.push(
    '6. Screens and notes listed under “Not in this handoff” are not approved yet: do not build them, and do not invent screens that are not here. When the design and the codebase disagree, ask.',
  );
  L.push('');
  // frames
  const frames = new Map<string, Id[]>();
  for (const s of spec.screens) {
    const k = `${s.frame.name}: ${s.frame.w} × ${s.frame.h === 'auto' ? 'full page height' : s.frame.h}`;
    if (!frames.has(k)) frames.set(k, []);
    frames.get(k)!.push(s.id);
  }
  L.push('## Frames');
  L.push('');
  for (const [k, ids] of frames)
    L.push(`- ${k} (${ids.length === spec.screens.length ? 'all screens' : ids.join(', ')})`);
  L.push('');
  // tokens
  if (spec.tokens.length) {
    L.push('## Design tokens');
    L.push('');
    L.push('| Token | Value | Type |');
    L.push('|---|---|---|');
    for (const t of spec.tokens) L.push(`| \`--${t.name}\` | \`${md(t.value)}\` | ${t.type} |`);
    L.push('');
  }
  // flows
  L.push('## Flows');
  L.push('');
  for (const f of spec.flows) {
    L.push(`### ${f.name}`);
    L.push('');
    for (const id of f.screens) {
      const s = byId.get(id)!;
      const ts = s.transitions.filter((t) => t.included);
      // a start: marked as the entry, or nothing in this handoff leads to it
      const start = s.entry || s.from.length === 0 ? ' (start)' : '';
      if (!ts.length) L.push(`- **${name(id)}**${start}: the flow ends here`);
      for (const t of ts)
        L.push(
          `- **${name(id)}**${start} → **${name(t.to)}**: “${md(t.label)}”${t.trigger ? ` (${triggerText(t.trigger)})` : ''}`,
        );
    }
    L.push('');
  }
  L.push('A diagram of all flows is in `flows.mmd` (Mermaid).');
  L.push('');
  // screens
  L.push('## Screens');
  L.push('');
  for (const s of spec.screens) {
    L.push(`### ${s.id} · ${s.title}`);
    L.push('');
    L.push(
      `![${s.id}](${s.png}) Reference \`${s.png}\` · source \`${s.source}\` · ${s.frame.w} × ${s.frame.h === 'auto' ? 'full height' : s.frame.h}${s.snapshotAt !== undefined ? ` · animations frozen at ${s.snapshotAt} ms` : ''}${s.section ? ` · flow “${s.section.title}”` : ''}`,
    );
    L.push('');
    if (s.requirements.length) {
      L.push('Requirements (notes on the canvas):');
      for (const r of s.requirements) L.push(`- ${md(r)}`);
      L.push('');
    }
    const ts = s.transitions;
    if (ts.length) {
      L.push('Transitions:');
      for (const t of ts)
        L.push(
          `- “${md(t.label)}”${t.trigger ? ` (${triggerText(t.trigger)})` : ''} → ${name(t.to)}${t.included ? '' : ' (not in this handoff: leave a placeholder)'}`,
        );
      L.push('');
    }
    if (s.from.length) L.push(`Comes from: ${s.from.map((f) => `${f.id} (“${md(f.label)}”)`).join(', ')}`);
    if (s.anchors.length)
      L.push(`Anchors (keep as \`data-adl-anchor\`): ${s.anchors.map((a) => `\`${a}\``).join(', ')}`);
    if (s.animations.length)
      L.push(`Animations: ${s.animations.map((a) => `\`${md(a.selector)}\` → \`${md(a.animation)}\``).join('; ')}`);
    if (s.strings.length) L.push(`Copy, in reading order: ${s.strings.map((t) => `“${md(t)}”`).join(' · ')}`);
    L.push('');
  }
  if (spec.excluded.length || spec.openNotes.length) {
    L.push('## Not in this handoff');
    L.push('');
    for (const e of spec.excluded)
      L.push(`- ${e.id} · ${e.title}: ${e.status}${e.banner ? ` (“${md(e.banner)}”)` : ''}`);
    for (const n of spec.openNotes) L.push(`- Note${n.on ? ` on ${n.on}` : ''}: ${md(n.text)}`);
    L.push('');
  }
  return L.join('\n');
}

export function mermaid(spec: Spec): string {
  const q = (s: string) => s.replace(/"/g, '#quot;');
  const L = ['flowchart LR'];
  for (const [i, f] of spec.flows.entries()) {
    L.push(`  subgraph flow${i + 1} ["${q(f.name)}"]`);
    for (const id of f.screens) L.push(`    ${id}["${id} · ${q(spec.screens.find((s) => s.id === id)!.title)}"]`);
    L.push('  end');
  }
  for (const s of spec.screens)
    for (const t of s.transitions.filter((x) => x.included))
      L.push(`  ${s.id} -->${t.label ? `|"${q(t.label)}"|` : ''} ${t.to}`);
  return `${L.join('\n')}\n`;
}

export function componentsMarkdown(st: ProjectState): string {
  const file = path.join(st.dir, 'styles', 'components.css');
  if (!fs.existsSync(file)) return '# Components\n\nThis project has no styles/components.css.\n';
  const css = fs.readFileSync(file, 'utf8');
  const classes = new Set<string>();
  for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) classes.add(m[1]!);
  return `# Components\n\nShared components from \`styles/components.css\`, built only from the tokens. Build each once and reuse it.\n\nClasses: ${[...classes].map((c) => `\`.${c}\``).join(', ')}\n\n\`\`\`css\n${css.trim()}\n\`\`\`\n`;
}

export const SPEC_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Agent Design Lab handoff spec',
  type: 'object',
  required: ['adl', 'project', 'page', 'screens', 'flows', 'tokens'],
  properties: {
    adl: { const: 1 },
    generated: { type: 'string' },
    project: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
    page: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
    snapshotAt: { type: 'number', description: 'ms after load at which the reference pictures froze animations' },
    tokens: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, value: { type: 'string' }, type: { type: 'string' } },
      },
    },
    flows: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, screens: { type: 'array', items: { type: 'string' } } },
      },
    },
    screens: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title', 'png', 'frame', 'transitions'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          source: { type: 'string' },
          png: { type: 'string' },
          snapshotAt: {
            type: 'number',
            description:
              'set when this screen froze its reference picture at its own moment (ms), else the top-level one',
          },
          frame: { type: 'object' },
          requirements: { type: 'array', items: { type: 'string' } },
          strings: { type: 'array', items: { type: 'string' } },
          anchors: { type: 'array', items: { type: 'string' } },
          animations: { type: 'array' },
          transitions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                to: { type: 'string' },
                label: { type: 'string' },
                trigger: { type: 'object' },
                included: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
  },
};

/** Write handoff/ for a spec: markdown, JSON, tokens, Mermaid, reference PNGs (2x) and the source files. */
export async function writeHandoff(
  st: ProjectState,
  spec: Spec,
  dir: string,
  snaps: SnapshotService,
  cli: string,
): Promise<{ files: number; pngs: number; problems: string[] }> {
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(path.join(dir, 'png'), { recursive: true });
  const problems: string[] = [];
  let pngs = 0;
  for (const s of spec.screens) {
    const it = st.docs.pages[spec.page.id]!.items[s.id] as ScreenItem;
    const hash = st.screens.get(it.screen ?? s.id)?.compiled?.hash;
    if (!hash) {
      problems.push(`${s.id}: no screen file, no reference picture`);
      continue;
    }
    const r = await snaps.renderPng(st.id, hash, it.frame, { scale: 2, at: s.snapshotAt ?? spec.snapshotAt });
    await fsp.writeFile(path.join(dir, s.png), r.png);
    pngs++;
    for (const o of [...r.overflow, ...r.outside]) problems.push(`${s.id}: text does not fit: “${o}”`);
  }
  // the design's own files, so the builder can port exact values
  const src = path.join(dir, 'source');
  const copy = async (rel: string) => {
    const from = path.join(st.dir, rel);
    if (fs.existsSync(from)) await fsp.cp(from, path.join(src, rel), { recursive: true });
  };
  for (const s of spec.screens) await copy(s.source.replace(/^source\//, ''));
  await copy('styles');
  await copy('assets');
  await copy('brief.md');
  await fsp.writeFile(path.join(dir, 'HANDOFF.md'), handoffMarkdown(spec, cli));
  await fsp.writeFile(path.join(dir, 'spec.json'), `${JSON.stringify(spec, null, 2)}\n`);
  await fsp.writeFile(path.join(dir, 'spec.schema.json'), `${JSON.stringify(SPEC_SCHEMA, null, 2)}\n`);
  await fsp.writeFile(path.join(dir, 'tokens.json'), `${JSON.stringify(toDtcg(spec.tokens), null, 2)}\n`);
  await fsp.writeFile(path.join(dir, 'components.md'), componentsMarkdown(st));
  await fsp.writeFile(path.join(dir, 'flows.mmd'), mermaid(spec));
  const routes = {
    $comment:
      'Copy to adl-routes.json and fill in where each screen lives in the built app. "setup" runs before the picture (e.g. clicks to open a sheet); "match" is a selector that is only on that screen.',
    baseUrl: 'http://localhost:5173',
    screens: Object.fromEntries(spec.screens.map((s, i) => [s.id, { path: i === 0 ? '/' : `/${s.id.toLowerCase()}` }])),
  };
  await fsp.writeFile(path.join(dir, 'adl-routes.example.json'), `${JSON.stringify(routes, null, 2)}\n`);
  return { files: 8 + spec.screens.length, pngs, problems };
}
