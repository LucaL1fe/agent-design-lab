# Working on Agent Design Lab

Read `docs/PROGRESS.md` first: it is the running log (milestones, decisions, bench numbers, known bugs).

## Layout
- `src/core`: pure TypeScript (no DOM or Node APIs): format types and schema, canonical JSON, ops with inverses,
  3-way merge, layout, arrow routing, statuses, validation, change descriptions. `core` never imports `node` or `app`
  (enforced by `test/unit/layers.test.ts`).
- `src/protocol`: message types between server and app.
- `src/node`: the workspace service (single writer), compile, server, snapshots, CLI commands (`commands/`), setup.
- `src/app`: the canvas engine (imperative, no React while panning) and the React chrome.
- `skills/agent-design-lab`: the skill (canonical copy). `.claude/skills/agent-design-lab` is a copy for clones:
  run `npm run sync-skill` after editing the skill.
- `hooks/adl-hook.mjs`: the Claude Code hook (no dependencies). `hooks/hooks.json` is the plugin's,
  `.claude/settings.json` the clone's; the repo root is also the plugin and its marketplace (`.claude-plugin/`).

## Rules
- Node runs `.ts` directly (type stripping): `.ts` extensions in imports, only erasable syntax (no enums, parameter
  properties or namespaces).
- `npm run check` before every commit (typecheck + Biome + Vitest). `npm run e2e` for Playwright end-to-end tests,
  `npm run bench` for the performance bench (headless Chrome on the real GPU).
- Every bug gets a failing test first, then the fix.
- The look lives in the tokens at the top of `src/app/styles/app.css`.
- Biome formats CSS too; edit CSS with care (no blind string replacement).
