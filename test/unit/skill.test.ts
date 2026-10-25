// The skill and the repo wiring that make "clone, open Claude Code, design" work without setup.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { commands } from '../../src/node/commands/registry.ts';
import '../../src/node/commands/index.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const skill = path.join(root, 'skills', 'agent-design-lab');

function files(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
    .sort();
}

describe('skill', () => {
  it('has frontmatter with a name and a description that says when to use it', () => {
    const text = fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8');
    expect(text.startsWith('---\nname: agent-design-lab\ndescription: ')).toBe(true);
    expect(text).toMatch(/description: .*Use when/);
  });

  it('the copy in .claude/skills is identical (run `npm run sync-skill`)', () => {
    const copy = path.join(root, '.claude', 'skills', 'agent-design-lab');
    expect(files(copy)).toEqual(files(skill));
    for (const f of files(skill))
      expect(fs.readFileSync(path.join(copy, f), 'utf8'), f).toBe(fs.readFileSync(path.join(skill, f), 'utf8'));
  });

  it('documents every command', () => {
    const doc = fs.readFileSync(path.join(skill, 'reference', 'commands.md'), 'utf8');
    for (const c of commands.values()) if (!c.hidden) expect(doc, c.name).toContain(`adl ${c.name}`);
  });

  it('links only files that exist', () => {
    for (const f of files(skill).filter((x) => x.endsWith('.md'))) {
      const text = fs.readFileSync(path.join(skill, f), 'utf8');
      for (const m of text.matchAll(/\]\(([^)#]+)\)/g)) {
        if (/^https?:/.test(m[1]!)) continue;
        expect(fs.existsSync(path.join(skill, path.dirname(f), m[1]!)), `${f} → ${m[1]}`).toBe(true);
      }
    }
  });
});

describe('repo wiring', () => {
  it('clone hooks and plugin hooks call the same script for the same events', () => {
    const clone = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
    const plugin = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8'));
    expect(Object.keys(clone.hooks)).toEqual(Object.keys(plugin.hooks));
    for (const [event, entries] of Object.entries<any[]>(clone.hooks)) {
      expect(entries[0].hooks[0].command).toBe(`node "$CLAUDE_PROJECT_DIR/hooks/adl-hook.mjs" ${event}`);
      expect(plugin.hooks[event][0].hooks[0].command).toBe(`node "\${CLAUDE_PLUGIN_ROOT}/hooks/adl-hook.mjs" ${event}`);
    }
  });

  it('the plugin and its marketplace agree on the name', () => {
    const p = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
    const m = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
    expect(m.plugins[0].name).toBe(p.name);
    expect(m.plugins[0].source).toBe('.');
  });

  it('the hook script has no imports outside node:', () => {
    const text = fs.readFileSync(path.join(root, 'hooks', 'adl-hook.mjs'), 'utf8');
    for (const m of text.matchAll(/from '([^']+)'/g)) expect(m[1]).toMatch(/^node:/);
  });
});
