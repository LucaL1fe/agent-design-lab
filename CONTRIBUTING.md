# Contributing

Thanks for helping. Agent Design Lab is a local app: a Node server, a canvas in the browser, a command line and a
Claude Code skill. Start with [docs/dev.md](docs/dev.md) (layout and rules) and [docs/PROGRESS.md](docs/PROGRESS.md)
(what exists and why).

## Setup

```sh
npm install          # also builds the app into dist/app
npm run dev          # the canvas with hot reload, on this repo's ./workspace
```

## Before a pull request

- `npm run check`: type checks (four projects), Biome, unit, property and integration tests.
- `npm run e2e` when you touched the app: Playwright tests in headless Chrome.
- `npm run bench` when you touched rendering, routing or the engine: the numbers must not get worse by more than 10 %.
- Every bug fix comes with a test that failed before the fix.
- Edit the skill in `skills/agent-design-lab/`, then `npm run sync-skill` (a test checks the copies match).

## Principles

- Performance first: cost grows with what is on screen, never with the size of the design.
- The files are the interface: anything the app can do, an agent can do with a command or by editing a file.
- Nothing is lost: removing, rejecting and replacing all keep a way back.
- The screen HTML is untrusted: no scripts run, ever.
