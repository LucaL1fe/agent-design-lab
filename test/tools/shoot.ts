// Dev helper for README pictures: open a page at 2x, run a script, wait, screenshot.
// node test/tools/shoot.ts <url> <out.png> [js] [wait-ms] [width] [height]
import { chromium } from 'playwright-core';

const [url, out, script, wait, w, h] = process.argv.slice(2);
const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await b.newPage({ viewport: { width: Number(w ?? 1440), height: Number(h ?? 900) }, deviceScaleFactor: 2 });
await p.goto(url!);
await p.waitForFunction(
  () => (window as any).__adl?.engine?.root.dataset.viewReady || !location.pathname.startsWith('/p/'),
);
if (script) await p.evaluate(script);
await p.waitForTimeout(Number(wait ?? 3000));
await p.screenshot({ path: out! });
await b.close();
