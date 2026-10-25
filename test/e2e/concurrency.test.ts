// A person drags screens while an agent writes the page file (often from a stale read). Nothing may get lost:
// the person's moves stay, the agent's changes to other fields land, the file and the canvas agree in the end.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { centerOf, fitAndWait, type Harness, harness, openDemo, until } from './fixture.ts';

let h: Harness;
beforeAll(async () => {
  h = await harness();
  await openDemo(h);
  await fitAndWait(h, ['sec-a', 'sec-b']);
}, 60000);
afterAll(async () => h?.close());

const RUNS = Number(process.env.CONCURRENCY_RUNS ?? 25);
let seed = 7;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

describe('people and agents at the same time', () => {
  it(`${RUNS} random drags with agent writes in the middle lose nothing`, async () => {
    const file = path.join(h.pdir, 'pages', 'truth.json');
    const screens = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3'];
    const statuses = ['new', 'to-decide', 'needs-fix', 'approved'];
    let lastCheck: unknown;
    let humanMoves: { id: string; x: number }[] = [];
    h.server.service.on('tx', (e: any) => {
      if (e.actor !== 'human') return;
      for (const o of e.ops)
        if (o.path[0] === 'items' && o.path.length === 2 && o.value?.pinned)
          humanMoves.push({ id: o.path[1], x: o.value.x });
    });

    for (let run = 0; run < RUNS; run++) {
      const dragId = screens[Math.floor(rnd() * screens.length)]!;
      const otherId = screens.filter((s) => s !== dragId)[Math.floor(rnd() * 5)]!;
      const status = statuses[Math.floor(rnd() * statuses.length)]!;
      const banner = `run ${run}`;
      humanMoves = [];
      const stale = JSON.parse(fs.readFileSync(file, 'utf8')); // what the agent read before the person started
      const xBefore = (h.server.service.projects.get('demo')!.docs.pages.truth!.items[dragId] as any).x;
      const undoBefore = await h.page.evaluate(() => (window as any).__adl.project.undoStack.length);
      await fitAndWait(h, [dragId, otherId]);
      const [x, y] = await centerOf(h, dragId);
      const sx = rnd() < 0.5 ? -1 : 1;
      const sy = rnd() < 0.5 ? -1 : 1;
      const dx = sx * Math.round(20 + rnd() * 60);
      const dy = sy * Math.round(20 + rnd() * 60);
      await h.page.mouse.move(x, y);
      await h.page.mouse.down();
      // well past the drag threshold before the agent writes
      await h.page.mouse.move(x + dx / 2, y + dy / 2, { steps: 3 });
      await h.page
        .waitForFunction(() => (window as any).__adl.engine.previewing, undefined, { timeout: 4000 })
        .catch(async (e) => {
          const info = await h.page.evaluate(
            ([px, py, id]) => {
              const el = document.elementFromPoint(px, py) as HTMLElement | null;
              const w = window as any;
              return {
                under: el?.className,
                underId: el?.closest('[data-id]')?.getAttribute('data-id'),
                mode: w.__adl.ix.mode,
                sel: w.__adl.app.get().selection,
                rect: w.__adl.engine.rects.get(id),
                v: w.__adl.engine.vp.v,
              };
            },
            [x, y, dragId] as const,
          );
          console.log('NO DRAG', run, dragId, x, y, JSON.stringify(info), 'ERRORS', JSON.stringify(h.errors));
          throw e;
        });
      // the agent writes its (stale) copy with a change to another screen, and sometimes also "moves" the dragged one
      stale.items[otherId].status = status;
      stale.items[otherId].banner = banner;
      if (rnd() < 0.5) stale.items[dragId].x = (stale.items[dragId].x ?? 0) + 999;
      fs.writeFileSync(file, JSON.stringify(stale, null, 2));
      await h.page.waitForTimeout(Math.floor(rnd() * 120));
      await h.page.mouse.move(x + dx, y + dy, { steps: 3 });
      await h.page.mouse.up();
      // expected: agent's status/banner on the other screen, the person's position on the dragged one
      await until(async () => {
        lastCheck = {
          run,
          dragId,
          otherId,
          status,
          banner,
          disk: JSON.parse(fs.readFileSync(file, 'utf8')).items,
          app: await h.page.evaluate(() => (window as any).__adl.project.docs.pages.truth.items),
          server: h.server.service.projects.get('demo')!.docs.pages.truth!.items,
        };
        const p = JSON.parse(fs.readFileSync(file, 'utf8'));
        const app = await h.page.evaluate(() => (window as any).__adl.project.docs.pages.truth.items);
        const agree = Object.keys(app).every(
          (id) =>
            Math.abs((p.items[id]?.x ?? 0) - (app[id]?.x ?? 0)) < 1 &&
            Math.abs((p.items[id]?.y ?? 0) - (app[id]?.y ?? 0)) < 1,
        );
        return (
          humanMoves.length > 0 && p.items[otherId]?.status === status && p.items[otherId]?.banner === banner && agree
        );
      }, 8000).catch((e) => {
        const c = lastCheck as any;
        console.log(
          'FAIL',
          JSON.stringify(
            {
              run: c.run,
              dragId: c.dragId,
              otherId: c.otherId,
              status: c.status,
              banner: c.banner,
              disk: { d: c.disk[c.dragId], o: c.disk[c.otherId] },
              app: { d: c.app[c.dragId], o: c.app[c.otherId] },
              server: { d: c.server[c.dragId], o: c.server[c.otherId] },
            },
            null,
            1,
          ),
        );
        throw e;
      });
      const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
      const inApp = await h.page.evaluate((id) => (window as any).__adl.project.docs.pages.truth.items[id], dragId);
      expect(Math.abs(onDisk.items[dragId].x - inApp.x)).toBeLessThan(1);
      // whatever the person really moved keeps the person's position, even when the agent's stale copy moved it too
      for (const m of humanMoves) expect(JSON.parse(fs.readFileSync(file, 'utf8')).items[m.id].x).toBe(m.x);
      void undoBefore;
      void xBefore;
      const server = h.server.service.projects.get('demo')!.docs.pages.truth!.items[dragId] as any;
      expect(server.x).toBe(onDisk.items[dragId].x);
    }
    expect(h.errors).toEqual([]);
  }, 300000);
});
