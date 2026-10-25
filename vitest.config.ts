import { defineConfig } from 'vitest/config';

// `npm test`: unit, property and integration tests. `npm run e2e`: browser tests (real Chrome, built app).
export default defineConfig({
  test: {
    include: process.env.E2E
      ? ['test/e2e/**/*.test.ts']
      : ['test/unit/**/*.test.ts', 'test/property/**/*.test.ts', 'test/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    fileParallelism: !process.env.E2E,
  },
});
