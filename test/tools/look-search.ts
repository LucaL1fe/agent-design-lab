import { chromium } from 'playwright-core';

const [url, out, query, after] = process.argv.slice(2);
const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errors: string[] = [];
p.on('pageerror', (e) => errors.push(e.message));
p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await p.goto(url!);
await p.waitForFunction(() => (window as any).__adl?.engine?.root.dataset.viewReady);
await p.keyboard.press('Meta+k');
await p.locator('[data-testid="search"] input').fill(query!);
await p.waitForTimeout(800);
if (after === 'enter') {
  await p.keyboard.press('Enter');
  await p.waitForTimeout(1500);
}
await p.screenshot({ path: out! });
console.log(errors.length ? errors.join('\n') : 'no errors');
await b.close();
