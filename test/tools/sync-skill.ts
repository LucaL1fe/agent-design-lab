// Copy the skill (skills/agent-design-lab, used by the plugin and `adl setup`) to .claude/skills/ for clones of the repo.
// `npm run sync-skill` after editing the skill; test/unit/skill.test.ts fails while the copies differ.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const from = path.join(root, 'skills', 'agent-design-lab');
const to = path.join(root, '.claude', 'skills', 'agent-design-lab');
fs.rmSync(to, { recursive: true, force: true });
fs.cpSync(from, to, { recursive: true });
console.log(`Copied ${path.relative(root, from)} → ${path.relative(root, to)}`);
