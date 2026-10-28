// Sound in screens: a screen with data-adl-sound gets a speaker in its caption. Nothing plays until it is clicked;
// then that one screen plays its cue every round of its element's animation, until it is turned off. Present mode has
// its own switch.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toneWav } from '../tools/wav.ts';
import { fitAndWait, type Harness, harness, openDemo, SCREEN } from './fixture.ts';

let h: Harness;
beforeAll(async () => {
  h = await harness();
  // count every sound that starts (a real AudioContext still decodes and runs in headless Chrome)
  await h.page.addInitScript(() => {
    (window as any).__starts = 0;
    (window as any).__stops = 0;
    const start = AudioBufferSourceNode.prototype.start;
    const stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof start>) {
      (window as any).__starts++;
      return start.apply(this, args);
    };
    AudioBufferSourceNode.prototype.stop = function (...args: Parameters<typeof stop>) {
      (window as any).__stops++;
      return stop.apply(this, args);
    };
  });
  fs.mkdirSync(path.join(h.pdir, 'sounds'));
  // longer than a round, so each round has to cut the one before
  fs.writeFileSync(path.join(h.pdir, 'sounds', 'tick.wav'), toneWav(900));
  // A2: a dot that turns once every 600 ms and ticks each time, 100 ms into the turn
  fs.writeFileSync(
    path.join(h.pdir, 'screens', 'A2.html'),
    SCREEN(
      'Screen A2',
      '#3b1d4f',
      '<div class="spin" data-adl-sound="../sounds/tick.wav" data-adl-sound-at="100ms" style="width:40px;height:40px;background:#fff;margin:30px;animation-duration:600ms"></div>',
    ),
  );
  // A3: a line without an animation that sounds once, 200 ms after the screen starts
  fs.writeFileSync(
    path.join(h.pdir, 'screens', 'A3.html'),
    SCREEN('Screen A3', '#1d4f3a', '<p data-adl-sound="../sounds/tick.wav" data-adl-sound-at="200ms">Saved</p>'),
  );
  await openDemo(h);
  await h.page.waitForFunction(() => {
    const s = (window as any).__adl.project.screens;
    return s.A2?.sounds?.length === 1 && s.A3?.sounds?.length === 1;
  });
}, 60000);
afterAll(async () => h?.close());

const starts = () => h.page.evaluate(() => (window as any).__starts as number);
const stops = () => h.page.evaluate(() => (window as any).__stops as number);
const state = () =>
  h.page.evaluate(() => {
    const a = (window as any).__adl;
    return {
      sound: a.app.get().sound as string | undefined,
      audible: a.engine.audible as string | undefined,
      selection: a.app.get().selection as string[],
    };
  });

describe('sound on the canvas', () => {
  it('only screens with sounds get a speaker, and nothing plays until it is clicked', async () => {
    await fitAndWait(h, ['A1', 'A2', 'A3']);
    await expect.poll(() => h.page.locator('.it.scr[data-id="A2"].live').count()).toBe(1);
    expect(await h.page.locator('.it.scr[data-id="A2"] .snd, .it.scr[data-id="A3"] .snd').count()).toBe(2);
    expect(await h.page.locator('.it.scr[data-id="A1"] .snd').count()).toBe(0);
    await h.page.waitForTimeout(1300);
    expect(await starts()).toBe(0);
  });

  it('the speaker plays that screen every round of its animation (a new round cuts the last), without selecting it', async () => {
    await h.page.evaluate(() => (window as any).__adl.app.set({ selection: ['A1'] }));
    await h.page.locator('.it.scr[data-id="A2"] .snd').click();
    await expect.poll(state).toMatchObject({ sound: 'A2', audible: 'A2', selection: ['A1'] });
    expect(await h.page.locator('.it.scr[data-id="A2"].snd-on').count()).toBe(1);
    await expect(h.page.locator('[data-testid="sound-pill"]').innerText()).resolves.toContain('A2');
    // 600 ms rounds: about five ticks in three seconds
    await h.page.waitForTimeout(3000);
    const n = await starts();
    expect(n).toBeGreaterThanOrEqual(4);
    expect(n).toBeLessThanOrEqual(6);
    // the 900 ms sound never overlaps itself: each round stopped the one still playing
    expect(await stops()).toBeGreaterThanOrEqual(n - 2);
  });

  it('turning it off stops it; the speaker again turns it back on', async () => {
    await h.page.locator('[data-testid="sound-pill"] button[aria-label="Turn the sound off"]').click();
    await expect.poll(state).toMatchObject({ sound: undefined, audible: undefined });
    const n = await starts();
    await h.page.waitForTimeout(1300);
    expect(await starts()).toBe(n);
    expect(await h.page.locator('[data-testid="sound-pill"]').count()).toBe(0);
    await h.page.locator('.it.scr[data-id="A2"] .snd').click();
    await expect.poll(state).toMatchObject({ sound: 'A2' });
    await expect.poll(starts, { timeout: 3000 }).toBeGreaterThan(n);
    await h.page.locator('.it.scr[data-id="A2"] .snd').click();
    await expect.poll(state).toMatchObject({ sound: undefined });
  });

  it('an element without an animation sounds once, and again each time the sound is turned on', async () => {
    const n = await starts();
    await h.page.locator('.it.scr[data-id="A3"] .snd').click();
    await expect.poll(state).toMatchObject({ sound: 'A3', audible: 'A3' });
    await expect.poll(starts, { timeout: 3000 }).toBe(n + 1);
    await h.page.waitForTimeout(1500);
    expect(await starts()).toBe(n + 1);
    await h.page.locator('.it.scr[data-id="A3"] .snd').click();
    await h.page.locator('.it.scr[data-id="A3"] .snd').click();
    await expect.poll(starts, { timeout: 3000 }).toBe(n + 2);
    await h.page.locator('.it.scr[data-id="A3"] .snd').click();
    await expect.poll(state).toMatchObject({ sound: undefined });
  });
});

describe('sound in present mode', () => {
  it('stays quiet until its switch is on, then plays the presented screen', async () => {
    await h.page.evaluate(() => (window as any).__adl.app.set({ selection: ['A2'] }));
    await h.page.keyboard.press('p');
    await expect.poll(() => h.page.locator('[data-testid="present-sound"]').innerText()).toContain('Sound off');
    const n = await starts();
    await h.page.waitForTimeout(1300);
    expect(await starts()).toBe(n);
    await h.page.locator('[data-testid="present-sound"]').click();
    await expect.poll(() => h.page.locator('[data-testid="present-sound"]').innerText()).toContain('Sound on');
    await h.page.waitForTimeout(1500);
    expect(await starts()).toBeGreaterThanOrEqual(n + 2);
    await h.page.keyboard.press('Escape');
    expect(h.errors).toEqual([]);
  });
});
