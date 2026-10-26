import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['tests/global-setup.ts'],
    testTimeout: 20000,
    hookTimeout: 30000,
    pool: 'forks',
  },
});
