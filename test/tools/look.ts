// Dev helper: open the running app in headless Chrome, run optional steps, screenshot, print console errors.
// node test/tools/look.ts <url> <out.png> [js-to-run-after-load] [wait-ms]
import { chromium } from 'playwright-core';

const [url, out, script, wait] = process.argv.slice(2);
const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors: string[] = [];
p.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`);
});
p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await p.goto(url!, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(Number(wait ?? 2500));
if (script) {
  const r = await p.evaluate(script);
  if (r !== undefined) console.log('result:', JSON.stringify(r));
  await p.waitForTimeout(Number(wait ?? 2500));
}
await p.screenshot({ path: out! });
console.log(errors.length ? errors.join('\n') : 'no console errors');
await b.close();
