# Progress log

Running log for the v1 build. Read this first when resuming work.

- **Plan and spec:** the approved v1 plan and the UI mockup (windows A1–E3) are kept outside the repo.
- **Rule:** keep going milestone by milestone, test everything, fix bugs as they show up, commit at every green step,
  push at every milestone. Stop only at the definition of done; then ping Luca with `cca`.

## Milestones
- [x] M0 Repo, CI, spikes (S1 Shadow DOM fidelity, S2 1000-screen rendering strategies, S3 snapshot throughput)
- [x] M1 Core (schema, canonical I/O, ops/inverse, merge, geometry, router, layout, status, validate)
- [x] M2 Compile, server, watcher, snapshots
- [x] M3 Importer (Claude Design boards); generic examples move to M7 (written with the skill, so they double as eval fixtures)
- [x] M4 Viewer engine, tiers, honest loading, governor, bench (speed gate passed 2026-10-22)
- [x] M5 Editing, sync, undo (13 editing e2e tests; 100 concurrency rounds with 0 lost updates)
- [x] M6 Inspector, statuses, approve, proposals and History, pages (10 review e2e tests; C1/C2/D/E1 checked by eye against the mockup on an imported real project)
- [x] M7 CLI, hooks, plugin, agent pill, context, setup, skill (design eval passed 2026-10-22, see below)
- [x] M8 ⌘K search, present mode, Home and empty states
- [x] M9 Design system, handoff and handoff check (handoff eval: see below)
- [x] M10 Hardening, docs, v0.1 (definition of done met 2026-10-22; public release is Luca's call)

## Now
M10 (hardening, v0.1): done so far: npm package (tsdown, pack + install smoke test), README + CONTRIBUTING + pictures,
example `examples/still`, chaos e2e (45 s in CI, 30 min run), export/home e2e, Activity list, a real app's
wireflow switched over to ADL. Handoff eval passed, chaos runs clean after one fix, final bench within targets,
contact sheet made: the definition of done is met; Luca reviews.
Before going public (Luca decides): publish to npm so `npx agent-design-lab` works; make the GitHub repo public.

## Decisions
- One package with three layers: `src/core` (pure TS), `src/node`, `src/app`. Imports between them are enforced by
  `test/unit/layers.test.ts`.
- Node source runs directly with Node's type stripping (`erasableSyntaxOnly`, `.ts` import extensions). `tsdown` builds
  `dist/node` for publishing; Vite builds `dist/app`.
- Dependencies are pinned to versions at least about 10 days old as of 2026-10-22.
- Shadow DOM with real html/body elements inside the shadow root (S1: pixel-identical to standalone).
- Far tier = one canvas in the world covering the viewport (S2: 0 dropped frames at 3000 screens); no will-change on the world by default.
- Benchmarks run in headless Chrome, which uses the real GPU at 60 Hz on macOS, so no windows pop up on Luca's screen.

## Bench numbers
- Snapshots: 161 screens of a real project from a cold cache in 7.7 s = 20.8/s (6 pages, captured at 512 px).
- Import fidelity (bench/fidelity-import.ts): original board ≈ imported standalone file 161/161; standalone ≈ ADL renderer 161/161 (pixel diff < 0.5 %, animated images masked).
- Import: 161 screens, 153/153 arrows attached, 29 portals (2 are descriptions without a target), 10 notes + 68 chips + 8 titles, CSS 17 MB as drawn → 2 MB in 54 shared sheets.

- Bench (bench/run.ts, headless Chrome on the real GPU, 1440×900 @2x, median of 3):
  | | Real project, 161 | Stress 1000 |
  |---|---|---|
  | first content / overview complete | 164 / 265 ms | 210 / 268 ms |
  | idle fit-all | 0 % dropped | 0 % |
  | zoom sweep fit→100 %→fit | 0.83 %, 0 long frames | 0.42 %, 0 long frames |
  | pan at 50 % / 70 % / fit-all | 0 / 0 / 0 % | 0 / 0 / 0 % |
  | idle at 100 % with live screens | 0 % | 0 % |
  | Chrome memory (RSS, all processes) | ≈ the empty-page baseline (~900 MB headless); JS heap 5–9 MB | same |
- Final bench (M10, warm, after all editing/review/search/present features; median of 5 / 3 runs):
  Real project (161): open 114 / 205 ms, zoom sweep 0 % dropped and 0 long frames, pans 0 %, Chrome 804 MB, heap 5 MB.
  Stress 1000: open 152 / 229 ms, zoom sweep 0.42 %, pans ≤ 0.56 %, 0 long frames, Chrome 887 MB, heap 8 MB.
  (The first run after a renderer-version bump re-renders every picture and is slower; measure warm.)
- Agent write → canvas (bench/write-latency.ts, 30 runs): page file → banner p95 111 ms; screen HTML → live screen
  p95 183 ms; screen HTML → still picture p95 401 ms (target ≤ 500 ms).
- Fixes the bench found: sprite cache thrash with 1000 far screens (now flat colour under 16 px + 2500-image LRU) and a 67 ms frame when 1000 sprites started loading at once (now max 24–80 new images per frame).

## Bugs found and fixed by tests (M5)
- Edge-handle hover used the CSS `scale` property, which composes with `translate` and threw the handle away from the cursor.
- Choosing a note colour rebuilt the note element while typing (focus lost) → notes/texts now update in place.
- Typing right after creating a note/text/label went to tool shortcuts → editors open synchronously (engine.renderNow).
- Redo inverted twice (did nothing); safe undo checked every step against the original state (a field changed twice in one step was only half undone).
- Toasts swallowed clicks on the canvas underneath → only their action button takes clicks.
- A stale agent write could be merged against the wrong base after an earlier agent write kept the same rev → the agent's written content becomes the base for that rev.

## Bugs found and fixed (M6)
- The History page showed nothing: archived items were left out of layout everywhere, including History itself.
- "New page" lost its rename field: navigating to the new page closed and reopened the menu, dropping component state
  (rename state now lives in the app store).
- A section title pinned to the left window edge kept the full section width and ran over the next section's title.
- Page menu offered Move up/down at the ends, and moving the last page down swapped it with History.

## Design eval (2026-10-22)
Fresh clone → `npm install` (2.5 s) → `./adl serve` → `claude -p "Create an app onboarding flow for a meditation app"`
(no questions allowed). 19 min, no help: project "Still" with a design system page, 17 iPhone screens in 5 sections
(welcome + 3 questions, loading, plan, breathing session, mood check, reminder ask + iOS prompt + denied, sign-in,
offline error, subscription with free path, first-run home, returning-user sign-in + home), labelled arrows, banner
questions on 8 screens, notes for open points, nothing approved, `adl validate` clean. Quality: real copy, one coherent
design system, serif headings, consistent components.
It reported three ADL bugs, all fixed with regression tests: render ignored `<meta name="adl:frame">`; renders cut off
at 1200 px; renders could start before web fonts loaded.

## Handoff eval (2026-10-22)
The 17 "Still" screens approved (playing the person) → `adl handoff` → an empty folder with only `handoff/` →
`claude -p "Here is the source of truth … Build me exactly this as a Vite + React + TypeScript web app"`. 32 min, no
help: a real React app (components, state, routes; no iframes or copied pictures), `adl handoff check` PASS: 16/17
screens pixel-identical, S3 at similarity 0.988 (0.2 % of pixels: the design's own HTML shows the same difference, a
renderer detail), 23/23 tap and auto transitions; the one condition transition (offline sign-in) tested by hand. It
treated notes as requirements, marked every label it had to invent "not in the design", and kept a screen a note
suggested dropping because the approved flow has it. Target was ≥ 90 % of screens at ≥ 0.92 and all transitions.

## Bugs found and fixed (M7–M9)
- `add --chain` without `--after` gave the first arrow the second label.
- Restored "not picked" options pointed at the replaced screen; picking now re-links them to the pick.
- Same-millisecond activity entries could be missed by `context` (times are now strictly increasing).
- Esc after a ⌘K jump did nothing: a listener re-registered on every render was removed mid-dispatch.
- ⌘K highlight offsets were shifted by emoji variation selectors.
- Canvas renders raced the app's first view, and shot before all pictures were drawn (engine.pending()).
- Arrows into the top of a screen cut through its caption and banner; labels sat on notes; imported chips overlapped.

## Chaos runs (2026-10-22)
test/e2e/chaos.test.ts: random drags, clicks, notes, undo/redo, search, present, keys, zoom, while an agent writes
stale page files, half-written JSON, screen files, renames away and back, new screens. Afterwards: no console errors,
every file parses and equals the server's state, the canvas equals the server.
- 30 min (about 2,300 actions): one error, a 404 for a just-replaced compiled screen (fixed: the server keeps recent
  versions, present mode tolerates a replaced one).
- 15 min after the fix: clean.
- 30 min: failed only its end check, the page file's rev one behind the server's with identical content. By design:
  when an agent writes back what the server holds, the server does not rewrite the file under it. The check now
  compares content and requires file rev ≤ server rev.
- 30 min with that check (1,667 actions): clean.

## Hardening from real use (2026-10-23)
Luca's rule: a real app's wireflow is designed in ADL now, and every tool problem met along the way gets a real fix with
a test, no workaround in the project files.
- ⌘K search: the rest of the page stayed dimmed after a jump until Esc; dimming now shows only while the palette is open.
- validate: a rejected/replaced option on History keeps `proposalFor` (for restore) and was reported as a dangling
  proposal ("S6a: proposalFor "S6" does not exist on this page" after `adl reject`).
- Router: explicit `fromSide: left` / `toSide: right` was ignored (always over the top); option links (style proposal)
  now leave from the bottom to a row of options below and go straight across to an option on the left, instead of
  looping over the top of the section.
- Layout: a section's stored `w`/`h` is a minimum; it grows to hold its items and the notes hanging off them (options
  placed under a screen ended up outside the frame).
- Layout: `adl layout <section>` moved a screen without arrows (a just-picked option) behind all flow starts; flow
  starts and loose screens now keep their file order.
- CLI: switches (`--sheet`, `--entry`, `--all` …) swallowed the next word, so `adl render --sheet S1 S2` rendered only S2.
- Layout: a section that grows past its stored size pushes the sections beside it (right) and below it (down),
  keeping the gaps the person left; pushes cascade; only drawn positions move, the files keep what the person placed.
- Render: `adl render --canvas` of a big page was mostly unpainted grey (Chrome rasters only part of one giant
  screenshot; seen on a real 166-screen page at --max-width 4000). Big pictures are now taken in tiles at one zoom
  and stitched (result data says how many); section titles stay at their section while capturing (they used to stick
  to every tile's left edge).
- Pick: picking an option of an option dropped it out of the chain (it became a plain screen); it now takes the
  replaced screen's place, including what that screen was an option for, so a second pick can replace the original.
- Pick: notes on the replaced screen (flow chips like "from S1: tap Start") were left pointing at History; they move to
  the pick.
- `adl list` said the History page had 0 screens (it skipped archived screens, and every History screen is archived);
  it now counts them and says what happened ("8 replaced · 9 not picked · 3 rejected").
- Source of truth without duplicates (each screen drawn once, other flows reach it through portals):
  `adl show` and the side panel list the portals that stand for a screen ("via: portal … from A1"), on any page;
  `adl validate` warns about screens nothing leads to on the source-of-truth page (no arrow, no portal, not a
  start), portals without a target and portals pointing at a section or note (core/reach.ts).
- Following a portal to another page did nothing (an event no one listened to); it opens that page at the screen.
- Pick: portals that stood for the replaced screen (on any page) were left pointing at History; they now lead to
  the pick, so flows from other areas still arrive.
- Layout: notes hanging off one item stacked on the same spot; they now stack under each other (notes placed by hand
  stay). Option rows are placed as one block, under the screen and its notes and below any row in the way (two
  neighbours' rows used to interleave and the later options piled up in a column, with arrows across screens).
- Open: a screen whose only colour is `<body style="background:…">` showed white on the canvas in a fresh project
  (the integration test uses a coloured block instead); single-screen renders show it right. Not found yet.
- Cost: a shared stylesheet with animations for many screens (an onboarding `motion.css`, rules scoped by a
  per-screen data attribute) made every screen that links it report "565 endless animations" and count as heavy in the
  live-screen budget. A rule's animations now count only where its selector's classes, ids and attributes occur in
  the screen (`ruleNeeds` in compile/css.ts; never undercounts a rule that can match).
- Stills: every screen froze at the project's `snapshotAt` (1.2 s), so screens that settle later (a 3 s liquid
  button, a number that flips at 1.4 s, a list that cascades in for 5 s) looked unfinished on the zoomed-out
  canvas, in `adl render` and in handoff pictures. A screen sets its own moment with
  `<meta name="adl:snapshot" content="4200">`; the spec carries it per screen and `handoff check` freezes the built
  app at the same moment.
- Layout: a section without a stored size (sized by what it holds, e.g. after `adl layout <section>` put a flow in one
  row, or one made with `adl section`) never pushed its neighbours: it grew right over the next section (seen on a
  real page). Sections that start right of it on the same band are now pushed right, the ones
  below that overlap it sideways are pushed down, keeping SECTION_GAP.
- A pick could not be taken back: restoring the screen it replaced left the pick in its place with the original's
  arrows, and the original came back with none. A pick now records what it took over (arrows, the link to it, notes,
  portals on any page) on the replaced screen; restoring that screen undoes the pick exactly, the pick becomes its
  option again, and the options that were not picked come back linked from it. Older records: every arrow and
  portal of the pick goes back.
- Sections inside a section stacked into one tall column at the parent's very edge (five groups inside one section
  made an 18 000 px column). They now sit side by side inside the parent's padding, in file order, so a parent reads
  left to right like the rows of the page.

## Bugs found and fixed (M10)
- The server only registered commands when started by the CLI: PNG export and "New project" answered "Unknown
  command" for any other embedder of startServer (found by the export e2e test).
- New projects had no "Changed" status although the skill tells Claude to use it after a fix.
- The CLI missed a running server when the workspace path went through a symlink (macOS /tmp); paths are real paths now.
- ⌥I (side panel) was promised in the tooltip but not handled.
- Arrow labels overlapped each other; lines over the top crossed section titles.

## After Luca's first test (2026-10-22)
- Screens run live from 150 px wide on screen (back below 120), so 45 % zoom animates.
- A drawn arrow is plain (default style, no label); name it later with double-click or Enter.
- The side panel opens only when you open it and remembers that; performance hints stay out of it.
- Portals by hand: drop an arrow on a blank spot (page background or inside a section), or right-click a blank spot
  → "Add a portal here…"; a picker asks which screen (any page) it stands for. For Claude: `adl portal`.
- Arrows attach at the middle of a side like Figma's connectors (they sat 13 % down, copied from the old boards);
  screens that face each other get one straight line, arrows leaving the same side start together and split.
- Editors near the canvas edge scrolled the overlay (outlines 132 px off): the canvas clips, editors focus without
  scrolling.
- A tab opened before a server restart kept retrying with the old key forever ("Reconnecting…"), so changes it held
  would never have been saved. The server now lets its own pages (exact origin) back in and sends the new key; the
  tab catches up on what changed meanwhile, and offers "New version · Reload" when the app was rebuilt
  (test/e2e/restart.test.ts).
- `adl render` of a screen taller than 1200 px (390x1263 and 390x1601 on a real page) showed the screen's top
  again over its last ~87 px instead of the tab bar: the window was grown after the screen was drawn. One capture
  beyond the window was no cure (a 390x1333 screen at 2x came out as repeated zoomed-in tiles), so tall screens are now
  taken in window-high tiles and stitched; test "render paints the bottom …" (top, middle, bottom, both edges).
- Deleting a screen that had options (a screen with 7 options) left them pointing at nothing (7 errors in validate)
  and nothing leading to them. Now the first option left takes its place (arrows, notes, spot, portals, as "Use
  instead" does) and the others become its options; the toast and `adl remove` say so.
- `adl portal --after X --trigger "tap see-all"` dropped the trigger without a word; it now sets it (and warns when X
  has no such anchor).
- A command right after a screen edit (a chip removed, then `adl render`) saw the old screen: the CLI
  hands commands to the running server, whose watcher had not caught up. The server now settles with the disk
  (pending file events at once, plus any file that changed unseen) before each command.
- Rejecting a screen left its notes on the page anchored to nothing. Notes now go to History with
  their screen, stay on it there, and come back with it on restore.
- Layout left screen-sized holes (~1100 px between two screens of a real section): a screen that had to move down
  stepped by its own height. It now goes straight under what is in the way, notes included (option rows too).
- `adl layout <section> --all` left the section at its old stored size (a minimum), so a compacted section kept
  ~1000 px of empty frame; --all now also lets it fit its content.
- A screen sent to History (an option not picked) left its portal on the page, led to by nothing. A portal
  only the archived screen led to now goes along ("went with <screen>") and comes back when the screen is restored.
- Moving one screen in an all-automatic section (next to another) made the flow's start sit right of it,
  so everything jumped down and right. A start that nothing leads to takes the group's top-left spot while it is free.
- `adl add A B C --entry` marked only A as a start, so screens added side by side (three push screens)
  read as unreached. Every one is a start now; a chain still starts once.
- The agent pill listed two agents that posted in the same millisecond oldest first (a flaky test, 1 run in 6). The
  later update now comes first.

## Built-in example (2026-10-25)
- Every workspace lists the examples that ship in `examples/` (with a project.json) as the last cards on the Projects
  page, with an "Example" badge; they are in the npm package now (`files`, without `.adl`). Id `example-<folder>`.
- Read-only on every path: the server refuses changes (`apply`), editing commands refuse before writing (`withEdit`),
  the app refuses in `ProjectModel.apply` and offers "Make a copy" (top bar and toast). Commands never pick an example
  unless named with --project. Its caches, activity and snapshots live in `<workspace>/.adl/example/<id>`
  (`ProjectState.adl`), never in the package. `adl copy <project> [name]` copies any project into the workspace.
- Toasts that confirmed a change (delete, approve, pick, reject, restore, delete page or status) showed even when
  nothing was applied; they now depend on the change going through.
- Next: Wordfern (`examples/wordfern/brief.md`) designed with ADL becomes the default example; Still stays as "what one
  prompt produces".

## Open bugs
(none known)
