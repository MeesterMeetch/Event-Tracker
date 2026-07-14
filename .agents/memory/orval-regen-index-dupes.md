---
name: orval regen duplicates workspace index exports
description: Running orval appends duplicate `export * from './generated/...'` lines to lib index.ts files.
---

# Orval regen appends duplicate export lines

Running `pnpm exec orval` in `lib/api-spec` appends `export * from './generated/api'` (and schemas/types) to `lib/api-zod/src/index.ts` and `lib/api-client-react/src/index.ts` even when equivalent lines already exist (it doesn't recognize the existing double-quoted lines).

**Why:** orval's workspace mode auto-manages the index barrel and only string-matches its own single-quoted style.

**How to apply:** after every orval regen, check both `index.ts` files and remove duplicated export lines before rebuilding dists (`tsc -b`).
