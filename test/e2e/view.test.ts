// The view never loses the page: a fling stops with something on screen, a saved view that shows nothing opens at
// the whole page, and a saved view that shows something opens exactly where it was.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, harness, openDemo } from './fixture.ts';

let h: Harness;
beforeAll(async () => {
  h = await harness();
  await openDemo(h);
}, 60000);
afterAll(async () => h?.close());

/** How many items the view shows (below the toolbar), and the view itself. */
const onScreen = () =>
  h.page.evaluate(() => {
    const e = (window as any).__adl.engine;
    const { x, y, k } = e.vp.v;
    const W = e.root.clientWidth;
    const H = e.root.clientHeight;
    let n = 0;
    for (const r of e.rects.values()) {
      const x1 = r.x * k + x;
      const y1 = r.y * k + y;
      if (x1 < W && x1 + r.w * k > 0 && y1 < H && y1 + r.h * k > e.vp.insetTop) n++;
    }
    return { n, v: { x, y, k } as { x: number; y: number; k: number } };
  });

const reopen = async (view: { x: number; y: number; k: number }) => {
  await h.page.evaluate((v) => localStorage.setItem('adl:view:demo:truth', JSON.stringify(v)), view);
  await h.page.reload();
  await h.page.waitForFunction(() => (window as any).__adl?.engine?.root.dataset.viewReady);
};

describe('the view never loses the page', () => {
  it('a fling with the trackpad stops with an item still on screen', async () => {
    await h.page.evaluate(() => (window as any).__adl.engine.vp.set({ x: 100, y: 100, k: 0.05 }));
    await h.page.mouse.move(700, 450);
    for (let i = 0; i < 25; i++) await h.page.mouse.wheel(4000, 2500);
    await h.page.waitForTimeout(300);
    expect((await onScreen()).n).toBeGreaterThan(0);
  });

  it('a saved view that shows nothing opens at the whole page', async () => {
    // regression from a real canvas: a view saved far off the page was restored on every visit, the canvas empty
    await reopen({ x: -4775, y: -205, k: 0.02 });
    await expect.poll(async () => (await onScreen()).n, { timeout: 4000 }).toBeGreaterThan(0);
  });

  it('a saved view that shows something opens exactly where it was', async () => {
    const first = await h.page.evaluate(() => [...(window as any).__adl.engine.rects.keys()][0] as string);
    await h.page.evaluate((id) => (window as any).__adl.engine.fit([id], false), first);
    const before = (await onScreen()).v;
    await reopen(before);
    await h.page.waitForTimeout(1500);
    const after = await onScreen();
    expect(after.n).toBeGreaterThan(0);
    expect(after.v).toEqual(before);
  });
});
