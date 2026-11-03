import { describe, expect, it } from 'vitest';
import { opNeedsSnapshots } from '../../src/node/snapshot/service.ts';

describe('opNeedsSnapshots', () => {
  it('queues pictures for a screen added with its own frame', () => {
    expect(opNeedsSnapshots({ path: ['items', 'S9'], value: { kind: 'screen', frame: '390x300', x: 0, y: 0 } })).toBe(
      true,
    );
  });

  it('queues pictures for a new page whose screens carry frames', () => {
    const page = { items: { S1: { kind: 'screen', frame: '1400x900' } } };
    expect(opNeedsSnapshots({ path: [], value: page })).toBe(true);
  });

  it('queues pictures when a frame, the freeze time or the screen an item shows changes', () => {
    expect(opNeedsSnapshots({ path: ['items', 'S9', 'frame'], value: '390x300' })).toBe(true);
    expect(opNeedsSnapshots({ path: ['snapshotAt'], value: 1200 })).toBe(true);
    expect(opNeedsSnapshots({ path: ['items', 'S9', 'screen'], value: 'S2' })).toBe(true);
  });

  it('leaves moves, notes and screens on the default frame alone', () => {
    expect(opNeedsSnapshots({ path: ['items', 'S9', 'x'], value: 40 })).toBe(false);
    expect(opNeedsSnapshots({ path: ['items', 'n-1'], value: { kind: 'note', text: 'a frame of mind' } })).toBe(false);
    expect(opNeedsSnapshots({ path: ['items', 'S9'], value: { kind: 'screen', x: 0, y: 0 } })).toBe(false);
  });
});
