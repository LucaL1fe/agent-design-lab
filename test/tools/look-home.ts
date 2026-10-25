import { chromium } from 'playwright-core';

const [url, out1, out2] = process.argv.slice(2);
const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errors: string[] = [];
p.on('pageerror', (e) => errors.push(e.message));
await p.goto(url!);
await p.waitForTimeout(1200);
await p.screenshot({ path: out1! });
const card = p.locator('[data-testid="new-project"]').first();
if (await card.count()) {
  await card.click();
  await p.waitForTimeout(300);
  await p.keyboard.type('Bakery site');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(1500);
}
await p.screenshot({ path: out2! });
console.log(p.url(), errors.length ? errors : 'no errors');
await b.close();
