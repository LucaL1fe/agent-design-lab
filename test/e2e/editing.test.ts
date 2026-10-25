import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { centerOf, fitAndWait, type Harness, harness, openDemo, until } from './fixture.ts';

let h: Harness;
beforeAll(async () => {
  h = await harness();
  await openDemo(h);
}, 60000);
afterAll(async () => h?.close());

const sel = () => h.page.evaluate(() => (window as any).__adl.app.get().selection as string[]);
const arrowSel = () => h.page.evaluate(() => (window as any).__adl.app.get().arrowSel as string[]);

describe('editing (B1–B8)', () => {
  it('B1: click selects, drag moves with arrows following, file gets the new position once', async () => {
    await fitAndWait(h, ['A1', 'A2', 'A3']);
    const [x, y] = await centerOf(h, 'A2');
    await h.page.mouse.click(x, y);
    expect(await sel()).toEqual(['A2']);
    const before = await h.page.evaluate(() => (window as any).__adl.engine.routes.get('A1>A2').points.at(-1));
    await h.page.mouse.move(x, y);
    await h.page.mouse.down();
    await h.page.mouse.move(x + 20, y + 30, { steps: 5 });
    await h.page.mouse.move(x + 40, y + 60, { steps: 5 });
    const during = await h.page.evaluate(() => (window as any).__adl.engine.routes.get('A1>A2').points.at(-1));
    expect(during[1]).not.toBe(before[1]);
    await h.page.mouse.up();
    await until(() => (h.readPage().items.A2 as any).pinned === true);
    const a2 = h.readPage().items.A2 as any;
    expect(a2.parent).toBe('sec-a');
    expect(Math.abs(a2.y - 150)).toBeGreaterThan(20);
  });

  it('B1: Esc during a drag puts everything back', async () => {
    const before = h.readPage().items.A3 as any;
    const [x, y] = await centerOf(h, 'A3');
    await h.page.mouse.move(x, y);
    await h.page.mouse.down();
    await h.page.mouse.move(x + 100, y + 100, { steps: 6 });
    await h.page.keyboard.press('Escape');
    await h.page.mouse.up();
    await h.page.waitForTimeout(300);
    expect(h.readPage().items.A3).toEqual(before);
  });

  it('B1: marquee selects what it touches', async () => {
    await fitAndWait(h, ['sec-a']);
    const [ax, ay] = await centerOf(h, 'A1');
    const [cx, cy] = await centerOf(h, 'A3');
    await h.page.mouse.move(ax - 10, ay - 400 + 260);
    await h.page.keyboard.press('Escape');
    // start on empty canvas above the section
    const start = await h.page.evaluate(() => {
      const e = (window as any).__adl.engine;
      const r = e.rects.get('sec-a');
      const [x, y] = e.vp.toScreen(r.x - 30, r.y - 60);
      const b = e.root.getBoundingClientRect();
      return [x + b.left, y + b.top];
    });
    await h.page.mouse.move(start[0]!, start[1]!);
    await h.page.mouse.down();
    await h.page.mouse.move((ax + cx) / 2, cy, { steps: 8 });
    await h.page.mouse.up();
    const s = await sel();
    expect(s).toContain('A1');
    expect(s).toContain('A2');
    void ay;
  });

  it('B2+B3: connect from an edge handle draws a plain arrow; Enter names it and picks a style', async () => {
    await h.page.keyboard.press('Escape');
    await fitAndWait(h, ['A1', 'A2', 'A3']);
    const [x, y] = await centerOf(h, 'A1');
    await h.page.mouse.move(x, y);
    await h.page.waitForTimeout(100);
    const edge = h.page.locator('.ix-edge[data-side="bottom"]');
    await edge.waitFor();
    const eb = (await edge.boundingBox())!;
    const [tx, ty] = await centerOf(h, 'A3');
    await h.page.mouse.move(eb.x + 7, eb.y + 7);
    await h.page.mouse.down();
    await h.page.mouse.move(tx, ty + 40, { steps: 10 });
    await h.page.locator('.ix-drop').waitFor();
    await h.page.mouse.up();
    // a plain arrow, selected, no editor in the way
    await until(() => !!h.readPage().arrows['A1>A3']);
    expect(h.readPage().arrows['A1>A3']).toEqual({ from: 'A1', to: 'A3', fromSide: 'bottom' });
    expect(await h.page.locator('.ix-label input').count()).toBe(0);
    expect(await h.page.evaluate(() => (window as any).__adl.app.get().arrowSel)).toEqual(['A1>A3']);
    await h.page.keyboard.press('Enter');
    const input = h.page.locator('.ix-label input');
    await input.waitFor();
    await input.fill('skips ahead');
    await h.page.locator('.ix-style', { hasText: 'New step' }).click();
    await input.press('Enter');
    await until(() => Object.values(h.readPage().arrows).some((a: any) => a.label === 'skips ahead'));
    const a = Object.entries(h.readPage().arrows).find(([, a]: any) => a.label === 'skips ahead')!;
    expect(a[0]).toBe('A1>A3');
    expect(a[1]).toMatchObject({ from: 'A1', to: 'A3', style: 'new' });
  });

  it('an arrow dropped on empty canvas asks where it leads and draws a portal there', async () => {
    await h.page.keyboard.press('Escape');
    await fitAndWait(h, ['A3', 'B1']);
    const [x, y] = await centerOf(h, 'A3');
    await h.page.mouse.move(x, y);
    await h.page.waitForTimeout(100);
    const edge = h.page.locator('.ix-edge[data-side="right"]');
    await edge.waitFor();
    const eb = (await edge.boundingBox())!;
    await h.page.mouse.move(eb.x + 7, eb.y + 7);
    await h.page.mouse.down();
    await h.page.mouse.move(eb.x + 260, eb.y + 40, { steps: 10 });
    await h.page.mouse.up();
    const picker = h.page.locator('[data-testid="portal-picker"]');
    await picker.waitFor();
    await picker.locator('input').fill('B2');
    await picker.locator('input').press('Enter');
    await until(() =>
      Object.values(h.readPage().items).some((i: any) => i.kind === 'portal' && i.target === 'B2' && !i.archived),
    );
    const [pid] = Object.entries(h.readPage().items).find(([, i]: any) => i.kind === 'portal' && i.target === 'B2')!;
    expect(Object.values(h.readPage().arrows)).toContainEqual(expect.objectContaining({ from: 'A3', to: pid }));
    // Esc on the picker draws nothing
    await h.page.mouse.move(x, y);
    await edge.waitFor();
    await h.page.mouse.move(eb.x + 7, eb.y + 7);
    await h.page.mouse.down();
    await h.page.mouse.move(eb.x + 260, eb.y + 160, { steps: 10 });
    await h.page.mouse.up();
    await picker.waitFor();
    await picker.locator('input').press('Escape');
    await h.page.waitForTimeout(300);
    expect(Object.values(h.readPage().items).filter((i: any) => i.kind === 'portal')).toHaveLength(1);
    // regression: focusing an editor near the canvas edge scrolled the overlay, so outlines drew off the screens
    const shift = await h.page.evaluate(() => {
      const e = (window as any).__adl.engine;
      return [e.root.scrollLeft, e.root.scrollTop, e.overlay.scrollLeft, e.overlay.scrollTop];
    });
    expect(shift).toEqual([0, 0, 0, 0]);
  });

  it('the side panel of a screen says which portals reach it, and from where', async () => {
    await h.page.keyboard.press('Escape');
    await h.page.evaluate(() => (window as any).__adl.app.set({ selection: ['B2'] }));
    await h.page.keyboard.press('Alt+KeyI');
    const via = h.page.locator('[data-testid="reached-via"]');
    await via.waitFor();
    await expect(via.textContent()).resolves.toMatch(/Via portal:.*from A3/);
    await h.page.keyboard.press('Alt+KeyI'); // closed again: the panel remembers its state
    await h.page.locator('[data-testid="inspector"]').waitFor({ state: 'detached' });
  });

  it('right-click on empty space: "Add a portal here…" places a portal without an arrow', async () => {
    await h.page.keyboard.press('Escape');
    await fitAndWait(h, ['sec-b']);
    // an empty spot inside the Library section, under its screens
    const [x, y] = await h.page.evaluate(() => {
      const e = (window as any).__adl.engine;
      const r = e.rects.get('B1');
      const [sx, sy] = e.vp.toScreen(r.x + r.w / 2, r.y + r.h + 60);
      const bb = e.root.getBoundingClientRect();
      return [sx + bb.left, sy + bb.top];
    });
    await h.page.mouse.click(x, y, { button: 'right' });
    await h.page.locator('.ix-ctx .mi', { hasText: 'Add a portal here' }).click();
    const picker = h.page.locator('[data-testid="portal-picker"]');
    await picker.waitFor();
    await picker.locator('input').fill('A1');
    await picker.locator('input').press('Enter');
    await until(() => Object.values(h.readPage().items).some((i: any) => i.kind === 'portal' && i.target === 'A1'));
    const [pid, portal] = Object.entries(h.readPage().items).find(([, i]: any) => i.target === 'A1')! as [string, any];
    expect(portal.parent).toBe('sec-b');
    expect(Object.values(h.readPage().arrows).some((a: any) => a.to === pid)).toBe(false);
    // back to the view the tests after this one expect
    await h.page.keyboard.press('Escape');
    await fitAndWait(h, ['A3', 'B1']);
  });

  it('B3: double-click a label to edit it', async () => {
    const label = h.page.locator('.alab[data-id="A2>A3"]');
    await label.dblclick();
    const input = h.page.locator('.ix-label input');
    await input.fill('2 s later');
    await input.press('Enter');
    await until(() => (h.readPage().arrows['A2>A3'] as any).label === '2 s later');
  });

  it('B4: note tool adds a note anchored to the screen next to it, with colour swatches', async () => {
    await h.page.keyboard.press('n');
    const [x, y] = await centerOf(h, 'A2');
    const r = await h.page.evaluate(() => {
      const e = (window as any).__adl.engine;
      const r = e.rects.get('A2');
      const [sx, sy] = e.vp.toScreen(r.x + 40, r.y + r.h + 60);
      const b = e.root.getBoundingClientRect();
      return [sx + b.left, sy + b.top];
    });
    await h.page.mouse.click(r[0]!, r[1]!);
    await h.page.keyboard.type('Should this screen show a photo?');
    await h.page.locator('.ix-swatch button.note-blue').click();
    await h.page.keyboard.press('Meta+Enter');
    await until(() =>
      Object.values(h.readPage().items).some(
        (i: any) => i.kind === 'note' && i.text === 'Should this screen show a photo?',
      ),
    );
    const note = Object.values(h.readPage().items).find(
      (i: any) => i.text === 'Should this screen show a photo?',
    ) as any;
    expect(note).toMatchObject({ anchor: 'A2', color: 'blue', by: 'human' });
    void x;
    void y;
  });

  it('B8: undo and redo', async () => {
    await h.page.keyboard.press('Meta+z');

    await until(
      () =>
        !Object.values(h.readPage().items).some(
          (i: any) => i.text === 'Should this screen show a photo?' && i.color === 'blue',
        ),
    );
    await h.page.keyboard.press('Meta+Shift+z');
    await until(() =>
      Object.values(h.readPage().items).some(
        (i: any) => i.text === 'Should this screen show a photo?' && i.color === 'blue',
      ),
    );
  });

  it('B5: duplicate keeps pointing at the same HTML', async () => {
    const [x, y] = await centerOf(h, 'B1');
    await fitAndWait(h, ['B1', 'B2']);
    const c = await centerOf(h, 'B1');
    await h.page.mouse.click(c[0], c[1]);
    await h.page.keyboard.press('Meta+d');
    await until(() => !!h.readPage().items['B1~2']);
    expect(h.readPage().items['B1~2']).toMatchObject({ kind: 'screen', screen: 'B1' });
    void x;
    void y;
  });

  it('B6: delete removes a screen from the page with its arrows; the HTML stays', async () => {
    await h.page.keyboard.press('Delete');
    await until(() => !h.readPage().items['B1~2']);
    const fs = await import('node:fs');
    expect(fs.existsSync(`${h.pdir}/screens/B1.html`)).toBe(true);
  });

  it('B1: nudge with the arrow keys', async () => {
    const c = await centerOf(h, 'B2');
    await h.page.mouse.click(c[0], c[1]);
    const before = (h.readPage().items.B2 as any).x;
    await h.page.keyboard.press('ArrowRight');
    await h.page.keyboard.press('Shift+ArrowRight');
    await until(() => (h.readPage().items.B2 as any).x === before + 11);
  });

  it('arrows can be selected and deleted', async () => {
    await h.page.keyboard.press('Escape');
    await h.page.locator('.alab[data-id="B1>B2"]').click();
    expect(await arrowSel()).toEqual(['B1>B2']);
    await h.page.keyboard.press('Backspace');
    await until(() => !h.readPage().arrows['B1>B2']);
  });

  it('B4: sections: draw one around screens, they become its children', async () => {
    await h.page.keyboard.press('s');
    await fitAndWait(h, ['n1']);
    const r = await h.page.evaluate(() => {
      const e = (window as any).__adl.engine;
      const r = e.rects.get('n1');
      const b = e.root.getBoundingClientRect();
      const [x1, y1] = e.vp.toScreen(r.x - 40, r.y - 40);
      const [x2, y2] = e.vp.toScreen(r.x + r.w + 40, r.y + r.h + 40);
      return [x1 + b.left, y1 + b.top, x2 + b.left, y2 + b.top];
    });
    await h.page.mouse.move(r[0]!, r[1]!);
    await h.page.mouse.down();
    await h.page.mouse.move(r[2]!, r[3]!, { steps: 6 });
    await h.page.mouse.up();
    const input = h.page.locator('.ix-sectitle input');
    await input.waitFor();
    await input.fill('NOTES');
    await input.press('Enter');
    await until(() => Object.values(h.readPage().items).some((i: any) => i.kind === 'section' && i.title === 'NOTES'));
    const secId = Object.entries(h.readPage().items).find(([, i]: any) => i.title === 'NOTES')![0];
    expect((h.readPage().items.n1 as any).parent).toBe(secId);
  });

  it('no errors in the console', () => {
    expect(h.errors).toEqual([]);
  });
});
