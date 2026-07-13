---
name: CLV closing-line capture jobs
description: Gotchas in the game-line (clv.ts) and paper-trade (model-clv.ts) closing-line capture jobs.
---

# CLV closing-line capture

- **Both closers average in decimal space AND trim outliers.** `findClosingOdds` in `clv.ts` converts each book's American price to decimal, drops the single best+worst when ≥4 books quote the line (trimmed mean), means the rest, and converts back — matching `closingConsensusForLine`. With <4 books it uses all of them. `clv.test.ts` expectations track this (e.g. two-book -110 & +120 → +105; five books incl. a +400 outlier → -101, not the +146 a plain mean gives).
  **Why:** raw-American averaging is mathematically wrong (American odds aren't linear), and a plain mean lets one stale/mispriced book drag the consensus close off — both silently distort `computeClvPercent` / the beat-the-close record.

- **Abstain semantics differ between the two jobs.** `clv.ts` never expires a bet — on missing/degraded feed it just leaves `closingOdds` null (retry next cycle). `model-clv.ts` marks a trade `expired` only once past `commenceTime + 3h` (give-up window); before that it leaves it `open`. Neither ever writes a partial/bogus CLV.

- **Consensus needs ≥2 books.** `closingConsensusForLine` returns null when `side.books.size < 2`, so a thin/one-book feed → abstain, not a fabricated close.
