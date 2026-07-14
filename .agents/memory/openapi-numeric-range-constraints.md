---
name: OpenAPI disjoint numeric ranges via oneOf
description: How to enforce "x ≤ -100 or x ≥ 100"-style constraints in the shared spec so orval-generated zod agrees
---

To ban a numeric interval (e.g. American odds inside (-100, 100)) in the shared OpenAPI spec, use
`oneOf: [{type: number, maximum: -100}, {type: number, minimum: 100}]` on the property.

Orval (zod client) generates `zod.union([zod.number().max(-100), zod.number().min(100)])`, so the
server-side request-body schemas enforce it automatically — no hand-written route guard needed
(any post-parse guard becomes unreachable dead code; don't add one). The generated TS type stays
plain `number`, which is fine.

**Why:** keeps the constraint in one place (spec) so server + generated clients can never disagree.
**How to apply:** after editing the spec, run `pnpm exec orval` in the spec lib, dedupe the appended
index.ts export lines, and `tsc -b` the changed libs (see existing memory entries).
