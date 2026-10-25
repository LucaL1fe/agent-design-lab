// The server restarts (with a new key) while a tab is open. Regression: the tab kept retrying with the old key
// forever, "Reconnecting… changes wait until the server is back", and the changes it kept were never saved.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningServer, startServer } from '../../src/node/server/server.ts';
import { centerOf, fitAndWait, type Harness, harness, openDemo, until } from './fixture.ts';

let h: Harness;
let next: RunningServer | undefined;
beforeAll(async () => {
  h = await harness();
  await openDemo(h);
}, 60000);
afterAll(async () => {
  await next?.close();
  await h?.browser.close();
  fs.rmSync(h.root, { recursive: true, force: true });
});

const conn = () => h.page.evaluate(() => (window as any).__adl.app.get().conn as string);

describe('server restart', () => {
  it('the tab reconnects by itself, saves what it kept and catches up on the rest', async () => {
    await fitAndWait(h, ['A1', 'A2']);
    const [x, y] = await centerOf(h, 'A1');
    await h.page.mouse.click(x, y);
    await h.server.close();
    await until(async () => (await conn()) === 'closed');
    // a change made while the server is away waits in the tab
    await h.page.keyboard.press('Shift+ArrowRight');
    // and an agent changes a file meanwhile
    const file = path.join(h.pdir, 'pages', 'truth.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.arrows['A1>A2'].label = 'written while away';
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));

    next = await startServer({ workspace: h.root, port: h.server.port, quiet: true });
    expect(next.token).not.toBe(h.server.token);
    await until(async () => (await conn()) === 'open', 15000);
    await until(() => (h.readPage().items.A1 as any).x === 74);
    await until(
      async () => !!(await h.page.locator('.alab[data-id="A1>A2"]').textContent())?.includes('written while away'),
    );
    // calls that need the key work again (the tab took the new one)
    const status = await h.page.evaluate(async () => {
      const token = (window as any).__adl.boot.token as string;
      return (await fetch('/api/reload', { method: 'POST', headers: { 'x-adl-token': token } })).status;
    });
    expect(status).toBe(200);
    expect(await h.page.locator('.conn').count()).toBe(0);
    expect(h.errors.filter((e) => !/WebSocket/.test(e))).toEqual([]);
  }, 60000);
});
