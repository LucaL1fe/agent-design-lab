import path from 'node:path';
import { importClaudeDesign } from '../importer/claude-design.ts';
import { register } from './registry.ts';

register({
  name: 'import',
  summary: 'Import a design from another tool (claude-design: a Claude Design canvas export)',
  usage:
    'adl import claude-design <folder-with-canvas.json>... --to <project-folder> [--name "Name"] [--blob-dir <dir>]... [--blobmap <map.json>=<dir>]... [--keep-routes]',
  run: async (args, ctx) => {
    const [kind, ...sources] = args._;
    if (kind !== 'claude-design')
      return {
        ok: false,
        text:
          'Only "claude-design" imports exist so far. Usage: ' +
          (await import('./registry.ts')).commands.get('import')!.usage,
        exitCode: 1,
      };
    if (!sources.length || typeof args.to !== 'string')
      return { ok: false, text: 'Give the board folders and --to <project-folder>', exitCode: 1 };
    const list = (v: unknown) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []) as string[];
    const r = await importClaudeDesign({
      sources: sources.map((s) => path.resolve(ctx.cwd, s)),
      to: path.resolve(ctx.cwd, args.to),
      ...(typeof args.name === 'string' ? { name: args.name } : {}),
      blobDirs: list(args['blob-dir']).map((d) => path.resolve(ctx.cwd, d)),
      blobMaps: list(args.blobmap).map((m) => {
        const [map, dir] = m.split('=');
        return { map: path.resolve(ctx.cwd, map!), dir: path.resolve(ctx.cwd, dir ?? path.dirname(map!)) };
      }),
      keepRoutes: args['keep-routes'] === true,
    });
    const text = `Imported ${r.screens} screens, ${r.arrows} arrows (${r.arrowsUnmatched.length} not attached), ${r.portals} portals, ${r.notes + r.chips} notes from ${r.boards} boards.\nCSS: ${Math.round(r.cssBytesBefore / 1024)} KB → ${Math.round(r.cssBytesAfter / 1024)} KB in ${r.sheets} shared stylesheets. Report: ${path.join(String(args.to), 'import-report.md')}`;
    return { ok: true, text, data: r };
  },
});
