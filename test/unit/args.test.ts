// The CLI argument parser.
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/node/commands/registry.ts';

describe('parseArgs', () => {
  it('a switch never swallows the next word: adl render --sheet S1 S2', () => {
    expect(parseArgs(['--sheet', 'S1', 'S2'])).toEqual({ _: ['S1', 'S2'], sheet: true });
    expect(parseArgs(['S1', '--entry', 'S2'])).toEqual({ _: ['S1', 'S2'], entry: true });
  });
  it('other flags take the next word as their value, repeated flags collect', () => {
    expect(parseArgs(['S2', 'S3', '--after', 'S1', '--chain', '--label', 'Go', '--label', 'Next'])).toEqual({
      _: ['S2', 'S3'],
      after: 'S1',
      chain: true,
      label: ['Go', 'Next'],
    });
  });
  it('--no-x turns a switch off, --x=value always sets a value', () => {
    expect(parseArgs(['--no-background', '--width=300'])).toEqual({ _: [], background: false, width: '300' });
  });
});
