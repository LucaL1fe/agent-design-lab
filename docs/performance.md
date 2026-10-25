# Performance notes

Measurements and the decisions they drove. The machine is an Apple M2 Pro with 16 GB and Chrome 155. Headless Chrome
on macOS renders on the real GPU ("ANGLE Metal Renderer: Apple M2 Pro") at about 60 Hz, so headless runs give real
frame timings.

## S1: Shadow DOM fidelity (2026-10-22)
`bench/spikes/s1-fidelity.ts` took 31 phone screens from 3 Claude Design boards of a real project.
Each was split into a standalone HTML page by un-scoping the board CSS, then rendered at t = 1200 ms with every
animation paused, and the renders were compared with pixelmatch:

| Comparison | Result |
|---|---|
| Standalone page vs Shadow DOM host | **31/31 identical (0.000%)** |
| Original board vs standalone page | 23/31 identical. The 8 others differ only in an animated WebP image (a different animation frame), which CSS can't pause. |

**The Shadow DOM strategy is locked:** real `<html>` and `<body>` elements are created inside the shadow root. Author
`html`/`body` selectors and the browser's default styles then match natively. `:root` is rewritten to `html`, and
viewport units become container units on a `contain: strict; container-type: size` host. The host's background comes
from the computed html/body background, which mimics how a page background fills the whole window. Fidelity tests must
mask animated images, or replace them with their first frame.

## S2: drawing far-away screens (2026-10-22)
`bench/spikes/s2-far-tier.ts` measured a 3 s zoom sweep and a 3 s pan at 1440×900, DPR 2:

| Strategy | 1000 screens | 3000 screens |
|---|---|---|
| One DOM element per screen (sprite background), no will-change | 0% dropped | 0–0.6% |
| One DOM element per screen, `will-change: transform` | 2–3% | **83% dropped** |
| One canvas inside the world covering the viewport, redrawn every view change | 0% | 0% |

**Locked:**
- The far tier (mosaic) is a single canvas inside the world, covering the viewport, redrawn from atlas sprites with
  culling. Its cost doesn't depend on how many screens the document has.
- No `will-change` on the world by default; rasterizing a huge layer is what hurts. This gets re-checked with live
  screens in M4.
