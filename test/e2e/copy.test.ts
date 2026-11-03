// Screen names and pictures: the action row above a hovered (or the selected) screen's name, ⌘C for the names, ⇧⌘C
// for the names with a picture, and the row's picture menu (PNG, JPG, clipboard). The row never changes the layout.
import fs from 'node:fs';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { centerOf, fitAndWait, type Harness, harness, openDemo } from './fixture.ts';

let h: Harness;
beforeAll(async () => {
  h = await harness({ snapshots: true });
  await h.page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: h.server.url });
  await openDemo(h);
  await fitAndWait(h, ['A1', 'A2', 'A3']);
}, 120000);
afterAll(async () => h?.close());

const bar = () => h.page.locator('.ix-bar:not([hidden])');
const clipText = () => h.page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
const clipTypes = () =>
  h.page.evaluate(async () => {
    try {
      return (await navigator.clipboard.read()).flatMap((i) => [...i.types]).sort();
    } catch {
      return [];
    }
  });
const state = () =>
  h.page.evaluate(() => {
    const a = (window as any).__adl;
    return { selection: a.app.get().selection as string[], A2: a.engine.rects.get('A2') };
  });
/** Size of the clipboard's picture, and whether it shows each of these colours. */
const clipImage = (colors: [number, number, number][]) =>
  h.page.evaluate(async (colors) => {
    const item = (await navigator.clipboard.read()).find((i) => i.types.includes('image/png'))!;
    const bmp = await createImageBitmap(await item.getType('image/png'));
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const has = colors.map(([r, g, b]) => {
      for (let i = 0; i < d.length; i += 4 * 5)
        if (Math.abs(d[i]! - r) < 6 && Math.abs(d[i + 1]! - g) < 6 && Math.abs(d[i + 2]! - b) < 6) return true;
      return false;
    });
    return { w: bmp.width, h: bmp.height, has };
  }, colors);

async function hover(id: string) {
  const [x, y] = await centerOf(h, id);
  await h.page.mouse.move(x, y);
  await expect.poll(() => bar().count()).toBe(1);
}
async function clickBar(act: string) {
  const b = await bar().locator(`[data-bar="${act}"]`).boundingBox();
  // straight up from the screen through its caption to the row, as a person moves
  await h.page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2, { steps: 4 });
  await h.page.mouse.down();
  await h.page.mouse.up();
}

describe('the action row', () => {
  it('shows above a hovered screen, right on top of its caption, and moves nothing', async () => {
    const before = await state();
    await hover('A2');
    const row = (await bar().boundingBox())!;
    const head = (await h.page.locator('.it.scr[data-id="A2"] .head').boundingBox())!;
    const frame = (await h.page.locator('.it.scr[data-id="A2"] .frame').boundingBox())!;
    expect(Math.abs(row.y + row.height - head.y)).toBeLessThan(1.5);
    expect(Math.abs(row.x - frame.x)).toBeLessThan(1.5);
    expect(await bar().locator('[data-bar]').count()).toBe(3);
    expect((await state()).A2).toEqual(before.A2);
    // never wider than the screen: fewer labels when it is small on screen
    expect(row.width).toBeLessThanOrEqual(frame.width + 1);
  });

  it('Copy name puts the screen id on the clipboard, without selecting it', async () => {
    await hover('A2');
    await clickBar('copy');
    await expect.poll(clipText).toBe('A2');
    expect((await state()).selection).toEqual([]);
  });

  it('a press and drag on the row neither selects nor moves the screen', async () => {
    const before = await state();
    await hover('A2');
    const b = (await bar().locator('[data-bar="copy"]').boundingBox())!;
    await h.page.mouse.move(b.x + 10, b.y + 10, { steps: 4 });
    await h.page.mouse.down();
    await h.page.mouse.move(b.x + 120, b.y + 90, { steps: 6 });
    await h.page.mouse.up();
    expect(await state()).toEqual(before);
  });

  it('stays on the selected screen when the pointer leaves it', async () => {
    await h.page.evaluate(() => (window as any).__adl.app.set({ selection: ['A2'] }));
    await h.page.mouse.move(5, 300);
    await expect.poll(() => bar().count()).toBe(1);
    const row = (await bar().boundingBox())!;
    const frame = (await h.page.locator('.it.scr[data-id="A2"] .frame').boundingBox())!;
    expect(Math.abs(row.x - frame.x)).toBeLessThan(1.5);
    await h.page.evaluate(() => (window as any).__adl.app.set({ selection: [] }));
    await expect.poll(() => bar().count()).toBe(0);
  });
});

describe('copying names', () => {
  it('⌘C copies the selected screens in reading order', async () => {
    await h.page.evaluate(() => (window as any).__adl.app.set({ selection: ['A3', 'n1', 'A1'] }));
    await h.page.keyboard.press('ControlOrMeta+c');
    await expect.poll(clipText).toBe('A1, A3');
    await expect.poll(() => h.page.locator('.toast').last().innerText()).toContain('Copied A1, A3');
  });

  it('the row of a screen in a multi-selection copies all of them', async () => {
    await h.page.evaluate(() => navigator.clipboard.writeText(''));
    await hover('A3');
    await expect(bar().locator('[data-bar="copy"]').getAttribute('aria-label')).resolves.toBe('Copy 2 names');
    await clickBar('copy');
    await expect.poll(clipText).toBe('A1, A3');
    expect((await state()).selection).toEqual(['A3', 'n1', 'A1']);
  });

  it('⇧⌘C copies the names and one picture showing both screens', async () => {
    await h.page.evaluate(() => navigator.clipboard.writeText(''));
    await h.page.keyboard.press('ControlOrMeta+Shift+c');
    await expect.poll(clipTypes, { timeout: 60000 }).toEqual(['image/png', 'text/plain']);
    expect(await clipText()).toBe('A1, A3');
    // A1 is #1d2b4f and A3 #1d4f3a in the fixture: two 300 px cards side by side with their captions, at 2x
    const img = await clipImage([
      [0x1d, 0x2b, 0x4f],
      [0x1d, 0x4f, 0x3a],
    ]);
    expect(img.has).toEqual([true, true]);
    expect(img.w).toBeGreaterThan(1200);
    await h.page.evaluate(() => (window as any).__adl.app.set({ selection: [] }));
  }, 90000);
});

describe('the picture menu', () => {
  it('downloads the screen as a PNG at 2x and as a JPG', async () => {
    for (const [type, name] of [
      ['Download PNG', 'A2.png'],
      ['Download JPG', 'A2.jpg'],
    ] as const) {
      await hover('A2');
      await clickBar('pic');
      const download = h.page.waitForEvent('download', { timeout: 60000 });
      await h.page.locator('.ix-picmenu .mi', { hasText: type }).click();
      const d = await download;
      expect(d.suggestedFilename()).toBe(name);
      const bytes = fs.readFileSync(await d.path());
      if (name.endsWith('.png')) {
        const png = PNG.sync.read(bytes);
        expect([png.width, png.height]).toEqual([780, 1688]);
      } else expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    }
  }, 120000);

  it('Copy picture puts only the picture on the clipboard', async () => {
    await h.page.evaluate(() => navigator.clipboard.writeText(''));
    await hover('A2');
    await clickBar('pic');
    await h.page.locator('.ix-picmenu .mi', { hasText: 'Copy picture' }).click();
    await expect.poll(clipTypes, { timeout: 60000 }).toEqual(['image/png']);
    const img = await clipImage([[0x3b, 0x1d, 0x4f]]);
    expect([img.w, img.h, ...img.has]).toEqual([780, 1688, true]);
  }, 90000);

  it('no errors in the console', () => expect(h.errors).toEqual([]));
});
