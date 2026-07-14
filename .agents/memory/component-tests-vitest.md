---
name: Component tests under Vitest (web + Expo)
description: How to run React component tests in this monorepo's vitest setups (jsdom pragma, JSX runtime, react-native-web aliasing, cleanup).
---

Both artifact vitest configs keep `environment: 'node'` for pure-TS tests; component tests opt in per-file with a `// @vitest-environment jsdom` pragma.

**Web (ev-tracker):**
- App source uses the automatic JSX runtime (no `import React`), normally provided by the Vite React plugin. The standalone vitest config must set `esbuild: { jsx: "automatic" }` or renders die with "React is not defined" *inside app source files*.
- Radix dialogs set `pointer-events: none` on the body — use `userEvent.setup({ pointerEventsCheck: 0 })` or clicks on dialog content fail.

**Mobile (ev-mobile):**
- Render RN components through react-native-web: alias `'react-native': 'react-native-web'` (already a dep) in vitest.config.ts. No Expo/Metro runtime needed.
- Put component tests in `__tests__/` at the package root, NOT under `app/` — expo-router scans `app/` and would treat a `.test.tsx` file as a route.
- Mock `expo-haptics`, `@expo/vector-icons`, `react-native-safe-area-context`, and the shared `@/components/ui` kit (it imports react-native-reanimated, which doesn't load in jsdom).
- `accessibilityLabel` on Pressables maps to `aria-label` in react-native-web → `getByLabelText` works.

**Both:** vitest globals are off, so testing-library auto-cleanup never registers — add `afterEach(cleanup)` explicitly or renders leak across tests and `getByText` finds duplicates.

**Why:** first component-test setup took several failing runs to discover all four traps (JSX runtime, route scanning, cleanup, pointer-events).
**How to apply:** any new component test in either artifact; copy the mock/setup pattern from `ModelEdges.test.tsx` (web) or `__tests__/scorecard-trade-row.test.tsx` (mobile).
