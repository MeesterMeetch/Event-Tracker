---
name: api-server route test harness
description: Gotchas when writing node:http route tests for artifacts/api-server (mocks, module cache, req.log)
---

# Route test harness (artifacts/api-server/src/routes/*.test.ts)

Pattern: mock deps with `vi.mock`, build a small express app, dynamically
`import` the router inside `buildApp()`, drive it with a real `node:http`
request (see `bets.test.ts` for the canonical helper).

**`vi.mock` factory instances survive `vi.resetModules()`.**
If a test resets modules per test to get a fresh module-level cache (e.g. the
`/analysis` route's in-memory analysis cache Map), the *mocked* dependency
functions are NOT recreated — they keep accumulating call counts across tests.
Add `vi.clearAllMocks()` in `beforeEach` (alongside `vi.resetModules()`) or
`toHaveBeenCalledTimes` assertions will see totals from previous tests.
**Why:** resetModules clears the user-module registry but leaves registered
mocks intact.

**Routes call `req.log.*`; express has no `req.log` by default.**
Production attaches it via `pino-http`. In tests, add a middleware before the
router that sets `req.log = { error, warn, info, debug }` (no-op `vi.fn()`s),
or the error path throws instead of returning its intended status.

**Testing TTL/cache windows:** spy on `Date.now()`
(`vi.spyOn(Date, "now").mockReturnValue(...)`) rather than `vi.useFakeTimers()`
— faking timers wholesale can stall the real `node:http` server. `Date.now()`
alone drives the cache expiry math.
