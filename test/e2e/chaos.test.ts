// Chaos: random clicks, drags, keys, notes, connects, undo/redo, page switches and searches, while an "agent" keeps
// writing page and screen files: stale copies, half-written JSON, files renamed away and back, new screens.
// Nothing may crash or log an error, every file must stay valid, and in the end the server, the disk and the canvas
// agree.  CHAOS_SECONDS=1800 E2E=1 npx vitest run test/e2e/chaos.test.ts for the long run.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseJson } from '../../src/core/json.ts';
import { fitAndWait, type Harness, harness, openDemo, SCREEN, until } from './fixture.ts';

const SECONDS = Number(process.env.CHAOS_SECONDS ?? 45);
let h: Harness;
beforeAll(async () => {
  h = await harness({ snapshots: true });
  await openDemo(h);
  await fitAndWait(h, ['sec-a', 'sec-b']);
}, 120000);
afterAll(async () => h?.close());

let seed = 1234;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;

describe('chaos', () => {
  it(
    `${SECONDS} s of random people and agent actions`,
    async () => {
      const page = h.page;
      const file = path.join(h.pdir, 'pages', 'truth.json');
      const { width, height } = page.viewportSize()!;
      const counts: Record<string, number> = {};
      const did = (k: string) => {
        counts[k] = (counts[k] ?? 0) + 1;
      };
      let newScreens = 0;
      const deadline = Date.now() + SECONDS * 1000;

      const person = async () => {
        const r = rnd();
        const x = 80 + rnd() * (width - 400);
        const y = 120 + rnd() * (height - 200);
        if (r < 0.2) {
          await page.mouse.move(x, y);
          await page.mouse.down();
          await page.mouse.move(x + (rnd() - 0.5) * 300, y + (rnd() - 0.5) * 300, { steps: 4 });
          await page.mouse.up();
          did('drag');
        } else if (r < 0.32) {
          await page.mouse.click(x, y);
          did('click');
        } else if (r < 0.4) {
          await page.keyboard.press(pick(['Meta+z', 'Meta+Shift+z']));
          did('undo/redo');
        } else if (r < 0.46) {
          await page.keyboard.press('n');
          await page.mouse.click(x, y);
          await page.keyboard.type('chaos note');
          await page.keyboard.press('Escape');
          did('note');
        } else if (r < 0.52) {
          await page.mouse.wheel(0, (rnd() - 0.5) * 600);
          did('scroll');
        } else if (r < 0.56) {
          await page.keyboard.down('Meta');
          await page.mouse.wheel(0, (rnd() - 0.5) * 400);
          await page.keyboard.up('Meta');
          did('zoom');
        } else if (r < 0.6) {
          await page.keyboard.press('Meta+k');
          await page.keyboard.type(pick(['Screen', 'next', 'font', 'zzz']));
          await page.keyboard.press(pick(['Enter', 'Escape']));
          await page.keyboard.press('Escape');
          did('search');
        } else if (r < 0.63) {
          await page.keyboard.press('p');
          await page.keyboard.press(pick(['ArrowRight', 'ArrowLeft']));
          await page.keyboard.press('Escape');
          did('present');
        } else if (r < 0.67) {
          await page.keyboard.press('Shift+Digit1');
          did('fit');
        } else if (r < 0.7) {
          await page.keyboard.press(pick(['Backspace', 'Meta+d', 'ArrowLeft', 'Shift+ArrowUp']));
          did('key');
        } else if (r < 0.73) {
          await page.keyboard.press('Escape');
          await page.keyboard.press('Meta+a');
          await page.keyboard.press(pick(['Meta+d', 'Escape']));
          did('select all');
        }
      };

      const agent = async () => {
        const r = rnd();
        if (r < 0.35) {
          // a stale read-modify-write of the page
          const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
          const ids = Object.keys(doc.items).filter((k) => doc.items[k].kind === 'screen');
          const id = pick(ids);
          doc.items[id].banner = `agent ${Math.floor(rnd() * 1000)}`;
          doc.items[id].status = pick(['new', 'needs-fix', 'to-decide', 'approved']);
          await new Promise((res) => setTimeout(res, rnd() * 300));
          fs.writeFileSync(file, JSON.stringify(doc, null, 2));
          did('agent page write');
        } else if (r < 0.45) {
          // a broken write, fixed a moment later (an editor saving halfway)
          const good = fs.readFileSync(file, 'utf8');
          fs.writeFileSync(file, good.slice(0, Math.floor(good.length / 2)));
          await new Promise((res) => setTimeout(res, 150 + rnd() * 400));
          fs.writeFileSync(file, good);
          did('agent broken write');
        } else if (r < 0.65) {
          const id = pick(['A1', 'A2', 'A3', 'B1', 'B2', 'B3']);
          fs.writeFileSync(
            path.join(h.pdir, 'screens', `${id}.html`),
            SCREEN(`Screen ${id} v${Math.floor(rnd() * 100)}`, pick(['#1d2b4f', '#3b1d4f', '#1d4f3a'])),
          );
          did('agent screen write');
        } else if (r < 0.72) {
          // renamed away and back (some editors save like this)
          const id = pick(['A2', 'B1']);
          const f = path.join(h.pdir, 'screens', `${id}.html`);
          if (fs.existsSync(f)) {
            fs.renameSync(f, `${f}.tmp`);
            await new Promise((res) => setTimeout(res, 100 + rnd() * 300));
            fs.renameSync(`${f}.tmp`, f);
          }
          did('agent rename');
        } else if (r < 0.78 && newScreens < 6) {
          newScreens++;
          const id = `C${newScreens}`;
          fs.writeFileSync(path.join(h.pdir, 'screens', `${id}.html`), SCREEN(`New ${id}`, '#2b2b2b'));
          await h.server.service.apply(
            'demo',
            [{ doc: 'page:truth', path: ['items', id], value: { kind: 'screen', status: 'new' } }],
            { actor: 'agent', summary: `Claude added ${id}` },
          );
          did('agent new screen');
        }
      };

      while (Date.now() < deadline) {
        await Promise.all([person(), rnd() < 0.5 ? agent() : Promise.resolve()]);
        await page.waitForTimeout(40 + rnd() * 120);
      }
      // let everything settle: debounced writes, the watcher, the snapshot queue
      await page.keyboard.press('Escape');
      await new Promise((res) => setTimeout(res, 2500));
      await h.server.service.flush();
      await new Promise((res) => setTimeout(res, 800));

      fs.mkdirSync('test-results', { recursive: true });
      fs.writeFileSync('test-results/chaos.json', `${JSON.stringify({ seconds: SECONDS, counts }, null, 2)}\n`);
      expect(h.errors).toEqual([]);
      // every page file parses and equals the server's copy
      const st = h.server.service.projects.get('demo')!;
      for (const pid of st.docs.project.pages) {
        const text = fs.readFileSync(path.join(h.pdir, 'pages', `${pid}.json`), 'utf8');
        const parsed = parseJson(text);
        expect(parsed.ok, pid).toBe(true);
        if (parsed.ok) {
          // same content; the rev may lag: when an agent writes back exactly what the server holds, the server does
          // not rewrite the file under the agent, so the file keeps the (older) rev the agent read
          const disk = parsed.value as { rev: number };
          const server = st.docs.pages[pid]!;
          expect({ ...disk, rev: 0 }).toEqual({ ...server, rev: 0 });
          expect(disk.rev).toBeLessThanOrEqual(server.rev);
        }
      }
      expect(st.problems.filter((p) => p.level === 'error')).toEqual([]);
      // the canvas shows the server's state
      await until(async () => {
        const client = await page.evaluate(() => JSON.stringify((window as any).__adl.project.docs.pages.truth));
        return client === JSON.stringify(st.docs.pages.truth);
      }, 8000);
    },
    (SECONDS + 120) * 1000,
  );
});
