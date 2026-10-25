import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: path.resolve(import.meta.dirname, 'src/app'),
  base: '/',
  plugins: [react()],
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/app'),
    emptyOutDir: true,
    target: 'es2023',
    rollupOptions: {
      input: {
        index: path.resolve(import.meta.dirname, 'src/app/index.html'),
        snap: path.resolve(import.meta.dirname, 'src/app/snap.html'),
      },
    },
  },
});
