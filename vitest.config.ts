import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts (which has root: src/web for the client build).
// Server tests run in node; UI tests declare happy-dom via a per-file
// @vitest-environment docblock.
export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
