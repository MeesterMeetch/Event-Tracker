---
name: CLV closing-line capture jobs
description: Gotchas in the game-line (clv.ts) and paper-trade (model-clv.ts) closing-line capture jobs.
---

# CLV closing-line capture

- **Game-line closer averages RAW American odds, not decimals/probs.** `findClosingOdds` in `clv.ts` does `mean(price)` directly over American numbers (e.g. -110 and +120 → 5). This is mathematically wrong for odds (American isn't linear); it distorts `computeClvPercent`. The pitcher-K closer (`model-clv.ts` → `closingConsensusForLine`) does it correctly (trimmed mean in decimal space). Tests assert the *current* averaging behavior — if you fix the game-line math, update `clv.test.ts` expectations too.
  **Why:** a bad CLV number silently inflates/deflates the model's beat-the-close record; the two jobs disagree on method.

- **Abstain semantics differ between the two jobs.** `clv.ts` never expires a bet — on missing/degraded feed it just leaves `closingOdds` null (retry next cycle). `model-clv.ts` marks a trade `expired` only once past `commenceTime + 3h` (give-up window); before that it leaves it `open`. Neither ever writes a partial/bogus CLV.

- **Consensus needs ≥2 books.** `closingConsensusForLine` returns null when `side.books.size < 2`, so a thin/one-book feed → abstain, not a fabricated close.
