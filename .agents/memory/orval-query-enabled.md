---
name: Orval query hooks with enabled option
description: Passing `enabled` to a generated useXxx query hook's `query` option without `queryKey` breaks the frontend typecheck.
---

Generated Orval React Query hooks (`@workspace/api-client-react`) type the `query` option as `UseQueryOptions<...>`, which requires `queryKey` to be present on the object literal even though the hook itself supplies a default queryKey internally.

**Why:** TypeScript checks the literal passed to `options.query` against `UseQueryOptions`, which doesn't make `queryKey` optional at that call site — omitting it (e.g. `{ query: { enabled: !!id } }`) fails `tsc` with "Property 'queryKey' is missing".

**How to apply:** Whenever passing any `query` option object (most commonly `enabled` for conditional fetching), also pass `queryKey: getXxxQueryKey(params)` using the matching generated key-getter, e.g.:

```ts
useListEdges({ sport }, { query: { enabled: !!sport, queryKey: getListEdgesQueryKey({ sport }) } })
```

This is also documented in the react-vite skill's frontend-general-rules.md.
