#!/usr/bin/env node
// `adl` — Agent Design Lab's command line. `adl` alone opens the canvas for this folder.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { type CommandContext, type CommandResult, commands, parseArgs } from './commands/registry.ts';
import './commands/index.ts';
import { resolveWorkspace } from './paths.ts';
import { findServer, startServer } from './server/server.ts';
import { SnapshotService } from './snapshot/service.ts';
import { codeChangedAt, readVersion, serverIsStale } from './version.ts';

const HELP = `Agent Design Lab ${readVersion()}: a local canvas where Claude Code designs your app or website.

Usage:
  adl                      Open the canvas for this folder (starts the server if needed)
  adl open [folder]        Same, for another folder
  adl serve                Run the server without opening a browser
  adl serve --restart      Stop the running server and start it again, so it loads changed code
  adl <command> --help     Help for a command

Commands:
${[...commands.values()]
  .filter((c) => !c.hidden)
  .map((c) => `  ${c.name.padEnd(22)} ${c.summary}`)
  .join('\n')}

Options for every command: --workspace <folder>, --json, --project <id>, --page <id>
Docs: https://github.com/LucaL1fe/agent-design-lab`;

/** Is the agent-design-lab skill installed for Claude Code in `dir` or a folder above it? */
function hasSkill(dir: string): boolean {
  for (let d = dir; ; ) {
    if (fs.existsSync(path.join(d, '.claude', 'skills', 'agent-design-lab', 'SKILL.md'))) return true;
    const up = path.dirname(d);
    if (up === d) return false;
    d = up;
  }
}

async function health(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

export function openBrowser(url: string) {
  const chrome =
    process.platform === 'darwin'
      ? ['open', ['-a', 'Google Chrome', url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', 'chrome', url]]
        : ['google-chrome', [url]];
  const p = spawn(chrome[0] as string, chrome[1] as string[], { stdio: 'ignore', detached: true });
  p.on('error', () => {
    const fallback = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    spawn(fallback, [url], { stdio: 'ignore', detached: true }).unref();
  });
  p.on('exit', (code) => {
    if (code && code !== 0) {
      const fallback = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      spawn(fallback, [url], { stdio: 'ignore', detached: true }).unref();
    }
  });
  p.unref();
}

/** Stop a running server (SIGTERM: it closes cleanly) and wait until its process is gone. */
async function stopServer(e: { pid: number }): Promise<boolean> {
  const alive = () => {
    try {
      process.kill(e.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    process.kill(e.pid, 'SIGTERM');
  } catch {
    return !alive();
  }
  for (let i = 0; i < 80; i++) {
    if (!alive()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function serve(args: ReturnType<typeof parseArgs>, open: boolean) {
  const workspace =
    typeof args.workspace === 'string' ? args.workspace : typeof args._[1] === 'string' ? args._[1] : undefined;
  const ws = resolveWorkspace({ workspace });
  const restart = args.restart === true;
  let existing = findServer(ws.root);
  if (existing && restart) {
    if (!(await stopServer(existing))) {
      console.error(`The running server (pid ${existing.pid}) did not stop.`);
      process.exitCode = 1;
      return;
    }
    existing = undefined;
  }
  if (existing && (await health(existing.port))) {
    const url = `http://localhost:${existing.port}${typeof args.focus === 'string' ? `/#${args.focus}` : ''}`;
    if (open) {
      // a tab is usually open already: ask it to come forward instead of opening another one
      const r = await fetch(`http://127.0.0.1:${existing.port}/api/cmd/focus-tab`, {
        method: 'POST',
        headers: { 'x-adl-token': existing.token, 'content-type': 'application/json' },
        body: JSON.stringify({ args: [url] }),
      }).catch(() => undefined);
      const body = (await r?.json().catch(() => undefined)) as { data?: { tabs?: number } } | undefined;
      if (!body?.data?.tabs) openBrowser(url);
    }
    console.log(`Agent Design Lab is running: ${url}`);
    return;
  }
  // without a terminal (an agent's shell) a restart goes to the background too, or the command would never return
  if (args.background === true || (args.background !== false && !process.stdout.isTTY && (open || restart))) {
    const child = spawn(
      process.execPath,
      [
        ...process.execArgv,
        process.argv[1]!,
        'serve',
        '--workspace',
        ws.root,
        // the child has no terminal either: without this it would start yet another background child, forever
        '--no-background',
        ...(open ? ['--open'] : []),
        ...(args.dev ? ['--dev'] : []),
      ],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const e = findServer(ws.root);
      if (e && (await health(e.port))) {
        console.log(`Agent Design Lab is running in the background: http://localhost:${e.port}`);
        return;
      }
    }
    console.error('The server did not start. Run `adl serve` to see why.');
    process.exitCode = 1;
    return;
  }
  const s = await startServer({
    workspace: ws.root,
    ...(typeof args.port === 'string' ? { port: Number(args.port) } : {}),
    dev: args.dev === true,
  });
  const snaps = new SnapshotService(s);
  s.snapshots = snaps;
  if (args.snapshots !== false) {
    snaps.start().then((ok) => {
      if (!ok) console.log('Previews are off: Google Chrome was not found. Run `adl doctor` for help.');
    });
  }
  console.log(`Agent Design Lab ${readVersion()}  ${s.url}`);
  console.log(
    `Workspace: ${s.ws.root}  (${s.service.projects.size} project${s.service.projects.size === 1 ? '' : 's'})`,
  );
  if (!s.ws.configFile && !hasSkill(process.cwd()))
    console.log('Tip: run `adl setup` here once, so Claude Code knows how to design in this folder.');
  if (open || args.open === true) openBrowser(`${s.url}${typeof args.focus === 'string' ? `/#${args.focus}` : ''}`);
  const stop = async () => {
    await s.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (args.version || cmd === 'version') return console.log(readVersion());
  if (cmd === 'help' || (args.help && !cmd)) return console.log(HELP);
  if (!cmd || cmd === 'open') return serve(args, true);
  if (cmd === 'serve') return serve(args, args.open === true);
  const c = commands.get(cmd);
  if (!c) {
    console.error(`Unknown command "${cmd}". Run \`adl help\`.`);
    process.exitCode = 1;
    return;
  }
  if (args.help) return console.log(`${c.summary}\n\nUsage: ${c.usage}`);
  const ws = resolveWorkspace({ workspace: typeof args.workspace === 'string' ? args.workspace : undefined });
  const running = findServer(ws.root);
  let result: CommandResult;
  if (running && (await health(running.port))) {
    if (serverIsStale(running.startedAt, codeChangedAt()))
      console.error(
        `Note: Agent Design Lab's code changed after the server for this folder started (pid ${running.pid}, ` +
          `${running.startedAt}), so this command runs on the old code. Run \`adl serve --restart\` to load the new code.`,
      );
    const r = await fetch(`http://127.0.0.1:${running.port}/api/cmd/${encodeURIComponent(cmd)}`, {
      method: 'POST',
      headers: { 'x-adl-token': running.token, 'content-type': 'application/json' },
      body: JSON.stringify({ args: argv.slice(1), cwd: process.cwd() }),
    });
    result = (await r.json()) as CommandResult;
  } else {
    const ctx: CommandContext = { cwd: process.cwd() };
    result = await c
      .run(parseArgs(argv.slice(1)), ctx)
      .catch((e: Error): CommandResult => ({ ok: false, text: e.message, exitCode: 1 }));
  }
  if (args.json) console.log(JSON.stringify(result.data ?? result, null, 2));
  else if (result.text) console.log(result.text);
  process.exitCode = result.exitCode ?? (result.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});

export { path };
