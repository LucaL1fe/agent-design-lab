// A section's PNG button downloads the section as drawn on the canvas: every screen's picture present (not the grey
// stand-in), at the section's own framing (not the page's first view).
import fs from 'node:fs';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, harness, openDemo } from './fixture.ts';

let h: Harness;
beforeAll(async () => {
  h = await harness({ snapshots: true });
  await openDemo(h);
}, 120000);
afterAll(async () => h?.close());

describe('PNG export', () => {
  it('the section button downloads the whole section with every screen drawn', async () => {
    const download = h.page.waitForEvent('download', { timeout: 60000 });
    await h.page.evaluate(() => {
      const t = [...document.querySelectorAll('.sec-title')].find((x) => x.textContent?.includes('Library'));
      const btn = t?.querySelector('[data-act="png"]') as HTMLElement | null;
      if (!btn) throw new Error('no PNG button on the Library section');
      btn.click();
    });
    // regression: the server only knew the commands when started by the CLI, so this answered "Unknown command"
    const d = await download;
    expect(d.suggestedFilename()).toBe('FLOW-Library.png');
    const file = await d.path();
    const png = PNG.sync.read(fs.readFileSync(file));
    // the section is 1900 × 1150 world px, framed with its title and padding at 2x: wider than tall
    expect(png.width).toBeGreaterThan(png.height);
    // the screens' colours from the fixture are there (B2 is #4f1d2b), not only the canvas and grey stand-ins
    const has = (r: number, g: number, b: number) => {
      for (let i = 0; i < png.data.length; i += 4 * 7)
        if (Math.abs(png.data[i]! - r) < 6 && Math.abs(png.data[i + 1]! - g) < 6 && Math.abs(png.data[i + 2]! - b) < 6)
          return true;
      return false;
    };
    expect(has(0x4f, 0x1d, 0x2b)).toBe(true);
    expect(has(0x2b, 0x2b, 0x2b)).toBe(true);
  }, 90000);

  it('no errors in the console', () => expect(h.errors).toEqual([]));
});
