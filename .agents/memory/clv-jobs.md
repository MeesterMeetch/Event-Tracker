---
name: CLV closing-line capture jobs
description: Gotchas in the game-line (clv.ts) and paper-trade (model-clv.ts) closing-line capture jobs.
---

# CLV closing-line capture

- **Both closers now average in decimal space.** `findClosingOdds` in `clv.ts` converts each book's American price to decimal, means them, and converts back (`decimalToAmerican`), matching the pitcher-K closer's approach. (Game-line closer does NOT trim high/low like `closingConsensusForLine` — it's a plain decimal mean.) `clv.test.ts` expectations track this corrected math (e.g. -110 & +120 → +105, not the old raw mean of 5).
  **Why:** raw-American averaging (e.g. -110 & +120 → 5) is mathematically wrong since American odds aren't linear, and silently distorted `computeClvPercent` / the model's beat-the-close record.

- **Abstain semantics differ between the two jobs.** `clv.ts` never expires a bet — on missing/degraded feed it just leaves `closingOdds` null (retry next cycle). `model-clv.ts` marks a trade `expired` only once past `commenceTime + 3h` (give-up window); before that it leaves it `open`. Neither ever writes a partial/bogus CLV.

- **Consensus needs ≥2 books.** `closingConsensusForLine` returns null when `side.books.size < 2`, so a thin/one-book feed → abstain, not a fabricated close.
