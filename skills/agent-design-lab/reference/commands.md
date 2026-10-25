# Commands

Run them as `adl <command>` (see SKILL.md for what `adl` means in this folder). Every command takes `--json` for a
structured result, `--project <id>` when the workspace has several projects (default: the project open in the app),
and `--page <id>` (default: the source-of-truth page). When the canvas is running, commands go through it and the
person sees the change at once; otherwise they write the files directly.

## Projects and pages

| Command | What it does |
|---|---|
| `adl list` | Projects, pages, screen counts per status |
| `adl init "Habit app" [--frame iphone-16]` | New project folder: `project.json`, `pages/truth.json`, `styles/`, `screens/`, `brief.md` |
| `adl copy example-still ["My app"]` | Copy a project into the workspace as a new one to edit. Built-in examples (`example-…`) are listed in every workspace and are read-only: copy one before changing it |
| `adl page new "Design system" [--after truth]` | New page (its id is printed, e.g. `design-system`) |
| `adl page rename <id> "Name"` · `adl page truth <id>` · `adl page delete <id>` | Rename, make it the source of truth, delete (a copy goes to `.adl/trash`) |
| `adl open` | Start the canvas in the background and open or focus its browser tab |

## Screens, arrows, sections

| Command | What it does |
|---|---|
| `adl screen new S4 --title "Plans"` | Write a starter `screens/S4.html` linked to the design system |
| `adl add S1 --entry` | Place a screen; the flow starts here |
| `adl add S2 S3 --after S1 --chain --label "Get started" --label "Continue"` | Place S2 right of S1 and S3 right of S2, with labelled arrows S1→S2→S3 |
| `adl add S5 S6 --after S4 --label "monthly" --label "yearly"` | Two branches from S4 |
| `adl add S6a S6b --after S6 --style proposal` | Two options for S6 in a row under it, joined by dashed "option A/B" arrows |
| `adl add S9 --in Onboarding --status missing --banner "empty state"` | Place in a section with a status and banner |
| `adl link S4 S7 --label "Pay" --trigger "tap pay"` | Arrow with a trigger: `tap <anchor>`, `auto 3s`, `back`, `swipe`, `system`, or `--when "condition"` |
| `adl link S2 S1 --style loop --label "Back"` | Loop arrow (drawn over the top) |
| `adl unlink S4 S7` | Remove the arrows from S4 to S7 |
| `adl portal --to S12 --after S4 --label "Already a member"` | A box that stands for a screen elsewhere (another section or page), with an arrow into it; clicking it goes there, present mode walks through it |
| `adl section "Onboarding" S1 S2 S3` | Make a section and move the screens into it (they are laid out again) |
| `adl section rename Onboarding "First run"` | Change a section title |
| `adl layout [<section>]` | Lay a page or section out again in flow order; items the person moved stay put (`--all` moves them too) |
| `adl remove S9` | Take an item off the page; a screen's HTML file stays and can be placed again |
| `adl patch <page\|project> '{"items":{"S4":{"title":"Plans"}}}'` | Any other change, as a JSON merge patch (`null` deletes a field) |

Arrow styles: `flow` (default), `new` (a new step), `proposal` (dashed, links options), `loop` (back to an earlier
screen). Ids are letters, digits, `-`, `_` and `.`; keep them short and stable (S1, S2, S6a).

## Review

| Command | What it does |
|---|---|
| `adl status S4 needs-fix --banner "save button too small"` | Set status and banner text (status by id or label) |
| `adl status S4 --banner "now with two plans"` | Change only the banner text |
| `adl status S4 changed` | After fixing: status "Changed" (keep or update the banner) |
| `adl status S4 "Test on a small phone" --create --color "#8DB6FF"` | Make a new status (role `review` unless `--role`) and use it |
| `adl note "Copy needs a legal check" --on S9 [--color blue]` | A sticky note that moves with S9 |
| `adl pick S6a` · `adl reject S6b --note "too busy"` | Use a proposal instead of its screen / reject it; both go through History |
| `adl history` · `adl history --restore S6` | What was replaced, rejected or removed; put something back |

Default statuses: `approved` (no banner), `existing` ("Already built": the product as it is today), `needs-fix` and
`missing` (to do), `new`, `changed` and `to-decide` (waiting for review). Projects can define more; `adl list` and
`adl show` use each project's own names.

## Looking and checking

| Command | What it does |
|---|---|
| `adl context` | What the person sees, what they changed since your last look, to-dos, their notes, problems (`--peek` keeps it unread) |
| `adl show S4` | One screen: file, size, status, banner, section, arrows in and out, anchors, notes, warnings |
| `adl render S4 S5` | PNGs of single screens in `.adl/renders/`, plus warnings for cut-off or overflowing text |
| `adl render --flow S1` | One picture of the flow from S1 with the arrow labels between screens |
| `adl render --sheet S1 S2 S3` · `adl render --section Onboarding --sheet` | Several screens on one picture |
| `adl render --section Onboarding` | The section exactly as it looks on the canvas (arrows, banners, notes) |
| `adl validate` | Errors and warnings: broken references, unlabelled arrows, triggers without anchors, missing stylesheets, planned screens |

## Handoff (building from the design)

| Command | What it does |
|---|---|
| `adl handoff` | Write `handoff/` from the approved screens of the source-of-truth page: `HANDOFF.md`, `spec.json`, `tokens.json`, `components.md`, `flows.mmd`, reference PNGs, the source files |
| `adl handoff --all` · `--status approved,existing` · `--page <id>` | Include every screen, or these statuses, or another page |
| `adl handoff check --handoff <folder> [--routes adl-routes.json]` | Compare the built app with the handoff: each screen's picture (similarity ≥ 0.92) and copy, and every tap/auto transition |

## Setup and help

| Command | What it does |
|---|---|
| `adl setup [folder]` | Prepare any folder: `adl.json`, this skill, hooks, a section in CLAUDE.md and AGENTS.md |
| `adl doctor` | Check Node, Chrome, the workspace, the server, the skill and the hooks |
| `adl import claude-design <board-folders> --to <project>` | Import a Claude Design canvas export |
| `adl <command> --help` | Usage of one command |
