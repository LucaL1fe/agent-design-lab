import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { centerOf, fitAndWait, type Harness, harness, openDemo, until } from './fixture.ts';

let h: Harness;
beforeAll(async () => {
  h = await harness();
  await openDemo(h);
}, 60000);
afterAll(async () => h?.close());

const project = () => JSON.parse(fs.readFileSync(path.join(h.pdir, 'project.json'), 'utf8'));
const click = async (id: string) => {
  const [x, y] = await centerOf(h, id);
  await h.page.mouse.click(x, y);
};

describe('review loop (C1–C3, D3, E1)', () => {
  it('C1: the side panel (opened with ⌥I, it never pops up by itself) shows file, statuses, banner and arrows', async () => {
    await fitAndWait(h, ['A1', 'A2', 'A3']);
    await click('A3');
    await h.page.waitForTimeout(200);
    const panel = h.page.locator('[data-testid="inspector"]');
    expect(await panel.count()).toBe(0);
    await h.page.keyboard.press('Alt+KeyI');
    await panel.waitFor();
    await expect(panel.textContent()).resolves.toContain('screens/A3.html');
    await expect(panel.textContent()).resolves.toContain('To decide');
    expect(await h.page.locator('[data-testid="banner-text"]').inputValue()).toBe('which colour?');
    await expect(panel.textContent()).resolves.toContain('3 s later');
  });

  it('C1: banner text is saved to the page file and shown above the screen', async () => {
    const ta = h.page.locator('[data-testid="banner-text"]');
    await ta.fill('bigger breathing circle, centred on the words?');
    await ta.press('Enter');
    await until(() => (h.readPage().items.A3 as any).banner === 'bigger breathing circle, centred on the words?');
    await h.page.waitForFunction(() =>
      document.querySelector('.it.scr[data-id="A3"] .ban')?.textContent?.includes('centred on'),
    );
  });

  it('C1: picking a status changes it', async () => {
    await h.page.locator('.st[data-status="needs-fix"]').click();
    await until(() => (h.readPage().items.A3 as any).status === 'needs-fix');
  });

  it('C2: a new status with name, colour and banner is added to project.json and applied', async () => {
    await h.page.locator('[data-testid="new-status"]').click();
    const ed = h.page.locator('[data-testid="status-editor"]');
    await ed.waitFor();
    await ed.locator('input.field').fill('Test on a small phone');
    await ed.locator('.sw button').nth(3).click();
    await expect(ed.locator('.ban-preview').textContent()).resolves.toContain('Test on a small phone');
    await ed.getByText('Add status').click();
    await until(() =>
      project().statuses.some(
        (s: any) => s.id === 'test-on-a-small-phone' && s.createdBy === 'human' && s.role === 'review',
      ),
    );
    await until(() => (h.readPage().items.A3 as any).status === 'test-on-a-small-phone');
    await expect(h.page.locator('[data-testid="inspector"]').textContent()).resolves.toContain('made by you');
  });

  it('C3: approve removes the banner and disables the banner text', async () => {
    await h.page.locator('[data-testid="approve"]').click();
    await until(() => (h.readPage().items.A3 as any).status === 'approved');
    expect((h.readPage().items.A3 as any).banner).toBeUndefined();
    await h.page.waitForFunction(() => !document.querySelector('.it.scr[data-id="A3"] .ban'));
    expect(await h.page.locator('[data-testid="approve"]').textContent()).toContain('✓ Approved');
    expect(await h.page.locator('[data-testid="banner-text"]').isDisabled()).toBe(true);
    await h.page.locator('.toast', { hasText: 'A3 approved' }).waitFor();
  });

  it('D3: "Use instead of B2" swaps the proposal in; B2 goes to History with Restore', async () => {
    await fitAndWait(h, ['B1', 'B2', 'B3']);
    await click('B3');
    await h.page.locator('[data-testid="use-instead"]').waitFor();
    await h.page.locator('[data-testid="use-instead"]').click();
    await until(() => !h.readPage().items.B2 && !!h.readPage().items.B3 && !(h.readPage().items.B3 as any).proposalFor);
    const p = h.readPage();
    expect(p.items.B3).toMatchObject({ x: 734, y: 150, parent: 'sec-b' });
    expect(p.arrows['B1>B3']).toMatchObject({ label: 'opens' });
    expect(project().pages).toContain('history');
    const hist = JSON.parse(fs.readFileSync(path.join(h.pdir, 'pages', 'history.json'), 'utf8'));
    expect(hist.items.B2.archived).toMatchObject({ reason: 'replaced', replacedBy: 'B3', from: 'truth' });
    expect(fs.existsSync(path.join(h.pdir, 'screens', 'B2.html'))).toBe(true);
  });

  it('E1: the page menu lists pages with counts and History; restore from History brings B2 back', async () => {
    await h.page.locator('[data-testid="page-button"]').click();
    const menu = h.page.locator('[data-testid="page-menu"]');
    await menu.waitFor();
    await expect(menu.textContent()).resolves.toContain('History');
    await menu.getByText('History').click();
    await h.page.waitForURL(/\/history/);
    await h.page.waitForFunction(
      () => (window as any).__adl.engine.pageId === 'history' && (window as any).__adl.engine.rects.has('B2'),
    );
    await fitAndWait(h, ['B2']);
    await click('B2');
    await h.page.locator('[data-testid="restore"]').click();
    await until(() => !!h.readPage().items.B2);
    expect(h.readPage().items.B2).toMatchObject({ x: 734, y: 150, parent: 'sec-b', status: 'needs-fix' });
    await h.page.waitForURL(/\/truth/);
  });

  it('E1: new page, rename, delete with undo', async () => {
    await h.page.locator('[data-testid="page-button"]').click();
    await h.page.locator('[data-testid="new-page"]').click();
    await until(() => project().pages.includes('new-page'));
    const input = h.page.locator('[data-testid="page-menu"] input.rename');
    await input.waitFor();
    await input.fill('Ideas · reminders');
    await input.press('Enter');
    await until(
      () =>
        JSON.parse(fs.readFileSync(path.join(h.pdir, 'pages', 'new-page.json'), 'utf8')).name === 'Ideas · reminders',
    );
    await h.page.locator('[data-testid="page-menu"] .more').last().click();
    await h.page.locator('.menu.sub').getByText('Delete page').click();
    await until(() => !project().pages.includes('new-page'));
    await until(() => !fs.existsSync(path.join(h.pdir, 'pages', 'new-page.json')));
    await h.page.locator('.toast .act', { hasText: 'Undo' }).click();
    await until(
      () => project().pages.includes('new-page') && fs.existsSync(path.join(h.pdir, 'pages', 'new-page.json')),
    );
  });

  it('screens without a page can be placed from the page menu', async () => {
    fs.writeFileSync(
      path.join(h.pdir, 'screens', 'C9.html'),
      '<!doctype html><title>Loose screen</title><body>loose</body>',
    );
    await h.page.waitForFunction(() => !!(window as any).__adl.project.screens.C9);
    await h.page.locator('[data-testid="page-button"]').click();
    await h.page.getByText('Screens not on any page').click();
    await h.page.locator('.unplaced .mi', { hasText: 'C9' }).click();
    await until(() => !!h.readPage().items.C9);
  });

  it('no errors in the console', () => expect(h.errors).toEqual([]));
});
