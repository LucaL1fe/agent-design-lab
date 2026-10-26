// Telling that the running server loaded older code than the command line talking to it (the version number
// stays the same between commits).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeChangedAt, serverIsStale } from '../../src/node/version.ts';

describe('codeChangedAt', () => {
  it('is the newest code file in the folders, nested ones included, other files and missing folders ignored', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adl-code-'));
    fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
    const at = (file: string, day: string) => {
      fs.writeFileSync(file, '');
      fs.utimesSync(file, new Date(day), new Date(day));
    };
    at(path.join(dir, 'src', 'old.ts'), '2026-01-01');
    at(path.join(dir, 'src', 'deep', 'new.js'), '2026-02-01');
    at(path.join(dir, 'src', 'notes.md'), '2026-03-01');
    expect(codeChangedAt([path.join(dir, 'src'), path.join(dir, 'missing')])).toBe(new Date('2026-02-01').getTime());
  });
  it("finds this repo's own code", () => {
    expect(codeChangedAt()).toBeGreaterThan(0);
  });
});

describe('serverIsStale', () => {
  it('a server that started before the code changed runs the old code', () => {
    expect(serverIsStale('2026-01-01T10:00:00.000Z', Date.parse('2026-01-01T11:00:00Z'))).toBe(true);
    expect(serverIsStale('2026-01-01T12:00:00.000Z', Date.parse('2026-01-01T11:00:00Z'))).toBe(false);
  });
  it('an unreadable start time never warns', () => {
    expect(serverIsStale('', Date.now())).toBe(false);
  });
});
