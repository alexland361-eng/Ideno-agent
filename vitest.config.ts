import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts (which has root: src/web for the client build).
// Tests run from the repository root against the Node server code.
export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
