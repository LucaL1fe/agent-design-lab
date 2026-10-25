# Agent Design Lab

This folder is Agent Design Lab: a local canvas where you design apps and websites as live HTML screens joined by
labelled arrows, and the person reviews them. Designs live in `./workspace` (set in `adl.json`).

- **Designing** ("design an onboarding flow for…", "make a website for…", "fix S4"): use the `agent-design-lab` skill
  (`.claude/skills/agent-design-lab/SKILL.md`) and follow its process. Run its commands as `./adl <command>`
  (`./adl help` lists them); `./adl open` shows the canvas.
- Never mark screens approved: approval is the person's call on the canvas.
- **Building an app from a design:** `./adl handoff`, then the skill's section "Building from an ADL source of truth".
- **Changing Agent Design Lab itself** (only when asked to work on the tool, not on a design): read `docs/dev.md`.
