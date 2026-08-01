import { defineConfig } from 'vitest/config';

// Pure-TS formatting helpers shared by the web and mobile apps; a plain node
// environment is all that's needed.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
