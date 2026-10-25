# Design quality

What separates a design the person wants to build from a generic mockup. Read once per project; use the checklist at
the end every time you look at your renders.

## Start from the product

- Who uses it, in what moment, to get what done? Name the one moment that must feel great (the first habit ticked,
  the order placed) and spend extra care there: copy, motion, a small celebration.
- Design the real content: the product's actual words, realistic numbers, prices with currency, dates in the user's
  format, varied and believable names. Never lorem ipsum, never "Title goes here".
- Every screen has one job and one primary action. If a screen has two equal buttons, it has two jobs.

## Layout

- Use the spacing tokens only (a 4 px base, mostly multiples of 8). Same gap for the same relationship everywhere.
- Mobile: 16–24 px side margins; content clears the status bar (about 54 px on iPhone 16) and the home indicator
  (34 px); a tab bar is 49 px plus that indicator. Primary actions sit in the thumb zone at the bottom.
- Touch targets at least 44×44 px (48 on Android), with 8 px between neighbours.
- Web: a max content width (about 1120–1280 px), a 12-column feel, generous section spacing (80–120 px), line length
  45–75 characters. Draw the key pages at `web-mobile` too.
- Align to a few edges. Left-aligned text reads faster than centred text beyond two lines.

## Type and colour

- One or two families. A clear scale (e.g. 12/14/16/20/28/36); body 16–17 px on phones; at most three weights.
- Hierarchy through size, weight and colour together, not size alone. Muted text still needs 4.5:1 contrast (3:1 for
  text from 24 px or 19 px bold).
- Colour roles, not colours: background, surface, text, muted, line, accent, and success/warning/danger. One accent
  colour carries the primary actions; do not use it decoratively elsewhere. Never signal state by colour alone.
- Dark mode only when the brief asks; then design it as its own palette, not inverted.

## Components and icons

- Build each component once in `styles/components.css` (button sizes and variants, input, card, list row, tab bar,
  top bar, sheet, toast, empty state) and reuse it. A button looks the same on every screen.
- Icons: one consistent set, drawn as inline SVG with the same stroke width and size grid (20 or 24 px). Emoji only
  where the product itself would use them.
- Images: real-looking photography or illustration in `assets/`; keep aspect ratios; give every image a role.

## States every flow needs

For each flow, decide which of these exist and draw the ones that change the screen:
first run vs returning, empty, loading (skeletons beat spinners), partial data, error with a way out, offline,
permission asked and denied, success and its next step, long content (long names, many items, large text), and
destructive confirmations. Error copy says what happened and what to do next, in the product's voice.

## Motion

- Motion explains change: entrances ease out (150–300 ms), exits are faster, nothing loops without a reason.
- Save the expressive moment (confetti, a bouncing check) for the success that matters.
- Wrap decorative animation in `@media (prefers-reduced-motion: no-preference)`.
- Remember the still picture freezes at `snapshotAt` (default 1200 ms): make sure that frame looks finished.

## Avoid the generic look

Purple-blue gradients on everything, every element in a rounded card with a shadow, centred text everywhere, tiny grey
labels, decorative emoji, fake charts with random data, three identical feature tiles, "Welcome to App!". Prefer a
clear point of view that fits the brief: a confident type choice, one strong colour, real content, purposeful space.

## Checklist for your renders

Look at every PNG you render and check:

1. Text: nothing cut off, overlapping or running out of the frame; no orphan words in headings; numbers line up.
2. Hierarchy: the eye lands on the most important thing first; one primary action.
3. Spacing and alignment: consistent gaps, shared edges, nothing touching the frame edge by accident.
4. Consistency: the same components and tokens as the other screens and the design system screen.
5. Content: real, specific, matches the brief and the previous screen; arrows' labels match the buttons.
6. States: the flow covers empty, error and success where they apply.
7. Contrast and touch targets are large enough.
8. It looks like the product in the brief, not a template.
