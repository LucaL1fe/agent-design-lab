#!/usr/bin/env node
// Claude Code hook for Agent Design Lab. No dependencies, so it runs from a clone, a plugin install or a folder set up
// with `adl setup`. It never blocks Claude: every failure is silent and it always exits 0.
//
//   SessionStart       the app's pill shows "Claude · connected"; Claude is told where the canvas is
//   UserPromptSubmit   Claude is told what the person changed on the canvas since its last look (adl context --hook)
//   PreToolUse         the pill shows what Claude is doing ("writing S6a.html", "running adl render")
//   Stop / SessionEnd  the pill goes back to "connected" / "not connected"
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const event = process.argv[2] ?? '';

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

/** The workspace folder for `dir`: the nearest adl.json above it decides, else the folder itself. */
function workspaceOf(dir) {
  for (let d = dir; ; ) {
    const f = path.join(d, 'adl.json');
    if (fs.existsSync(f)) {
      try {
        const c = JSON.parse(fs.readFileSync(f, 'utf8'));
        return c.workspace ? path.resolve(d, c.workspace) : d;
      } catch {
        return d;
      }
    }
    const up = path.dirname(d);
    if (up === d) return dir;
    d = up;
  }
}

function findServer(cwd) {
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.adl', 'servers.json'), 'utf8'));
  } catch {
    return undefined;
  }
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  cwd = real(cwd);
  const ws = real(workspaceOf(cwd));
  for (const s of list) s.workspace = real(s.workspace);
  const inside = (a, b) => a === b || a.startsWith(b + path.sep);
  return (
    list.find((s) => s.workspace === ws) ??
    list.find((s) => inside(cwd, s.workspace) || inside(s.workspace, cwd)) ??
    undefined
  );
}

async function call(server, route, body) {
  const r = await fetch(`http://127.0.0.1:${server.port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-adl-token': server.token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(event === 'UserPromptSubmit' || event === 'SessionStart' ? 2500 : 600),
  });
  return r.ok ? r.json() : undefined;
}

function activity(input) {
  const t = input.tool_name ?? '';
  const ti = input.tool_input ?? {};
  if (t === 'Write' || t === 'Edit' || t === 'MultiEdit') {
    const f = String(ti.file_path ?? '');
    // the full path lets the server tell which agent wrote a file (merges stay right with several agents at once)
    return { state: 'writing', file: path.basename(f), path: f, text: `writing ${path.basename(f)}` };
  }
  if (t === 'Bash') {
    const m = /\b(?:adl|agent-design-lab|cli\.ts)\s+([a-z-]+)/.exec(String(ti.command ?? ''));
    return { state: 'running', text: m ? `running adl ${m[1]}` : 'running a command' };
  }
  if (t === 'Read' || t === 'Grep' || t === 'Glob') return { state: 'running', text: 'reading' };
  return { state: 'running', text: 'working' };
}

async function main() {
  const input = readStdin();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const server = findServer(cwd);
  const session = input.session_id;
  const name = input.session_title;
  if (event === 'SessionStart') {
    if (!server) {
      process.stdout.write(
        'Agent Design Lab is not running for this folder. When you design, start it in the background first (the agent-design-lab skill says how), so the person sees your screens live.\n',
      );
      return;
    }
    await call(server, '/api/agent', { state: 'connected', text: 'connected', session, name });
    const r = await call(server, '/api/cmd/context', {
      args: ['--hook', '--peek', ...(session ? ['--session', session] : [])],
      cwd,
    });
    process.stdout.write(
      `Agent Design Lab is running: http://localhost:${server.port} (workspace ${server.workspace}).\n${r?.text ? `${r.text}\n` : ''}`,
    );
    return;
  }
  if (!server) return;
  if (event === 'UserPromptSubmit') {
    await call(server, '/api/agent', { state: 'running', text: 'thinking', session, name });
    // per session: several agents can work in parallel and each is told about the person's changes
    const r = await call(server, '/api/cmd/context', {
      args: ['--hook', ...(session ? ['--session', session] : [])],
      cwd,
    });
    if (r?.text) process.stdout.write(`Agent Design Lab · ${r.text.slice(0, 9000)}\n`);
    return;
  }
  if (event === 'PreToolUse') return void (await call(server, '/api/agent', { ...activity(input), session, name }));
  if (event === 'PostToolUse')
    return void (await call(server, '/api/agent', { state: 'running', text: 'working', session, name }));
  if (event === 'Stop')
    return void (await call(server, '/api/agent', { state: 'idle', text: 'waiting for you', session, name }));
  if (event === 'SessionEnd') return void (await call(server, '/api/agent', { state: 'none', session }));
}

main()
  .catch(() => undefined)
  .finally(() => process.exit(0));
