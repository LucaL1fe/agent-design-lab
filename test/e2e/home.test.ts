// A1: the project home lists projects with counts, a new project can be made from the app, and the built-in example
// is there to look at (and copy).
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, harness } from './fixture.ts';

let h: Harness;
beforeAll(async () => {
  h = await harness();
  await h.page.goto(`${h.server.url}/`);
}, 60000);
afterAll(async () => h?.close());

describe('home', () => {
  it('shows the project with its page and screen count', async () => {
    const card = h.page.locator('[data-testid="project-demo"]');
    await card.waitFor();
    await expect.poll(() => card.innerText()).toContain('1 page · 6 screens');
  });

  it('creates a project from the app and opens it (the server knows `init`)', async () => {
    await h.page.locator('.card.new').click();
    await h.page.getByLabel('Project name').fill('Bakery site');
    await h.page.getByLabel('Project name').press('Enter');
    await h.page.waitForURL(/\/p\/bakery-site/);
    expect(fs.existsSync(path.join(h.root, 'bakery-site', 'project.json'))).toBe(true);
    await h.page.locator('[data-testid="empty-page"]').waitFor();
  });

  it('shows the built-in example as the last card, marked "Example"', async () => {
    await h.page.goto(`${h.server.url}/`);
    const last = h.page.locator('.cards > .card').last();
    await expect.poll(() => last.getAttribute('data-testid')).toBe('project-example-still');
    await expect(last.textContent()).resolves.toContain('Example');
  });

  it('opens the example to look at: a change is refused, "Make a copy" opens an editable copy', async () => {
    await h.page.locator('[data-testid="project-example-still"]').click();
    await h.page.waitForURL(/\/p\/example-still/);
    await h.page.waitForFunction(() => (window as any).__adl?.engine?.root.dataset.viewReady, undefined, {
      timeout: 30000,
    });
    await h.page.locator('[data-testid="example-badge"]').waitFor();
    // deleting a screen is refused: the screen stays and a toast offers the copy
    await h.page.evaluate(() => (window as any).__adl.app.set({ selection: ['S1'] }));
    await h.page.keyboard.press('Delete');
    await h.page.locator('.toast', { hasText: 'built-in example' }).waitFor();
    expect(await h.page.evaluate(() => !!(window as any).__adl.project.docs.pages.truth.items.S1)).toBe(true);
    // and nothing claims it happened (the delete toast "The HTML file stays in screens/" used to show anyway)
    expect(await h.page.locator('.toast', { hasText: 'stays in screens' }).count()).toBe(0);
    await h.page.locator('[data-testid="copy-example"]').click();
    await h.page.waitForURL(/\/p\/still$/);
    expect(fs.existsSync(path.join(h.root, 'still', 'project.json'))).toBe(true);
    await expect.poll(() => h.page.locator('[data-testid="example-badge"]').count()).toBe(0);
  });

  it('no errors in the console', () => expect(h.errors).toEqual([]));
});
