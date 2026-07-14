---
name: Vitest for web artifacts needs a dedicated config
description: Why a web (Vite) artifact must ship its own vitest.config.ts instead of relying on Vitest auto-loading vite.config.ts
---

# Vitest for a web (Vite) artifact needs its own vitest.config.ts

Vitest auto-loads the nearest `vite.config.ts`. The web artifacts here have a
`vite.config.ts` that **throws at module load** when `PORT` / `BASE_PATH` are
unset (they're only set by the workflow runner, not in a plain test shell). So
running `vitest` with no dedicated config crashes before any test runs.

**Rule:** give the web artifact its own `vitest.config.ts` (using
`defineConfig` from `vitest/config`) that does NOT import the app's
`vite.config.ts`. Re-declare only what tests need — typically the `@` → `src`
alias and `test: { environment, include }`. Pure aggregation helpers run fine
with `environment: "node"`; no jsdom needed unless a test renders React.

**Why:** keeps the suite decoupled from dev-server env requirements so tests run
in CI/any shell. The api-server (esbuild, no vite.config) can rely on Vitest
defaults; web artifacts cannot.

**How to apply:** when adding the first test to a Vite web artifact, add
`vitest.config.ts` + a `"test": "vitest run"` script + the `vitest` devDep, and
keep pure logic in framework-free `src/lib/*.ts` modules so tests avoid pulling
in recharts/react.
