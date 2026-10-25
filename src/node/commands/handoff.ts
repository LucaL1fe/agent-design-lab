// `adl handoff` writes the build spec; `adl handoff check` compares a built app against it.
import fs from 'node:fs';
import path from 'node:path';
import { type Routes, runCheck } from '../handoff/check.ts';
import { buildSpec, type Spec, writeHandoff } from '../handoff/handoff.ts';
import { resolveWorkspace } from '../paths.ts';
import { startServer } from '../server/server.ts';
import { SnapshotService } from '../snapshot/service.ts';
import { register } from './registry.ts';
import { CommandError, list, num, pickPage, pickProject, plural, str } from './session.ts';
import { commandForm } from './setup.ts';

register({
  name: 'handoff',
  summary:
    'Write the build spec (handoff/: HANDOFF.md, spec.json, tokens, reference PNGs); `handoff check` tests a build',
  usage:
    'adl handoff [--page <id>] [--all | --status approved,as-today] [--out <dir>] | adl handoff check [--handoff <dir>] [--routes adl-routes.json] [--threshold 0.92] [--only S1 S2]',
  run: async (args, ctx) => {
    if (args._[0] === 'check') return check(args, ctx);
    const server =
      ctx.server ??
      (await startServer({
        ws: resolveWorkspace({ workspace: str(args.workspace), cwd: ctx.cwd }),
        port: 0,
        quiet: true,
        ephemeral: true,
      }));
    const snaps = new SnapshotService(server);
    try {
      if (!(await snaps.start({ background: false })))
        throw new CommandError('The handoff renders reference pictures and needs Google Chrome. Run `adl doctor`.');
      const st = pickProject(server.service, args, ctx.cwd, server);
      const page = pickPage(st.docs, str(args.page));
      const statuses = list(args.status)
        .flatMap((s) => s.split(','))
        .filter(Boolean);
      const spec = buildSpec(server.service, st, { page, all: args.all === true, statuses });
      if (!spec.screens.length)
        throw new CommandError(
          `No approved screens on “${spec.page.name}” yet (${plural(spec.excluded.length, 'screen')} waiting). Approve them on the canvas, or hand off everything with --all.`,
        );
      const dir = path.resolve(ctx.cwd, str(args.out) ?? path.join(st.dir, 'handoff'));
      const cli = commandForm(ctx.cwd);
      const r = await writeHandoff(st, spec, dir, snaps, cli);
      const rel = path.relative(ctx.cwd, dir) || '.';
      const lines = [
        `Handoff written to ${rel.startsWith('..') ? dir : rel}: HANDOFF.md, spec.json, tokens.json, components.md, flows.mmd, ${plural(r.pngs, 'reference picture')}, source/.`,
        `${plural(spec.screens.length, 'screen')} in ${plural(spec.flows.length, 'flow')}${spec.excluded.length ? `; not included (not approved): ${spec.excluded.map((e) => e.id).join(', ')}` : ''}.`,
        ...r.problems.map((p) => `warning: ${p}`),
        `To build it, give the builder ${path.join(rel, 'HANDOFF.md')}; they verify with \`${cli} handoff check\`.`,
      ];
      return { ok: true, text: lines.join('\n'), data: { dir, screens: spec.screens.length, excluded: spec.excluded } };
    } finally {
      await snaps.close();
      if (!ctx.server) await server.close();
    }
  },
});

/** The handoff folder: --handoff, else ./handoff, else the project's handoff/. */
function findHandoff(args: Parameters<typeof check>[0], cwd: string): string {
  const explicit = str(args.handoff);
  const tries = explicit ? [path.resolve(cwd, explicit)] : [path.join(cwd, 'handoff'), cwd];
  for (const d of tries) if (fs.existsSync(path.join(d, 'spec.json'))) return d;
  throw new CommandError(
    `No handoff here${explicit ? ` (${explicit})` : ''}: pass --handoff <folder with spec.json>, or run it where the handoff/ folder is.`,
  );
}

async function check(args: import('./registry.ts').ParsedArgs, ctx: import('./registry.ts').CommandContext) {
  const dir = findHandoff(args, ctx.cwd);
  const spec = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8')) as Spec;
  const routesFile = path.resolve(
    ctx.cwd,
    str(args.routes) ??
      (fs.existsSync(path.join(ctx.cwd, 'adl-routes.json')) ? 'adl-routes.json' : path.join(dir, 'adl-routes.json')),
  );
  if (!fs.existsSync(routesFile))
    throw new CommandError(
      `No ${path.basename(routesFile)}: copy ${path.join(path.relative(ctx.cwd, dir) || '.', 'adl-routes.example.json')} to adl-routes.json and fill in where each screen lives in your app.`,
    );
  const routes = JSON.parse(fs.readFileSync(routesFile, 'utf8')) as Routes;
  const { chromium } = await import('playwright-core');
  let browser: import('playwright-core').Browser | undefined;
  for (const channel of ['chrome', 'msedge', 'chromium']) {
    try {
      browser = await chromium.launch({ channel, headless: true });
      break;
    } catch {
      // next
    }
  }
  if (!browser) throw new CommandError('The check needs Google Chrome. Run `adl doctor`.');
  try {
    const only = [...args._.slice(1), ...list(args.only)];
    const r = await runCheck(browser, spec, routes, dir, { threshold: num(args.threshold) ?? 0.92, only });
    const passed = r.screens.filter((s) => s.ok).length;
    const tPass = r.transitions.filter((t) => t.result === 'pass').length;
    const tTested = r.transitions.filter((t) => t.result !== 'skipped').length;
    const lines = [
      `${r.ok ? 'PASS' : 'NOT YET'} · screens ${passed}/${r.screens.length + r.noRoute.length} · transitions ${tPass}/${tTested} (${r.transitions.length - tTested} checked by hand)`,
    ];
    for (const s of r.screens.filter((x) => !x.ok))
      lines.push(
        `✗ ${s.id}: ${s.error ? s.error : `similarity ${s.ssim} (needs ${r.threshold}), ${s.changed} % pixels differ${s.missing.length ? `, missing copy: ${s.missing.map((m) => `“${m}”`).join(', ')}` : ''}`}${s.sheet ? ` → look at ${path.join(path.relative(ctx.cwd, dir) || '.', s.sheet)}` : ''}`,
      );
    for (const id of r.noRoute) lines.push(`✗ ${id}: no route in ${path.basename(routesFile)}`);
    for (const t of r.transitions.filter((x) => x.result === 'fail'))
      lines.push(`✗ ${t.from} → ${t.to} “${t.label}”: ${t.why ?? 'did not arrive'}`);
    lines.push(`Report: ${path.join(path.relative(ctx.cwd, dir) || '.', 'check', 'report.md')}`);
    return { ok: r.ok, text: lines.join('\n'), data: r, exitCode: r.ok ? 0 : 1 };
  } finally {
    await browser.close();
  }
}
