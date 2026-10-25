// E2 (⌘K finds text inside screens) and E3 (present mode walks the arrows).

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pageKey } from '../../src/core/ops.ts';
import { commands, parseArgs } from '../../src/node/commands/registry.ts';
import '../../src/node/commands/index.ts';
import { type Harness, harness, openDemo } from './fixture.ts';

let h: Harness;
beforeAll(async () => {
  h = await harness();
  await openDemo(h);
}, 60000);
afterAll(async () => h?.close());

const state = () =>
  h.page.evaluate(() => {
    const a = (window as any).__adl;
    return {
      selection: a.app.get().selection as string[],
      presenting: a.app.get().presenting as { trail: string[] } | undefined,
      hit: a.engine.hit as string | undefined,
      dim: [...a.engine.dim].sort() as string[],
      searchOpen: a.app.get().searchOpen as boolean,
    };
  });
const rows = () => h.page.locator('[data-testid="search"] .pr').allInnerTexts();

describe('⌘K search', () => {
  it('finds a screen by banner text, dims the rest and jumps there with Enter', async () => {
    await h.page.keyboard.press('Meta+k');
    const input = h.page.locator('[data-testid="search"] input');
    await input.fill('wrong font');
    await expect.poll(rows).toEqual([expect.stringMatching(/^B2/)]);
    await expect.poll(async () => (await state()).dim).toEqual(['A1', 'A2', 'A3', 'B1', 'B3']);
    await input.press('Enter');
    await expect.poll(async () => (await state()).selection).toEqual(['B2']);
    const s = await state();
    expect(s.searchOpen).toBe(false);
    // only moved there and selected: nothing stays dimmed or ringed after the palette closes
    expect(s.dim).toEqual([]);
    expect(s.hit).toBeUndefined();
    await h.page.keyboard.press('Escape');
  });

  it('finds words inside screens, notes and arrow labels; Shift+Enter goes to the next result', async () => {
    await h.page.keyboard.press('Meta+k');
    const input = h.page.locator('[data-testid="search"] input');
    await input.fill('next');
    // "Next" is a button inside every screen, and the label of the arrow A1 → A2
    await expect.poll(async () => (await rows()).length).toBe(7);
    expect((await rows()).at(-1)).toMatch(/^arrow\s*A1 → A2/);
    await input.fill('empty state');
    await expect.poll(rows).toEqual([expect.stringMatching(/^note/)]);
    await input.fill('Screen');
    await expect.poll(async () => (await rows()).length).toBe(6);
    await input.press('Enter');
    await expect.poll(async () => (await state()).selection).toEqual(['A1']);
    await h.page.keyboard.press('Shift+Enter');
    await expect.poll(async () => (await state()).selection).toEqual(['A2']);
    expect((await state()).dim).toEqual([]);
    await h.page.keyboard.press('Escape');
  });
});

describe('present mode', () => {
  it('starts at the selected screen; the arrows are the buttons; → follows, ← goes back', async () => {
    await h.page.evaluate(() => (window as any).__adl.app.set({ selection: ['A1'] }));
    await h.page.keyboard.press('p');
    await expect.poll(async () => (await state()).presenting?.trail).toEqual(['A1']);
    await expect
      .poll(() => h.page.locator('.nexts .nx').allInnerTexts())
      .toEqual([expect.stringMatching(/taps Next\s*A2/)]);
    await h.page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await state()).presenting?.trail).toEqual(['A1', 'A2']);
    await h.page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await state()).presenting?.trail).toEqual(['A1']);
  });

  it('a tap on the anchored element follows its arrow (hotspot)', async () => {
    h.server.service.apply(
      'demo',
      [{ doc: pageKey('truth'), path: ['arrows', 'A1>A2', 'trigger'], value: { on: 'tap', el: 'next' } }],
      { actor: 'agent' },
    );
    await h.page.waitForTimeout(300);
    const btn = h.page.locator('.pres-host').locator('[data-adl-anchor="next"]');
    await btn.click();
    await expect.poll(async () => (await state()).presenting?.trail).toEqual(['A1', 'A2']);
  });

  it('a single "auto" arrow advances by itself', async () => {
    h.server.service.apply(
      'demo',
      [{ doc: pageKey('truth'), path: ['arrows', 'A2>A3', 'trigger'], value: { on: 'auto', after: 400 } }],
      { actor: 'agent' },
    );
    await h.page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await state()).presenting?.trail).toEqual(['A1']);
    await h.page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await state()).presenting?.trail, { timeout: 3000 }).toEqual(['A1', 'A2', 'A3']);
  });

  it('proposal links are not paths; the end of a flow says so; Esc ends on the last screen', async () => {
    await h.page.keyboard.press('Escape');
    await expect.poll(async () => (await state()).presenting).toBeUndefined();
    expect((await state()).selection).toEqual(['A3']);
    await h.page.evaluate(() => (window as any).__adl.app.set({ selection: ['B2'] }));
    await h.page.keyboard.press('p');
    await expect.poll(() => h.page.locator('.nexts').innerText()).toContain('The flow ends here');
    await h.page.keyboard.press('Escape');
  });

  it('⌥I toggles the side panel (the tooltip promised it before it worked)', async () => {
    const panel = () => h.page.evaluate(() => (window as any).__adl.app.get().panel as boolean);
    const before = await panel();
    await h.page.keyboard.press('Alt+KeyI');
    await expect.poll(panel).toBe(!before);
    await h.page.keyboard.press('Alt+KeyI');
    await expect.poll(panel).toBe(before);
  });

  it('no errors in the console', () => expect(h.errors).toEqual([]));
});

describe('portals to another page', () => {
  it('following a portal to another page opens that page at the screen', async () => {
    // regression: the click sent an event nothing listened to, so a portal to another page did nothing
    const run = (cmd: string, argv: string[]) =>
      commands.get(cmd)!.run(parseArgs(argv), { cwd: h.pdir, server: h.server });
    expect((await run('page', ['new', 'Ideas'])).ok).toBe(true);
    fs.writeFileSync(path.join(h.pdir, 'screens', 'I1.html'), '<!doctype html><title>Idea</title><body>idea</body>');
    expect((await run('add', ['I1', '--page', 'ideas'])).ok).toBe(true);
    expect((await run('portal', ['--to', 'I1', '--after', 'A1', '--label', 'see the idea'])).ok).toBe(true);
    await expect
      .poll(() => Object.values(h.readPage().items).some((i: any) => i.target === 'page:ideas/I1'))
      .toBe(true);
    await h.page.evaluate(() => (window as any).__adl.ix.followPortal('page:ideas/I1'));
    await expect.poll(() => h.page.evaluate(() => location.pathname + location.hash)).toBe('/p/demo/ideas#I1');
  });
});
