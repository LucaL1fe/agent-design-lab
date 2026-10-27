// The build check in the app: the chip on each screen, the Design · tablet · phone switch showing the real product's
// captures in place, the Compare checklist (states and reasons edited there), flows highlighted on the canvas.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { centerOf, fitAndWait, type Harness, harness, openDemo, until } from './fixture.ts';

// a 1×1 PNG (stands in for a screenshot of the real product)
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

let h: Harness;
beforeAll(async () => {
  h = await harness();
  const file = path.join(h.pdir, 'pages', 'truth.json');
  const page = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [id, dev] of [
    ['A1', 'phone'],
    ['A1', 'tablet'],
    ['A2', 'phone'],
  ] as const) {
    fs.mkdirSync(path.join(h.pdir, 'captures', id), { recursive: true });
    fs.writeFileSync(path.join(h.pdir, 'captures', id, `${dev}-image.png`), PNG);
  }
  page.items.A1.build = {
    state: 'matching',
    captures: [
      { device: 'phone', kind: 'image', src: 'captures/A1/phone-image.png' },
      { device: 'tablet', kind: 'image', src: 'captures/A1/tablet-image.png' },
    ],
  };
  page.items.A2.build = {
    state: 'deviating',
    note: 'the button is grey',
    captures: [{ device: 'phone', kind: 'image', src: 'captures/A2/phone-image.png' }],
  };
  page.items.A3.build = { state: 'todo' };
  page.flows = { signup: { title: 'Sign up', steps: ['A1', 'A2', 'A3'], build: { state: 'wip' } } };
  fs.writeFileSync(file, JSON.stringify(page));
  await openDemo(h);
  await fitAndWait(h, ['A1', 'A2', 'A3']);
}, 60000);
afterAll(async () => h?.close());

describe('build check on the canvas', () => {
  it('shows a build chip next to each tracked screen and the progress in the section title', async () => {
    await h.page.waitForSelector('.it.scr[data-id="A1"] .bld');
    expect(await h.page.locator('.it.scr[data-id="A1"] .bld').textContent()).toBe('Matching');
    expect(await h.page.locator('.it.scr[data-id="A2"] .bld').textContent()).toBe('Deviating');
    expect(await h.page.locator('.it.scr[data-id="A2"] .bld').getAttribute('title')).toBe('the button is grey');
    expect(await h.page.locator('.it.scr[data-id="B1"] .bld').count()).toBe(0);
    await until(async () =>
      ((await h.page.locator('.sec-title[data-id="sec-a"] .cnt').textContent()) ?? '').includes('1/3 matching'),
    );
  });

  it('the switch shows the real product in place of the design, D cycles the views', async () => {
    const sw = h.page.locator('[data-testid="view-switch"]');
    await sw.waitFor();
    expect(await sw.locator('button').allTextContents()).toEqual(['design', 'tablet', 'phone']);
    await sw.getByText('phone').click();
    await h.page.waitForSelector('.it.scr[data-id="A1"] img.capt');
    expect(await h.page.locator('.it.scr[data-id="A1"] img.capt').getAttribute('src')).toContain(
      '/f/captures/A1/phone-image.png',
    );
    // a screen without a phone capture says so
    expect(await h.page.locator('.it.scr[data-id="A3"]').getAttribute('class')).toContain('nocap');
    await h.page.locator('.adl-viewport').click({ position: { x: 5, y: 400 } });
    await h.page.keyboard.press('d');
    await until(async () => (await h.page.locator('.it.scr[data-id="A1"] img.capt').count()) === 0);
    expect(await sw.locator('button.on').textContent()).toBe('design');
    await h.page.keyboard.press('d');
    await h.page.waitForSelector('.it.scr[data-id="A1"] img.capt[src*="tablet-image"]');
    await sw.getByText('design').click();
  });
});

describe('compare', () => {
  it('C opens the checklist: what is not matching yet, with design and captures side by side', async () => {
    await h.page.keyboard.press('c');
    const cmp = h.page.locator('[data-testid="compare"]');
    await cmp.waitFor();
    // default filter: not matching yet
    expect(await cmp.locator('.cmp-row').count()).toBe(2);
    expect(await cmp.locator('.cmp-row[data-id="A2"] .c-id').textContent()).toContain('A2');
    await cmp.getByText('All', { exact: false }).first().click();
    expect(await cmp.locator('.cmp-row').count()).toBe(3);
    expect(await cmp.locator('.cmp-row[data-id="A1"] .c-dev img').count()).toBe(2);
  });

  it('blocked needs a reason; with one it is saved for the screen, by the person', async () => {
    const row = h.page.locator('.cmp-row[data-id="A3"]');
    await row.locator('.bed-states button', { hasText: 'Blocked' }).click();
    await h.page.waitForTimeout(150);
    expect((h.readPage().items.A3 as any).build.state).toBe('todo');
    await row.locator('textarea').fill('waits for the server');
    await row.locator('.bed-states button', { hasText: 'Blocked' }).click();
    await until(() => (h.readPage().items.A3 as any).build?.state === 'blocked');
    expect((h.readPage().items.A3 as any).build).toMatchObject({ note: 'waits for the server', by: 'human' });
  });

  it('a capture opens big next to the design', async () => {
    await h.page.locator('.cmp-row[data-id="A1"] .c-dev .capbtn').first().click();
    await h.page.locator('.cmp-zoom').waitFor();
    expect(await h.page.locator('.cmp-zoom figure').count()).toBeGreaterThanOrEqual(1);
    await h.page.keyboard.press('Escape');
    await until(async () => (await h.page.locator('.cmp-zoom').count()) === 0);
  });

  it('the flows tab lists flows; the crosshair highlights one on the canvas, Esc clears it', async () => {
    await h.page.locator('[data-testid="compare-flows-tab"]').click();
    const row = h.page.locator('.cmp-row.flow[data-id="signup"]');
    await row.waitFor();
    expect(await row.locator('.steps button').allTextContents()).toEqual(['A1', 'A2', 'A3']);
    await row.locator('.go').click();
    await until(async () => (await h.page.locator('[data-testid="compare"]').count()) === 0);
    await until(() => h.page.evaluate(() => (window as any).__adl.app.get().flowFocus === 'signup'));
    expect(await h.page.evaluate(() => (window as any).__adl.engine.dim.has('B1'))).toBe(true);
    await h.page.keyboard.press('Escape');
    await until(() => h.page.evaluate(() => !(window as any).__adl.engine.dim.has('B1')));
  });
});

describe('side panel', () => {
  it('a screen shows its build state, reason and captures; a click changes the state', async () => {
    await fitAndWait(h, ['A1', 'A2', 'A3']);
    const [x, y] = await centerOf(h, 'A2');
    await h.page.mouse.click(x, y);
    await h.page.keyboard.press('Alt+KeyI');
    const panel = h.page.locator('[data-testid="inspector"]');
    await panel.waitFor();
    expect(await h.page.locator('[data-testid="build-note"]').inputValue()).toBe('the button is grey');
    expect(await panel.locator('.caps a').count()).toBe(1);
    await panel.locator('[data-testid="build-states"] button', { hasText: 'Matching' }).click();
    await until(() => (h.readPage().items.A2 as any).build?.state === 'matching');
    expect(h.errors).toEqual([]);
  });
});
