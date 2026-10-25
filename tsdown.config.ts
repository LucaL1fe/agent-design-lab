// The npm package's command line: src/node bundled to dist/node/cli.js (dependencies stay external). The app is built
// by Vite into dist/app; a clone runs src/ directly through ./adl.
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { cli: 'src/node/cli.ts' },
  outDir: 'dist/node',
  format: 'esm',
  platform: 'node',
  target: 'node22.18',
  clean: true,
  dts: false,
  sourcemap: false,
  shims: false,
  outExtensions: () => ({ js: '.js' }),
  // Vite is only loaded by `adl serve --dev` (working on ADL itself) and is not a runtime dependency
  external: [/^vite($|\/)/, /^@vitejs\//],
});
