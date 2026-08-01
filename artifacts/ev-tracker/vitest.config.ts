import path from "path";
import { defineConfig } from "vitest/config";

// Dedicated Vitest config so the suite does NOT load the app's vite.config.ts
// (which throws without PORT/BASE_PATH). Pure-TS helper tests run in the
// default node environment; component tests opt into jsdom with a
// `// @vitest-environment jsdom` pragma at the top of the file.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  // App source relies on the automatic JSX runtime (no `import React`), which
  // the Vite app config normally provides via the React plugin.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
