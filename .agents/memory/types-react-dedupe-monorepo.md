---
name: "@types/react dedupe across web+Expo monorepo"
description: Running pnpm add can re-bind web-side react-day-picker/radix to Expo's @types/react 19.1 copy, breaking the web typecheck; dedupe via a workspace override.
---

# @types/react dedupe (web + Expo in one pnpm workspace)

When the workspace has both web artifacts (catalog `@types/react` `^19.2.0`) and
an Expo artifact (`~19.1.x`), any `pnpm add` / re-resolve can make a web
artifact's transitive peers (e.g. `react-day-picker` in `calendar.tsx`, radix in
`button-group.tsx`) bind to the Expo **19.1** copy while the artifact itself
compiles against **19.2**. The result is a typecheck-only failure like:

```
Two different types with this name exist, but they are unrelated.
```

referencing two `@types/react` paths (…/@types+react@19.2.17 vs the 19.1 copy).

**Why:** two `@types/react` majors coexist because Expo pins react/@types to
19.1 exactly; peer resolution is not deterministic across installs, so a
seemingly unrelated dependency add can flip which copy a web-side package sees.

**How to apply:** add a workspace-wide override so web-side compiles only ever
see one `@types/react`:

```yaml
# pnpm-workspace.yaml → overrides:
"@types/react": "^19.2.0"
"@types/react-dom": "^19.2.0"
```

Runtime `react` stays pinned to 19.1.0 (Expo requirement); 19.2 **types** are a
backward-compatible superset and match how the web already runs, so ev-mobile
still typechecks. After editing, `pnpm install` then run the full
`pnpm run typecheck` (both ev-tracker and ev-mobile) to confirm. A 19.1 copy may
still linger in the store — that's fine as long as the full typecheck is green.
