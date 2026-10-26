---
name: agent-design-lab
description: Design apps and websites on the Agent Design Lab canvas as live HTML screens joined by labelled arrows (a wireflow), with statuses, banner texts, notes and proposals the person reviews. Use when asked to design, mock up, wireframe or prototype an app, a flow, onboarding, screens, a website or a landing page; to change or iterate on a design on the canvas; or to build an app from an ADL source of truth (handoff).
---

# Agent Design Lab

Agent Design Lab (ADL) is a local canvas. You design; the person looks, moves things, comments through statuses and
banner texts, and approves. The approved screens on the project's source-of-truth page become the spec someone builds
from later. Everything is plain files: you write HTML screens and run small commands; the canvas updates live.

**Running commands.** `adl` below means: `./adl` in a clone of the Agent Design Lab repo, otherwise what CLAUDE.md
says (usually `npx adl` or `npx agent-design-lab`). Every command takes `--json`; `adl help` lists them all;
[reference/commands.md](reference/commands.md) has the details.

## Before you start

1. `adl list` shows the projects and pages. If the person names an existing project, work there.
2. `adl open` starts the canvas in the background and opens it in the browser (once per session is enough; it brings
   an open tab forward instead of opening another).
3. If the session-start or prompt hook printed "Changed by the person since your last look", read it: that is their
   feedback. Otherwise run `adl context` at the start of every design turn.

## The process (always in this order)

1. **Brief.** Ask at most three questions, and only ones whose answers change the design (platform, audience, the
   one thing that must work). If the request is clear, ask nothing. Write the answers into the project's `brief.md`.
2. **Project.** `adl init "Name" --frame iphone-16` for an app, `--frame web` for a website (frames are listed in
   [reference/format.md](reference/format.md)). Skip if the project exists.
3. **Design system first.** Replace the starter `styles/tokens.css` with this product's tokens (colour roles, type
   scale, spacing, radii, shadows, motion) and put shared components in `styles/components.css` (buttons, inputs,
   cards, list rows, tab bar, nav). Draw one screen `DS1` (frame `board`) that shows the palette, type scale and
   components on its own page: `adl page new "Design system"`, then `adl add DS1 --page design-system`. Every later
   screen uses only these tokens and classes. Read [reference/design-quality.md](reference/design-quality.md) once per project.
4. **Wireflow before pixels.** Place planned screens and labelled arrows first:
   `adl add S1 --entry`, `adl add S2 S3 S4 --after S1 --chain --label "Get started" --label "Continue" ...`.
   Include the states real products need: empty, loading, error, offline, permission asked/denied, success, and the
   first-run versus returning version where it differs. Group flows into sections (`adl section "Onboarding" S1 S2 S3`).
   Lay a flow out the way the person lives it, left to right: what happens outside the product (a message or email, the
   phone's camera, a website, an app store, a system dialog) sits left of the screens it leads into, never under them or
   after them. A flow that starts outside is an entry (`--entry`) and the leftmost screen of its row; when a section mixes
   both, give the outside part its own columns on the left and label them ("Outside the app", "In the app").
   When a flow continues in another section or page, end it in a portal instead of a long arrow
   (`adl portal --to H1 --after S9 --label "Done"`).
   Every navigation arrow gets a label saying what the person taps or what condition sends them there, plus a trigger
   (`--trigger "tap cta"`, `--trigger "auto 3s"`, `--when "no habits yet"`).
5. **Screens.** Write `screens/<id>.html` for each planned screen (start from `adl screen new <id> --title "…"` or
   [templates/](templates/)). Real copy, not lorem ipsum. Put `data-adl-anchor="name"` on every element an arrow
   starts from and use the same name in the arrow's trigger. CSS animations are welcome; scripts are removed.
6. **Look at your work.** `adl render --flow S1` (one picture of the flow) and `adl render S4 S5` (single screens), then
   open the PNGs with the Read tool and check them like a design reviewer: text fits, nothing overlaps or is cut off,
   hierarchy is clear, spacing is consistent, it matches the brief and the design system. Fix and render again.
   `adl validate` must report no errors and no warnings you can fix.
7. **Hand it to the person for review.** New screens get status `new` automatically. Add a banner text saying what to
   look at (`adl status S4 new --banner "two plans or three?"`) and notes for open questions
   (`adl note "copy needs legal check" --on S9`). **Never approve:** approval is the person's call.
8. **Report** in a few lines: what you made, where (page and section), what to look at first. No file lists.

## Iterating on feedback

- Statuses with role `todo` (Needs a fix, Missing) and their banner texts are the person's work orders. Notes by the
  person are comments. `adl context` lists both, plus everything they changed since your last look.
- After fixing a screen, set it to `changed` with a banner saying what changed
  (`adl status S4 changed --banner "bigger save button, moved up"`).
- When unsure between options, draw them as proposals next to the screen instead of picking:
  `adl add S6a S6b --after S6 --style proposal` with a banner on each saying how it differs. The person picks one with
  "Use instead"; the others go to the History page. You can do the same with `adl pick` / `adl reject` if asked.
- Respect what the person placed by hand: items they moved stay where they are; `adl layout` never moves them.
- Keep ids stable. Rename by changing the caption (`--title`), not the id, so arrows and history stay intact.

## Several agents at once

The person may run several Claude Code sessions on the same project, each on its own part (a flow, a page). The canvas
stays usable for everyone and nothing waits for anyone:
- Take a part of your own: your section or page, your screen ids (agree on a prefix, e.g. `CK1…` for checkout).
- Change pages with commands (`adl add`, `adl link`, `adl status` …): each one is applied on its own, so two agents
  never overwrite each other. If you edit `pages/*.json` directly, read it right before writing.
- Never edit a screen file that belongs to another agent's part.

## Rules for screen files

- A screen is a standalone HTML document that would also open in any browser: `<!doctype html>`, a `<title>` (the
  caption), `<meta name="adl:frame" content="iphone-16">` when it differs from the project frame, and
  `<link rel="stylesheet" href="../styles/tokens.css">` plus `components.css`. Screen-only rules go in one `<style>`.
- Size is the frame. Content taller than a fixed frame is cut off, which is right for app screens (design the
  scroll position you want to show, or draw a second screen "S4 · scrolled"). Websites use `Wxauto` frames.
- Images and fonts go in `assets/` and are referenced relatively (`../assets/hero.webp`). Google Fonts `<link>`s work.
- No `<script>`: it is removed. Interactions are shown with more screens and arrows, not with JavaScript.
- `data-adl-go="S7"` on an element makes it a hotspot in present mode (clicking it walks to S7).
- Do not edit anything under `.adl/` (cache and history). Prefer commands for pages; if you edit `pages/*.json`
  directly, keep it valid and keep the ids; your write is merged with the person's live edits.

## Building from an ADL source of truth

When asked to build the real app or site from a design, see [reference/handoff.md](reference/handoff.md). In short:
`adl handoff` in the design folder writes `handoff/` (only approved screens; say so if nothing is approved yet). The
builder follows `HANDOFF.md` screen by screen, keeps the `data-adl-anchor` attributes, fills `adl-routes.json` and runs
`adl handoff check` until it passes. The design wins over taste: match it exactly, and ask when the design and the
codebase disagree.
