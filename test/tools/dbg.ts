import { centerOf, fitAndWait, harness, openDemo } from '../e2e/fixture.ts';

const h = await harness();
await openDemo(h);
h.page.on('console', (m) => console.log('page:', m.text()));
await fitAndWait(h, ['B1']);
await h.page.waitForTimeout(800);
console.log('live', await h.page.evaluate(() => (window as any).__adl.engine.stats));
await fitAndWait(h, ['B1', 'A1', 'B3']);
await h.page.waitForTimeout(500);
const [x, y] = await centerOf(h, 'B1');
await h.page.evaluate(() => {
  window.addEventListener(
    'pointerdown',
    (e) =>
      console.log(
        'PD',
        (e.target as any).className,
        e
          .composedPath()
          .slice(0, 4)
          .map((n: any) => n.className || n.nodeName)
          .join(' < '),
      ),
    true,
  );
  (window as any).__adl.engine.root.addEventListener('pointerdown', () => console.log('ROOT PD'));
});
console.log(
  'under',
  await h.page.evaluate(([px, py]) => (document.elementFromPoint(px, py) as HTMLElement)?.className, [x, y] as const),
);
await h.page.mouse.move(x, y);
await h.page.mouse.down();
await h.page.waitForTimeout(100);
console.log(
  'mode',
  JSON.stringify(await h.page.evaluate(() => (window as any).__adl.ix.mode)),
  await h.page.evaluate(() => (window as any).__adl.app.get().selection),
);
await h.page.mouse.up();
await h.close();
