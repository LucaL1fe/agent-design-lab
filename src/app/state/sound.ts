// Turning sound on and off. Always from a click: that is when the browser lets audio start.
import type { Id } from '../../core/types.ts';
import { player } from '../engine/sound.ts';
import { app, toast } from './app.ts';

/** The speaker of a screen: it plays with sound, every other screen goes quiet. Again turns it off. */
export function toggleScreenSound(id: Id) {
  if (app.get().sound === id) {
    app.set({ sound: undefined });
    return;
  }
  if (app.get().animations === 'never') {
    toast({ kind: 'info', text: 'Sounds play with the animations, which are off (zoom menu → Animations in screens)' });
    return;
  }
  player.unlock();
  app.set({ sound: id });
}

export function togglePresentSound() {
  const on = !app.get().presentSound;
  if (on) player.unlock();
  app.set({ presentSound: on });
}
