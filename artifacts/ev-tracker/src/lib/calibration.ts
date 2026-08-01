import type { PaperTrade } from "@workspace/api-client-react";

// Pure calibration helpers behind the Model Performance calibration view.
// These answer the question CLV can't: when the model said 60%, did the bet
// actually win about 60% of the time? Framework-free so they can be
// unit-tested apart from the recharts rendering, matching model-performance.ts.

/**
 * Trades usable for calibration: settled to a binary result with a recorded
 * model probability. Pushes and voids carry no calibration information (the
 * binomial's push mass is conditioned out of modelProb), so they're excluded.
 */
export function isCalibratable(t: PaperTrade): boolean {
  return (t.outcome === "won" || t.outcome === "lost") && t.modelProb != null;
}

/**
 * Brier score: mean squared error between the model probability and the 0/1
 * result. Lower is better; 0.25 is what always guessing 50% scores, so
 * anything at or above that means the probabilities carry no information.
 */
export function brierScore(trades: PaperTrade[]): number | null {
  const usable = trades.filter(isCalibratable);
  if (usable.length === 0) return null;
  const sum = usable.reduce((s, t) => {
    const y = t.outcome === "won" ? 1 : 0;
    return s + (t.modelProb! - y) ** 2;
  }, 0);
  return sum / usable.length;
}

export type CalibrationBucket = {
  /** Inclusive lower edge of the bucket, e.g. 0.5 for the 50 to 60 bucket. */
  lo: number;
  /** Exclusive upper edge (inclusive for the final bucket). */
  hi: number;
  count: number;
  /** Mean model probability of trades in the bucket (x on a reliability plot). */
  predicted: number;
  /** Fraction of those trades that actually won (y on a reliability plot). */
  actual: number;
};

/**
 * Groups settled trades into equal-width probability buckets for a
 * reliability curve. A well-calibrated model puts every bucket near the
 * diagonal: predicted 0.55 should see roughly 55% winners. Empty buckets are
 * omitted; low-count buckets should be rendered with that count visible so
 * noise isn't mistaken for miscalibration.
 */
export function calibrationBuckets(trades: PaperTrade[], bucketWidth = 0.1): CalibrationBucket[] {
  const usable = trades.filter(isCalibratable);
  const nBuckets = Math.max(1, Math.round(1 / bucketWidth));
  const groups: PaperTrade[][] = Array.from({ length: nBuckets }, () => []);

  for (const t of usable) {
    const idx = Math.min(nBuckets - 1, Math.floor(t.modelProb! / bucketWidth));
    groups[idx].push(t);
  }

  return groups
    .map((rows, i) => {
      if (rows.length === 0) return null;
      const predicted = rows.reduce((s, t) => s + t.modelProb!, 0) / rows.length;
      const actual = rows.filter((t) => t.outcome === "won").length / rows.length;
      return {
        lo: i * bucketWidth,
        hi: i === nBuckets - 1 ? 1 : (i + 1) * bucketWidth,
        count: rows.length,
        predicted,
        actual,
      };
    })
    .filter((b): b is CalibrationBucket => b !== null);
}

/**
 * Hypothetical flat-stake ROI of the settled flagged trades, in units per
 * unit staked. Pushes and voids return the stake (contribute zero). This is
 * the "would the model have made money" number, distinct from beat-close.
 */
export function settledRoi(trades: PaperTrade[]): number | null {
  const settled = trades.filter((t) => t.outcome === "won" || t.outcome === "lost");
  if (settled.length === 0) return null;
  const pnl = settled.reduce((s, t) => {
    if (t.outcome === "lost") return s - 1;
    const odds = t.americanOdds;
    return s + (odds > 0 ? odds / 100 : 100 / -odds);
  }, 0);
  return pnl / settled.length;
}
