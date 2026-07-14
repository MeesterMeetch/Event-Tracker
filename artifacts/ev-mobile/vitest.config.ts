import path from 'path';
import { defineConfig } from 'vitest/config';

// Dedicated Vitest config for the mobile package. Pure-TS helper tests run in
// the default node environment; component tests opt into jsdom with a
// `// @vitest-environment jsdom` pragma and render through react-native-web,
// keeping the suite decoupled from Expo/Metro entirely. Component tests live
// in __tests__/ (NOT app/) so expo-router never picks them up as routes.
export default defineConfig({
  resolve: {
    alias: {
      'react-native': 'react-native-web',
      '@': path.resolve(import.meta.dirname, '.'),
    },
  },
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts', '__tests__/**/*.test.{ts,tsx}'],
  },
});
