import { defineConfig } from 'vitest/config';

// Dedicated Vitest config for the mobile package. The format helpers are pure
// TS (no React Native imports), so a plain node environment is all we need —
// this keeps the suite decoupled from Expo/Metro entirely.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
  },
});
