import { chromium } from 'playwright-core';

const [url, out, select, keys] = process.argv.slice(2);
const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errors: string[] = [];
p.on('pageerror', (e) => errors.push(e.message));
p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await p.goto(url!);
await p.waitForFunction(() => (window as any).__adl?.engine?.root.dataset.viewReady);
if (select) await p.evaluate((s) => (window as any).__adl.app.set({ selection: [s] }), select);
await p.keyboard.press('p');
await p.waitForTimeout(1200);
for (const k of (keys ?? '').split(',').filter(Boolean)) {
  await p.keyboard.press(k);
  await p.waitForTimeout(900);
}
await p.screenshot({ path: out! });
console.log(await p.evaluate(() => JSON.stringify((window as any).__adl.app.get().presenting)));
console.log(errors.length ? errors.join('\n') : 'no errors');
await b.close();
