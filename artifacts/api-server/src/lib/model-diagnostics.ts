/**
 * Diagnostics for the strikeout model, run against graded paper trades.
 * Pure math, no I/O — rows are loaded elsewhere and passed in.
 *
 * The headline test here is for tail bias. A fixed-n binomial understates the
 * variance of a start's strikeout total, which compresses the tails of the
 * predicted distribution. The practical consequence is that the further a
 * posted line sits from the model's projection, the more the model overstates
 * its edge on whichever side faces the tail. If that is happening, win rate and
 * closing-line value should both decay as the line-to-projection gap widens.
 *
 * This is deliberately a measurement, not a fix: it tells you whether the
 * variance correction in k-distribution.ts is solving a real problem in your
 * own data, and by how much.
 */

export interface GradedTrade {
  selection: "Over" | "Under";
  point: number;
  expectedStrikeouts: number;
  modelProb: number;
  marketProb: number | null;
  edgePercent: number | null;
  clvPercent: number | null;
  beatClose: boolean | null;
  /** "won" | "lost" | "push" | "void" | null */
  outcome: string | null;
  isFlagged: boolean | null;
}

export interface GapBucket {
  label: string;
  lowerGap: number;
  upperGap: number;
  count: number;
  wins: number;
  losses: number;
  winRate: number;
  /** Mean model probability in the bucket, i.e. what the model expected to win. */
  meanModelProb: number;
  /** winRate minus meanModelProb. Negative means the model overstated itself. */
  calibrationGap: number;
  avgClvPercent: number | null;
  beatCloseRate: number | null;
  /** How many of these bets took the side facing the far tail of the distribution. */
  tailSideCount: number;
}

export interface TailBiasReport {
  gradedCount: number;
  buckets: GapBucket[];
  /**
   * Difference in calibration gap between the widest and narrowest buckets.
   * Strongly negative is the signature of tail bias.
   */
  spread: number | null;
  interpretation: string;
}

const DEFAULT_EDGES = [0, 0.5, 1, 2, Infinity];

/** Trades that actually resolved. Pushes and voids carry no calibration signal. */
export function resolvedTrades(trades: GradedTrade[]): GradedTrade[] {
  return trades.filter((t) => t.outcome === "won" || t.outcome === "lost");
}

/**
 * Absolute distance between the posted line and the model's projection, in
 * strikeouts. This is the axis along which understated variance does its damage.
 */
export function lineGap(trade: GradedTrade): number {
  return Math.abs(trade.point - trade.expectedStrikeouts);
}

/**
 * True when the bet takes the side facing the far tail: an Over on a line above
 * the projection, or an Under on a line below it. These are exactly the bets a
 * variance-compressed model will under-price, so it will rarely flag them, and
 * their absence is itself evidence of the bias.
 */
export function isTailSide(trade: GradedTrade): boolean {
  if (trade.point > trade.expectedStrikeouts) return trade.selection === "Over";
  if (trade.point < trade.expectedStrikeouts) return trade.selection === "Under";
  return false;
}

function mean(values: number[]): number | null {
  const usable = values.filter((v) => Number.isFinite(v));
  if (usable.length === 0) return null;
  return usable.reduce((a, b) => a + b, 0) / usable.length;
}

export function tailBiasReport(trades: GradedTrade[], edges: number[] = DEFAULT_EDGES): TailBiasReport {
  const resolved = resolvedTrades(trades);
  const buckets: GapBucket[] = [];

  for (let i = 0; i < edges.length - 1; i++) {
    const lowerGap = edges[i];
    const upperGap = edges[i + 1];
    const inBucket = resolved.filter((t) => {
      const gap = lineGap(t);
      return gap >= lowerGap && (upperGap === Infinity ? true : gap < upperGap);
    });
    if (inBucket.length === 0) continue;

    const wins = inBucket.filter((t) => t.outcome === "won").length;
    const losses = inBucket.length - wins;
    const winRate = wins / inBucket.length;
    const meanModelProb = inBucket.reduce((a, t) => a + t.modelProb, 0) / inBucket.length;
    const clvValues = inBucket.map((t) => t.clvPercent).filter((v): v is number => v != null);
    const closeKnown = inBucket.filter((t) => t.beatClose != null);

    buckets.push({
      label: upperGap === Infinity ? `${lowerGap}+ K` : `${lowerGap} to ${upperGap} K`,
      lowerGap,
      upperGap,
      count: inBucket.length,
      wins,
      losses,
      winRate,
      meanModelProb,
      calibrationGap: winRate - meanModelProb,
      avgClvPercent: mean(clvValues),
      beatCloseRate:
        closeKnown.length > 0
          ? closeKnown.filter((t) => t.beatClose === true).length / closeKnown.length
          : null,
      tailSideCount: inBucket.filter(isTailSide).length,
    });
  }

  let spread: number | null = null;
  if (buckets.length >= 2) {
    spread = buckets[buckets.length - 1].calibrationGap - buckets[0].calibrationGap;
  }

  return {
    gradedCount: resolved.length,
    buckets,
    spread,
    interpretation: interpret(resolved.length, spread),
  };
}

function interpret(gradedCount: number, spread: number | null): string {
  if (gradedCount < 30) {
    return "Not enough graded trades to read this yet. Treat anything below about 30 as noise, and closer to 100 before acting on it.";
  }
  if (spread == null) return "Not enough populated buckets to compare.";
  if (spread <= -0.08) {
    return "Consistent with tail bias: the model overstates itself more as the line moves away from the projection. The variance correction should help here.";
  }
  if (spread >= 0.08) {
    return "The model does better on distant lines than nearby ones, which is the opposite of the tail-bias signature. Look for another explanation before changing the distribution.";
  }
  return "No clear tail bias at this sample size. The variance correction is still theoretically right, but it is not obviously costing you money yet.";
}
