// Projects: create one, copy one (the built-in examples too), list them.
import fs from 'node:fs';
import path from 'node:path';
import { newPageDoc, newProjectDoc } from '../../core/actions.ts';
import { parseJson, stringifyPage, stringifyProject } from '../../core/json.ts';
import { countStatuses, countsText } from '../../core/status.ts';
import { writeAtomic } from '../fsutil.ts';
import { builtinExamples, discoverProjects, exampleIdOf, projectIdOf, resolveWorkspace } from '../paths.ts';
import { WorkspaceService } from '../store/workspace.ts';
import { register } from './registry.ts';
import { CommandError, historyText, plural, screenCount, str } from './session.ts';
import { BRIEF_MD, COMPONENTS_CSS, TOKENS_CSS } from './templates.ts';

export function folderName(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'project'
  );
}

register({
  name: 'init',
  summary: 'Create a project (a folder with project.json, a first page, styles/ and screens/)',
  usage: 'adl init <name> [--frame iphone-16|desktop|390x844|1280xauto] [--folder <dir>]',
  run: async (args, ctx) => {
    const name = args._.join(' ').trim();
    if (!name) throw new CommandError('Give the project a name: adl init "Habit app"');
    const ws = ctx.server?.ws ?? resolveWorkspace({ workspace: str(args.workspace), cwd: ctx.cwd });
    const dir = path.resolve(ws.root, str(args.folder) ?? folderName(name));
    if (fs.existsSync(path.join(dir, 'project.json')))
      throw new CommandError(`There is a project in ${path.relative(ctx.cwd, dir) || '.'} already`);
    const frame = str(args.frame);
    const project = newProjectDoc(name, frame ? { frame } : {});
    project.styles = ['styles/tokens.css', 'styles/components.css'];
    await writeAtomic(path.join(dir, 'project.json'), stringifyProject(project));
    await writeAtomic(path.join(dir, 'pages', 'truth.json'), stringifyPage(newPageDoc('Source of truth')));
    await writeAtomic(path.join(dir, 'styles', 'tokens.css'), TOKENS_CSS);
    await writeAtomic(path.join(dir, 'styles', 'components.css'), COMPONENTS_CSS);
    await writeAtomic(path.join(dir, 'brief.md'), BRIEF_MD.replace('{name}', name));
    fs.mkdirSync(path.join(dir, 'screens'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    if (ctx.server) await ctx.server.service.load();
    const id = projectIdOf(ws, dir);
    const rel = path.relative(ctx.cwd, dir) || '.';
    return {
      ok: true,
      text: `Created "${name}" in ${rel}: project.json, pages/truth.json, styles/tokens.css, styles/components.css, brief.md.\nNext: write the brief, then the design system (styles/), then screens/<id>.html and \`adl add\`.`,
      data: { id, dir },
    };
  },
});

register({
  name: 'copy',
  summary: 'Copy a project, or a built-in example such as example-still, into the workspace as a new project to edit',
  usage: 'adl copy <project> [new name]',
  run: async (args, ctx) => {
    const [from, ...rest] = args._;
    if (!from) throw new CommandError('Which project? adl copy example-still "My app"');
    const ws = ctx.server?.ws ?? resolveWorkspace({ workspace: str(args.workspace), cwd: ctx.cwd });
    const own = discoverProjects(ws);
    const src =
      ctx.server?.service.projects.get(from)?.dir ??
      builtinExamples().find((d) => exampleIdOf(d) === from) ??
      own.find((d) => projectIdOf(ws, d) === from);
    if (!src) {
      const ids = [...own.map((d) => projectIdOf(ws, d)), ...builtinExamples().map(exampleIdOf)];
      throw new CommandError(`No project "${from}". Projects: ${ids.join(', ') || 'none'}`);
    }
    const parsed = parseJson<{ name?: string }>(fs.readFileSync(path.join(src, 'project.json'), 'utf8'));
    const oldName = (parsed.ok && parsed.value?.name) || path.basename(src);
    const name = rest.join(' ').trim() || oldName;
    const base = folderName(rest.length ? name : path.basename(src));
    let dir = path.join(ws.root, base);
    for (let n = 2; fs.existsSync(dir); n++) dir = path.join(ws.root, `${base}-${n}`);
    // the files only: caches, history and activity (.adl) stay with the original
    fs.cpSync(src, dir, { recursive: true, filter: (f) => path.basename(f) !== '.adl' });
    if (name !== oldName && parsed.ok) {
      const project = { ...(parsed.value as object), name };
      await writeAtomic(path.join(dir, 'project.json'), stringifyProject(project as never));
    }
    if (ctx.server) await ctx.server.service.load();
    const id = projectIdOf(ws, dir);
    return {
      ok: true,
      text: `Copied "${oldName}" to ${path.relative(ctx.cwd, dir) || '.'} as "${name}" (project ${id}): yours to edit.`,
      data: { id, dir },
    };
  },
});

register({
  name: 'list',
  summary: 'List projects and their pages with screen counts',
  usage: 'adl list [--project <id>]',
  run: async (args, ctx) => {
    let service = ctx.server?.service;
    if (!service) {
      const ws = resolveWorkspace({ workspace: str(args.workspace), cwd: ctx.cwd });
      if (!discoverProjects(ws).length)
        return { ok: true, text: `No projects in ${ws.root}. Create one: adl init "<name>"`, data: { projects: [] } };
      service = new WorkspaceService(ws);
      await service.load();
    }
    const want = str(args.project);
    const out: unknown[] = [];
    const lines: string[] = [];
    for (const st of service.projects.values()) {
      if (want && st.id !== want) continue;
      const p = st.docs.project;
      lines.push(`${st.id}  "${p.name}"  ${path.relative(ctx.cwd, st.dir) || '.'}`);
      const pages = p.pages.filter((pg) => st.docs.pages[pg]);
      for (const pg of pages) {
        const page = st.docs.pages[pg]!;
        const counts = page.kind === 'history' ? historyText(page) : countsText(countStatuses(p, page));
        lines.push(
          `  ${pg === p.sourceOfTruth ? '*' : ' '} ${pg}  "${page.name}"  ${plural(screenCount(page), 'screen')}${counts ? ` · ${counts}` : ''}`,
        );
      }
      out.push({ id: st.id, name: p.name, dir: st.dir, pages, sourceOfTruth: p.sourceOfTruth });
    }
    if (!ctx.server) service.close();
    return { ok: true, text: lines.join('\n') || 'No projects', data: { projects: out } };
  },
});
