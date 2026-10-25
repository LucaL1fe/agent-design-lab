// The command line as Claude Code runs it: no terminal. `adl open` must start the server in the background, open the
// browser once and return quickly.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const repo = path.resolve(import.meta.dirname, '..', '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adl-cli-'));
const pids: number[] = [];
afterAll(() => {
  for (const pid of pids) {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('adl open without a terminal', () => {
  it('starts the server in the background and opens the browser once', () => {
    // a recording stand-in for the commands that open a browser
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const log = path.join(dir, 'opened.log');
    for (const name of ['open', 'xdg-open', 'google-chrome'])
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "$*" >> "${log}"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'adl.json'), '{"adl":1,"workspace":"workspace"}\n');
    fs.mkdirSync(path.join(dir, 'workspace'));
    const t0 = Date.now();
    // regression: the background child had no terminal either and started another background child, forever
    const r = spawnSync(process.execPath, [path.join(repo, 'src', 'node', 'cli.ts'), 'open'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      timeout: 30000,
    });
    expect(r.stdout).toMatch(/running in the background: http:\/\/localhost:\d+/);
    expect(Date.now() - t0).toBeLessThan(10000);
    const port = Number(/localhost:(\d+)/.exec(r.stdout)![1]);
    const reg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.adl', 'servers.json'), 'utf8')) as {
      pid: number;
      port: number;
    }[];
    const entry = reg.find((e) => e.port === port)!;
    pids.push(entry.pid);
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(log) && Date.now() < deadline) spawnSync('sleep', ['0.1']);
    const opened = fs.readFileSync(log, 'utf8').trim().split('\n');
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain(`http://localhost:${port}`);
  }, 40000);
});
