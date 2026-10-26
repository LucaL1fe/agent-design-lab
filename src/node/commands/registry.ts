// One registry of commands. The CLI, the HTTP API (/api/cmd/<name>) and a later MCP server are all generated from it,
// so `adl status T4 approved` in a terminal and a click in the app go through the same code.
import type { RunningServer } from '../server/server.ts';

export interface CommandContext {
  server?: RunningServer;
  cwd: string;
}

export interface CommandResult {
  ok: boolean;
  /** Plain text for people and agents (printed by the CLI). */
  text: string;
  /** Structured result (printed with --json). */
  data?: unknown;
  exitCode?: number;
}

export interface Command {
  name: string;
  summary: string;
  usage: string;
  /** Needs the running server (true) or works on files directly when no server is running (false). */
  needsServer?: boolean;
  /** Internal (used by the app or other commands): left out of `adl help`. */
  hidden?: boolean;
  run: (args: ParsedArgs, ctx: CommandContext) => Promise<CommandResult>;
}

export interface ParsedArgs {
  _: string[];
  [flag: string]: string | boolean | string[] | undefined;
}

export const commands = new Map<string, Command>();

export function register(c: Command) {
  commands.set(c.name, c);
}

/** Flags that are on/off switches in every command: they never take the next word as their value, so
 *  `adl render --sheet S1 S2` renders S1 and S2 instead of reading "S1" as the value of --sheet. */
export const SWITCHES = new Set([
  'all',
  'background',
  'base64',
  'canvas',
  'chain',
  'create',
  'dev',
  'entry',
  'force',
  'help',
  'hook',
  'hooks',
  'json',
  'keep-routes',
  'new',
  'open',
  'peek',
  'quiet',
  'restart',
  'sheet',
  'small',
  'snapshots',
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const push = (v: string | boolean) => {
        const cur = out[key];
        if (cur === undefined || typeof cur === 'boolean') out[key] = v;
        else out[key] = Array.isArray(cur) ? [...cur, String(v)] : [cur, String(v)];
      };
      if (eq > 0) push(a.slice(eq + 1));
      else if (key.startsWith('no-')) out[key.slice(3)] = false;
      else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--') && !SWITCHES.has(key)) {
          push(next);
          i++;
        } else out[key] = true;
      }
    } else out._.push(a);
  }
  return out;
}

/** HTTP entry: body is JSON {args: string[]} (the raw CLI arguments after the command name). */
export async function runCommandHttp(
  name: string,
  body: string,
  ctx: CommandContext,
): Promise<{ status: number; body: unknown }> {
  const c = commands.get(name);
  if (!c) return { status: 404, body: { ok: false, text: `Unknown command "${name}"` } };
  let args: ParsedArgs;
  try {
    const parsed = JSON.parse(body || '{}') as { args?: string[]; cwd?: string };
    args = parseArgs(parsed.args ?? []);
    if (parsed.cwd) ctx = { ...ctx, cwd: parsed.cwd };
  } catch {
    return { status: 400, body: { ok: false, text: 'Body must be JSON: {"args": [...]}' } };
  }
  try {
    const r = await c.run(args, ctx);
    return { status: 200, body: r };
  } catch (e) {
    return { status: 200, body: { ok: false, text: (e as Error).message, exitCode: 1 } satisfies CommandResult };
  }
}
