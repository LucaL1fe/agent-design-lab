import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../src');
function files(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? files(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : [],
    );
}
function imports(file: string): string[] {
  const src = fs.readFileSync(file, 'utf8');
  return [...src.matchAll(/(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}
const layerOf = (abs: string) => path.relative(root, abs).split(path.sep)[0];

describe('layers', () => {
  it('core and protocol import only core/protocol and zod', () => {
    for (const f of [...files(path.join(root, 'core')), ...files(path.join(root, 'protocol'))]) {
      for (const spec of imports(f)) {
        if (spec.startsWith('.'))
          expect(['core', 'protocol'], `${f} imports ${spec}`).toContain(layerOf(path.resolve(path.dirname(f), spec)));
        else expect(['zod'], `${f} imports ${spec}`).toContain(spec);
      }
    }
  });
  it('app never imports node code', () => {
    for (const f of files(path.join(root, 'app')))
      for (const spec of imports(f))
        if (spec.startsWith('.'))
          expect(layerOf(path.resolve(path.dirname(f), spec)), `${f} imports ${spec}`).not.toBe('node');
  });
  it('node never imports app code', () => {
    for (const f of files(path.join(root, 'node')))
      for (const spec of imports(f))
        if (spec.startsWith('.'))
          expect(layerOf(path.resolve(path.dirname(f), spec)), `${f} imports ${spec}`).not.toBe('app');
  });
});
