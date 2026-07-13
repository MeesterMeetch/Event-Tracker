---
name: CLV closing-line capture jobs
description: Gotchas in the game-line (clv.ts) and paper-trade (model-clv.ts) closing-line capture jobs.
---

# CLV closing-line capture

- **The trimmed-mean-in-decimal-space + ≥2-book rule is now ONE shared helper.** `trimmedMeanClosingAmerican(americanPrices[])` in `odds-math.ts` is the single source of truth: converts each price to decimal, drops the single best+worst when ≥4 books quote the line (trimmed mean), means the rest, converts back, and returns null below `MIN_CLOSING_BOOKS` (2). Both `findClosingOdds` (`clv.ts`) and `closingConsensusForLine` (`pitcher-k-scanner.ts`) call it. `clv.test.ts` expectations track this (e.g. two-book -110 & +120 → +105; five books incl. a +400 outlier → -101, not the +146 a plain mean gives).
  **Why:** raw-American averaging is mathematically wrong (odds aren't linear) and a plain mean lets one stale/mispriced book drag the close off. The two jobs previously carried duplicate copies and could drift apart when tuned.
  **How to apply:** tweak the trim size / min-book threshold ONLY in `trimmedMeanClosingAmerican` so both beat-the-close numbers stay in lockstep — never re-inline it into a single closer.

- **Abstain semantics differ between the two jobs.** `clv.ts` never expires a bet — on missing/degraded feed it just leaves `closingOdds` null (retry next cycle). `model-clv.ts` marks a trade `expired` only once past `commenceTime + 3h` (give-up window); before that it leaves it `open`. Neither ever writes a partial/bogus CLV.

- **Consensus needs ≥2 books.** `closingConsensusForLine` returns null when `side.books.size < 2`, so a thin/one-book feed → abstain, not a fabricated close.
