# File format (version 1)

The files are the API: the canvas, the CLI and you all edit the same plain files. Commands are the safe way to change
pages; editing the JSON directly works too (the canvas merges your write with the person's live edits).

```
<workspace>/
  <project>/
    project.json          name, pages, source of truth, frame, statuses, arrow styles
    brief.md              what is being designed, for whom
    pages/<page>.json     items (screens, sections, notes, texts) and arrows
    screens/<id>.html     one standalone HTML document per screen
    styles/tokens.css     the design tokens (single source)
    styles/components.css shared components built from the tokens
    assets/               images, fonts, icons
    .adl/                 cache, history, renders (never edit; not committed)
```

## project.json

```json
{
  "adl": 1, "rev": 3, "name": "Habit app",
  "pages": ["truth", "design-system"],
  "sourceOfTruth": "truth",
  "frame": "iphone-16",
  "styles": ["styles/tokens.css", "styles/components.css"],
  "statuses": [{"id": "needs-fix", "label": "Needs a fix", "color": "#FF9F43", "role": "todo", "banner": true}],
  "defaultStatus": "new",
  "snapshotAt": 1200
}
```

- `frame`: a preset or `WxH`. Presets: `iphone-16` 393×852, `iphone-16-pro-max` 440×956, `iphone-se` 375×667,
  `android` 412×915, `ipad` 820×1180, `android-tablet` 800×1280, `laptop` 1280×800, `desktop` 1440×900,
  `web` 1440×auto, `web-mobile` 390×auto, `board` 1200×auto. `auto` height = the page's full length.
- `statuses[].role`: `approved` (done, no banner), `existing` (how the product is today), `todo` (work for you),
  `review` (waiting for the person). `createdBy` says who made a status.
- `snapshotAt`: the moment (ms) at which animations are frozen for still pictures and reference PNGs.

## pages/<page>.json

```json
{
  "adl": 1, "rev": 12, "name": "Source of truth",
  "items": {
    "Onboarding": {"kind": "section", "title": "Onboarding"},
    "S1": {"kind": "screen", "parent": "Onboarding", "status": "approved", "entry": true},
    "S2": {"kind": "screen", "parent": "Onboarding", "status": "needs-fix", "banner": "bigger button"},
    "S2a": {"kind": "screen", "parent": "Onboarding", "status": "new", "proposalFor": "S2"},
    "n-k2x3": {"kind": "note", "text": "Use the brand green", "anchor": "S2", "by": "human"}
  },
  "arrows": {
    "S1>S2": {"from": "S1", "to": "S2", "label": "Get started", "trigger": {"on": "tap", "el": "cta"}},
    "S2>S2a": {"from": "S2", "to": "S2a", "label": "option A", "style": "proposal"}
  }
}
```

- Items without `x`/`y` are placed automatically (right of the screen their arrow comes from; options in a row under
  the screen they would replace). `x`/`y` are relative to the parent section. `pinned: true` means the person placed
  it; leave its position alone.
- A screen item's id is its file name (`screens/S2.html`) unless it sets `"screen": "<file id>"` (the same file placed
  twice). A screen whose file does not exist yet is a planned placeholder.
- Screen fields: `status`, `banner` (text after the status label), `title` (caption; default the HTML `<title>`),
  `frame` (override), `entry` (a flow starts here), `proposalFor` (an option for another screen).
- Portals (`"kind": "portal"`): a box standing for a screen elsewhere, `text` (first line the title, the rest the
  detail) and `target` (`"S12"` on this page, `"page:<page>/<id>"` on another).
- Notes: `text`, `color` (yellow, blue, green, pink, grey, orange, purple), `anchor` (moves with that item), `by`
  (`human` or `agent`), `resolved`.
- Arrows: `from`, `to`, `label`, `style` (`flow`, `new`, `proposal`, `loop`), `trigger` (`on`: tap, auto, condition,
  back, swipe, system; `el`: the `data-adl-anchor` tapped; `after`: ms for auto; `when`: a condition in words).
- The page `history` holds replaced, rejected and removed items with everything needed to restore them.

## screens/<id>.html

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="adl:frame" content="iphone-16">
<title>Choose a plan</title>
<link rel="stylesheet" href="../styles/tokens.css">
<link rel="stylesheet" href="../styles/components.css">
<style>
  .plans { display: grid; gap: var(--space-3); }
  .badge { animation: pop 600ms var(--ease-out) both; }
  @keyframes pop { from { transform: scale(0.6); opacity: 0; } }
</style>
</head>
<body>
  <main class="screen">
    <h1>Choose a plan</h1>
    <div class="plans">…</div>
    <button class="btn" data-adl-anchor="cta" data-adl-go="S5">Start free trial</button>
  </main>
</body>
</html>
```

- Scripts and inline event handlers are removed. CSS animations, transitions, `@keyframes`, `@property`, gradients,
  filters, blend modes, SVG and web fonts all work. Animations are frozen at `snapshotAt` in still pictures; a screen
  whose look settles later (a long entrance, a button that fills) sets its own moment with
  `<meta name="adl:snapshot" content="4200">` (ms).
- A stylesheet shared by many screens may hold rules for each of them (scoped by a class or attribute on the screen's
  root): a screen's animation cost counts only the rules whose classes, ids and attributes occur in that screen.
- `vh`/`vw` and size media queries follow the frame, so `min-height: 100vh` fills the screen.
- Shared stylesheets are loaded once for all screens on the canvas: keep shared rules in `styles/`, not copied into
  every screen (validate warns about large per-screen CSS).
- `data-adl-anchor="name"`: an element arrows can start from (`--trigger "tap name"`).
- `data-adl-go="S7"`: a hotspot in present mode.
