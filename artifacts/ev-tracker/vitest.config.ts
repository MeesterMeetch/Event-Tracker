import path from "path";
import { defineConfig } from "vitest/config";

// Dedicated Vitest config so the suite does NOT load the app's vite.config.ts
// (which throws without PORT/BASE_PATH). The scorecard aggregation helpers are
// pure TS, so a plain node environment is all that's needed.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
