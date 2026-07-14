---
name: api-spec / db schema change → rebuild dist declarations
description: After adding an API/DB field, consumers typecheck against stale dist .d.ts, not src, because of project references.
---

# Adding a field across the API-spec + DB stack

Adding one persisted field touches five places, in order:
1. `lib/db/src/schema/*.ts` (Drizzle column) — then `pnpm --filter @workspace/db run push` to apply to the DB.
2. `lib/api-spec/openapi.yaml` (both the response schema AND the `*Input` schema).
3. Regenerate clients: `cd lib/api-spec && pnpm exec orval` (writes `lib/api-zod/src` and `lib/api-client-react/src`).
4. Route: read the field off the parsed body and pass it into the insert.
5. Frontend: send it on create; read it where consumed.

**Why the gotcha:** the workspace packages (`@workspace/db`, `@workspace/api-zod`, `@workspace/api-client-react`) are consumed via TypeScript **project references**, which resolve to each package's built `dist/*.d.ts`, not its `src`. Regenerating/editing `src` is not enough — dependents (api-server, ev-tracker) keep typechecking against the **stale dist** and report "Property X does not exist" / "X does not exist in type".

**How to apply:** after regen, rebuild each changed lib's declarations before typechecking consumers:
`pnpm --filter @workspace/db exec tsc -b`, same for `@workspace/api-zod` and `@workspace/api-client-react`. Then `tsc --noEmit` in the consuming artifacts passes. (There is no `build` script — use `tsc -b` directly.)

**Durable policy — a consumer's `typecheck` script must build its referenced libs itself, not assume prebuilt dist.** Because `dist/` is gitignored, a fresh checkout / CI has no dist, and a bare `tsc -p tsconfig.json --noEmit` fails with TS6305 ("Output file has not been built from source file"). Give each artifact a self-contained check: `tsc -b tsconfig.json --force` (build mode follows the project-reference graph and rebuilds the referenced composite libs first; `--force` prevents a stale `tsconfig.tsbuildinfo` from skipping a required emit). The root `typecheck` already does this via `typecheck:libs` (`tsc --build`) — the per-artifact scripts must too, since they get run in isolation (e.g. `pnpm --filter <artifact> run typecheck`). Both `ev-tracker` and `api-server` are now fixed this way (each uses `tsc -b tsconfig.json --force`). Note: for a non-composite consumer whose runtime build is handled by a bundler (api-server uses esbuild), set `noEmit: true` in its tsconfig so build mode rebuilds the referenced lib declarations without emitting stray JS into the bundler's `dist`.
