// `adl setup`: make any folder ready for designing with Claude Code (adl.json, the skill, the hooks, a section in
// CLAUDE.md and AGENTS.md). `adl doctor`: check that everything needed is there.
import fs from 'node:fs';
import path from 'node:path';
import { discoverProjects, resolveWorkspace } from '../paths.ts';
import { findServer } from '../server/server.ts';
import { packageRoot, readVersion } from '../version.ts';
import { register } from './registry.ts';
import { CommandError, str } from './session.ts';

const START = '<!-- agent-design-lab:start -->';
const END = '<!-- agent-design-lab:end -->';
const HOOK_EVENTS: [string, string | undefined][] = [
  ['SessionStart', undefined],
  ['UserPromptSubmit', undefined],
  ['PreToolUse', 'Write|Edit|MultiEdit|Bash'],
  ['PostToolUse', 'Write|Edit|MultiEdit|Bash'],
  ['Stop', undefined],
  ['SessionEnd', undefined],
];

/** How agents should run the CLI from `target`, given where this copy of ADL lives. */
export function commandForm(target: string, cliFile = process.argv[1] ?? ''): string {
  const root = packageRoot();
  if (cliFile.includes(`${path.sep}_npx${path.sep}`)) return 'npx agent-design-lab';
  if (root.startsWith(path.join(target, 'node_modules') + path.sep)) return 'npx adl';
  if (fs.existsSync(path.join(root, 'adl')) && fs.existsSync(path.join(root, 'src', 'node', 'cli.ts')))
    return root === target ? './adl' : JSON.stringify(path.join(root, 'adl'));
  return 'adl';
}

export function agentSection(adl: string, workspace: string): string {
  return `${START}
## Agent Design Lab

Designs for this project live in \`${workspace}\` and are drawn on the Agent Design Lab canvas: live HTML screens joined
by labelled arrows, with statuses and banner texts for review. The approved screens on each project's source-of-truth
page are the spec to build from.

- When asked to design, mock up or prototype screens, a flow or a website, or to change a design: use the
  \`agent-design-lab\` skill (\`.claude/skills/agent-design-lab/SKILL.md\`) and follow its process.
- Run its commands as \`${adl} <command>\` (\`${adl} help\` lists them). \`${adl} open\` shows the canvas.
- Never mark screens approved: approval is the person's call on the canvas.
- When asked to build from the design: \`${adl} handoff\` and the skill's section "Building from an ADL source of truth".
${END}`;
}

/** Insert or replace our section in a markdown file. */
export function upsertSection(file: string, section: string): 'created' | 'updated' | 'unchanged' {
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let after: string;
  const a = before.indexOf(START);
  const b = before.indexOf(END);
  if (a >= 0 && b > a) after = before.slice(0, a) + section + before.slice(b + END.length);
  else after = `${before}${before && !before.endsWith('\n') ? '\n' : ''}${before ? '\n' : ''}${section}\n`;
  if (after === before) return 'unchanged';
  fs.writeFileSync(file, after);
  return before ? 'updated' : 'created';
}

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}

/** Add our hooks to a settings.json, replacing older copies of them and keeping everything else. */
export function mergeHooks(file: string, command: (event: string) => string): 'created' | 'updated' | 'unchanged' {
  let settings: { hooks?: Record<string, HookEntry[]> } & Record<string, unknown> = {};
  const exists = fs.existsSync(file);
  if (exists) {
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new CommandError(`${file} is not valid JSON; fix it first, then run setup again`);
    }
  }
  const before = JSON.stringify(settings);
  settings.hooks ??= {};
  for (const [event, matcher] of HOOK_EVENTS) {
    const keep = (settings.hooks[event] ?? [])
      .map((e) => ({ ...e, hooks: e.hooks.filter((h) => !h.command.includes('adl-hook.mjs')) }))
      .filter((e) => e.hooks.length);
    keep.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: command(event), timeout: 5 }] });
    settings.hooks[event] = keep;
  }
  if (JSON.stringify(settings) === before) return 'unchanged';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return exists ? 'updated' : 'created';
}

function copyDir(from: string, to: string) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
}

register({
  name: 'setup',
  summary: 'Prepare a folder for designing with Claude Code: adl.json, skill, hooks, CLAUDE.md and AGENTS.md section',
  usage: 'adl setup [folder] [--workspace design] [--no-hooks]',
  run: async (args, ctx) => {
    const target = path.resolve(ctx.cwd, args._[0] ?? '.');
    if (!fs.existsSync(target)) throw new CommandError(`${target} does not exist`);
    const root = packageRoot();
    if (target === root)
      return { ok: true, text: 'This is the Agent Design Lab repo itself: it comes set up (workspace/, .claude/).' };
    const done: string[] = [];
    // adl.json decides where designs live
    const cfgFile = path.join(target, 'adl.json');
    let workspace = str(args.workspace) ?? 'design';
    if (fs.existsSync(cfgFile)) {
      try {
        workspace = (JSON.parse(fs.readFileSync(cfgFile, 'utf8')) as { workspace?: string }).workspace ?? '.';
      } catch {
        throw new CommandError(`${cfgFile} is not valid JSON`);
      }
    } else {
      fs.writeFileSync(cfgFile, `${JSON.stringify({ adl: 1, workspace }, null, 2)}\n`);
      done.push(`adl.json (designs go in ${workspace}/)`);
    }
    fs.mkdirSync(path.resolve(target, workspace), { recursive: true });
    // the skill and the hook script, copied so the folder works without this install
    copyDir(path.join(root, 'skills', 'agent-design-lab'), path.join(target, '.claude', 'skills', 'agent-design-lab'));
    done.push('.claude/skills/agent-design-lab');
    if (args.hooks !== false) {
      const hookFile = path.join(target, '.claude', 'hooks', 'adl-hook.mjs');
      fs.mkdirSync(path.dirname(hookFile), { recursive: true });
      fs.copyFileSync(path.join(root, 'hooks', 'adl-hook.mjs'), hookFile);
      const r = mergeHooks(
        path.join(target, '.claude', 'settings.json'),
        (e) => `node "$CLAUDE_PROJECT_DIR/.claude/hooks/adl-hook.mjs" ${e}`,
      );
      done.push(`.claude/hooks/adl-hook.mjs, hooks in .claude/settings.json (${r})`);
    }
    const adl = commandForm(target);
    const section = agentSection(adl, workspace);
    done.push(`CLAUDE.md (${upsertSection(path.join(target, 'CLAUDE.md'), section)})`);
    done.push(`AGENTS.md (${upsertSection(path.join(target, 'AGENTS.md'), section)})`);
    const gi = path.join(target, '.gitignore');
    const giText = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    if (!/^\.adl\/?$/m.test(giText)) {
      fs.writeFileSync(gi, `${giText}${giText && !giText.endsWith('\n') ? '\n' : ''}.adl/\n`);
      done.push('.gitignore (.adl/)');
    }
    return {
      ok: true,
      text: `Set up ${target}:\n${done.map((d) => `  - ${d}`).join('\n')}\nNext: ${adl} open, then ask Claude Code to design something.`,
      data: { target, workspace, command: adl },
    };
  },
});

register({
  name: 'doctor',
  summary: 'Check Node, Chrome, the workspace, the server, the skill and the hooks',
  usage: 'adl doctor',
  run: async (args, ctx) => {
    const lines: string[] = [];
    let bad = 0;
    const check = (ok: boolean, good: string, fix: string) => {
      if (!ok) bad++;
      lines.push(`${ok ? '✓' : '✗'} ${ok ? good : fix}`);
    };
    const [maj, min] = process.versions.node.split('.').map(Number) as [number, number];
    check(
      maj > 22 || (maj === 22 && min >= 18),
      `Node ${process.versions.node}`,
      `Node ${process.versions.node} is too old: install Node 22.18 or newer`,
    );
    lines.push(`  Agent Design Lab ${readVersion()} in ${packageRoot()}`);
    check(
      fs.existsSync(path.join(packageRoot(), 'dist', 'app', 'index.html')),
      'The app is built',
      'The app is not built: run `npm install` (or `npm run build`) in the Agent Design Lab folder',
    );
    let chrome = false;
    try {
      const { chromium } = await import('playwright-core');
      for (const channel of ['chrome', 'chrome-beta', 'msedge', 'chromium']) {
        try {
          const b = await chromium.launch({ channel, headless: true, timeout: 15000 });
          lines.push(`✓ ${channel} ${b.version()} for previews and renders`);
          await b.close();
          chrome = true;
          break;
        } catch {
          // try the next one
        }
      }
    } catch {
      // playwright-core missing
    }
    if (!chrome) {
      bad++;
      lines.push(
        '✗ No Chrome found: previews and `adl render` need Google Chrome (or Edge/Chromium). Set ADL_CHROME to its path.',
      );
    }
    const ws = resolveWorkspace({ workspace: str(args.workspace), cwd: ctx.cwd });
    const projects = discoverProjects(ws);
    lines.push(
      `  Workspace ${ws.root}${ws.configFile ? ` (from ${path.relative(ctx.cwd, ws.configFile) || 'adl.json'})` : ' (this folder: no adl.json found)'}: ${projects.length} project${projects.length === 1 ? '' : 's'}`,
    );
    const server = ctx.server ? { port: ctx.server.port } : findServer(ws.root);
    lines.push(server ? `✓ Running at http://localhost:${server.port}` : '  Not running: `adl open` starts it');
    // skill and hooks are looked up from the folder Claude Code runs in (the nearest .claude above here)
    let dir = ctx.cwd;
    let claudeDir: string | undefined;
    for (;;) {
      if (fs.existsSync(path.join(dir, '.claude'))) {
        claudeDir = path.join(dir, '.claude');
        break;
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    const skill = claudeDir && fs.existsSync(path.join(claudeDir, 'skills', 'agent-design-lab', 'SKILL.md'));
    check(
      !!skill,
      `Skill in ${claudeDir}/skills/agent-design-lab`,
      'The skill is not installed here: run `adl setup` (or install the plugin)',
    );
    let hooks = false;
    let hookMissing = '';
    if (claudeDir) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')) as {
          hooks?: Record<string, HookEntry[]>;
        };
        const cmd = s.hooks?.UserPromptSubmit?.flatMap((e) => e.hooks).find((h) => h.command.includes('adl-hook.mjs'));
        if (cmd) {
          hooks = true;
          const m = /"([^"]*adl-hook\.mjs)"/.exec(cmd.command);
          const file = m?.[1]?.replace('$CLAUDE_PROJECT_DIR', path.dirname(claudeDir));
          if (file && !fs.existsSync(file)) hookMissing = file;
        }
      } catch {
        // no settings
      }
    }
    check(
      hooks && !hookMissing,
      'Hooks installed (the app shows what Claude does; Claude sees your changes)',
      hookMissing
        ? `The hook script ${hookMissing} is missing: run \`adl setup\` again`
        : 'No hooks: run `adl setup` (optional, but the pill and change notes need them)',
    );
    return { ok: bad === 0, text: lines.join('\n'), exitCode: bad ? 1 : 0 };
  },
});
