# Building from an ADL source of truth

The design is done when the person has approved its screens on the source-of-truth page. The handoff turns them into a
spec another agent (or you, in the app's own repo) builds from, and a check that says when the build matches.

## Making the handoff (in the design folder)

1. `adl handoff`: only approved screens (and "Already built" ones) go in. If nothing is approved, tell the person instead
   of using `--all`, unless they asked for everything.
2. Read the output: warnings about text that does not fit are design bugs to fix before handing off.
3. Give the builder the `handoff/` folder (copy it into the app repo, or point to it).

## Building (in the app's repo)

1. Read `HANDOFF.md` fully: the rules, the frames, the tokens, the flows, then each screen.
2. Theme first: turn `tokens.json` into the app's theme (CSS variables, Tailwind config, a theme object) with the same
   names and values. Build the components from `components.md` once.
3. Build screen by screen in flow order. Open the reference PNG (`png/<id>.png`, 2x) and the source HTML
   (`source/screens/<id>.html`) side by side: the source has the exact values (spacing, radii, font sizes, colours,
   animation timings). Port its CSS rather than eyeballing the picture.
4. Copy is exact: use the strings as written (they are listed per screen in reading order).
5. Put `data-adl-anchor="<name>"` on the elements named per screen (buttons, links, rows). Implement every transition
   with its trigger: tap, automatic after a delay, a condition.
6. Notes on a screen are requirements. Screens under "Not in this handoff" are not approved: leave placeholders where
   a transition points to them, never invent them.

## Checking

1. `cp handoff/adl-routes.example.json adl-routes.json` and fill in where each screen lives:
   ```json
   {
     "baseUrl": "http://localhost:5173",
     "screens": {
       "S1": { "path": "/" },
       "S2": { "path": "/plans" },
       "S5": { "path": "/plans", "setup": [{ "click": "[data-adl-anchor=yearly]" }], "match": "[data-screen=S5]" }
     }
   }
   ```
   `setup` steps run before the picture (`click`, `fill`, `press`, `wait`); `match` is a selector only that screen has
   (needed when two screens share a URL, e.g. a sheet over a page).
2. Start the app, then `adl handoff check --handoff handoff`.
3. For each failing screen open `handoff/check/<id>.png`: the design, your build, and the differences in red. Fix the
   biggest differences first (layout, then type, then colour), and missing copy. Run the check again.
4. Done when it says PASS. Transitions with other triggers (conditions, system events) are checked by hand: walk them.
