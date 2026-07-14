import type { PaperTrade } from "@workspace/api-client-react";
import { easternDayKey } from "./utils";

// Pure aggregation helpers behind the Model Performance scorecard. These are the
// numbers users read to decide whether the model beats the market, so they live
// here (framework-free) to be unit-tested in isolation from the React/recharts
// rendering in ModelPerformance.tsx.

// Newer trades persist the model's actual flag decision (`isFlagged`) at log
// time, so the flagged-vs-unflagged split is exact. Rows logged before that
// column existed have no stored decision, so we fall back to re-deriving it:
// a line was "flagged" when it had a market consensus (marketProb present) and
// cleared the same edge threshold the scanner uses to flag lines.
export const FLAG_EDGE_PERCENT = 1;

// A pitcher/opponent needs at least this many graded trades before its avg CLV
// is trustworthy enough to rank. Below this, one or two lucky closes can top the
// leaderboard on noise alone, so low-sample groups are split out of the ranking.
export const MIN_GRADED_SAMPLE = 5;

export function isFlaggedTrade(t: PaperTrade): boolean {
  if (t.isFlagged != null) return t.isFlagged;
  return t.marketProb != null && t.edgePercent != null && t.edgePercent >= FLAG_EDGE_PERCENT;
}

/** Trades that have a captured closing line (CLV computed) — the gradable set. */
export function isGraded(t: PaperTrade): boolean {
  return t.clvPercent != null;
}

export function mean(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

export function beatCloseRate(trades: PaperTrade[]): number | null {
  if (trades.length === 0) return null;
  return trades.filter((t) => t.beatClose === true).length / trades.length;
}

export type BreakdownRow = {
  key: string;
  count: number;
  beatClose: number | null;
  avgClv: number | null;
};

/**
 * Group graded trades by an arbitrary key (pitcher / opponent) and summarize
 * each group. Ordered by avg CLV descending so the model's strongest reads
 * surface first; groups with no measurable CLV sink to the bottom.
 */
export function buildBreakdown(
  trades: PaperTrade[],
  keyOf: (t: PaperTrade) => string,
): BreakdownRow[] {
  const groups = new Map<string, PaperTrade[]>();
  for (const t of trades) {
    const k = keyOf(t);
    const arr = groups.get(k);
    if (arr) arr.push(t);
    else groups.set(k, [t]);
  }
  return Array.from(groups.entries())
    .map(([key, rows]) => ({
      key,
      count: rows.length,
      beatClose: beatCloseRate(rows),
      avgClv: mean(rows.map((t) => t.clvPercent ?? 0)),
    }))
    .sort((a, b) => {
      const av = a.avgClv ?? Number.NEGATIVE_INFINITY;
      const bv = b.avgClv ?? Number.NEGATIVE_INFINITY;
      if (bv !== av) return bv - av;
      return b.count - a.count;
    });
}

export const EDGE_BUCKETS: {
  key: string;
  label: string;
  test: (edge: number | null) => boolean;
}[] = [
  { key: "none", label: "<1%", test: (e) => e == null || e < 1 },
  { key: "low", label: "1–3%", test: (e) => e != null && e >= 1 && e < 3 },
  { key: "mid", label: "3–5%", test: (e) => e != null && e >= 3 && e < 5 },
  { key: "high", label: "5%+", test: (e) => e != null && e >= 5 },
];

export type BucketRow = {
  label: string;
  count: number;
  rate: number;
  hasData: boolean;
  lowSample: boolean;
};

/**
 * Beat-close rate per edge bucket over the graded set. `rate` is a whole
 * percent (0 when the bucket is empty); `lowSample` flags buckets whose rate
 * rests on too few trades to trust so a single lucky close can't read as proof.
 */
export function computeBucketSeries(graded: PaperTrade[]): BucketRow[] {
  return EDGE_BUCKETS.map((b) => {
    const inBucket = graded.filter((t) => b.test(t.edgePercent));
    const rate = beatCloseRate(inBucket);
    return {
      label: b.label,
      count: inBucket.length,
      rate: rate == null ? 0 : Math.round(rate * 100),
      hasData: inBucket.length > 0,
      lowSample: inBucket.length > 0 && inBucket.length < MIN_GRADED_SAMPLE,
    };
  });
}

export type SplitSummary = {
  count: number;
  beatClose: number | null;
  avgClv: number | null;
  avgEdge: number | null;
};

/** Summarize a set of graded trades (used per flagged/unflagged side). */
export function summarizeTrades(rows: PaperTrade[]): SplitSummary {
  return {
    count: rows.length,
    beatClose: beatCloseRate(rows),
    avgClv: mean(rows.map((t) => t.clvPercent ?? 0)),
    avgEdge: mean(rows.filter((t) => t.edgePercent != null).map((t) => t.edgePercent as number)),
  };
}

/** Split the graded set into the model's flagged picks vs the rest. */
export function computeFlaggedSplit(graded: PaperTrade[]): {
  flagged: SplitSummary;
  unflagged: SplitSummary;
} {
  return {
    flagged: summarizeTrades(graded.filter(isFlaggedTrade)),
    unflagged: summarizeTrades(graded.filter((t) => !isFlaggedTrade(t))),
  };
}

export type Headline = {
  total: number;
  graded: number;
  beatClose: number | null;
  avgClv: number | null;
  avgEdge: number | null;
};

/**
 * The headline scorecard. Beat-close rate and avg CLV summarize only the graded
 * set (open trades have no closing line yet), while trade count and avg edge
 * span the full filtered view.
 */
export function computeHeadline(filtered: PaperTrade[], graded: PaperTrade[]): Headline {
  return {
    total: filtered.length,
    graded: graded.length,
    beatClose: beatCloseRate(graded),
    avgClv: mean(graded.map((t) => t.clvPercent ?? 0)),
    avgEdge: mean(filtered.filter((t) => t.edgePercent != null).map((t) => t.edgePercent as number)),
  };
}

export type TradeFilters = {
  // Eastern-day lower/upper bounds as YYYY-MM-DD strings ("" = unbounded).
  from: string;
  to: string;
  // Pitcher name, or "all" for no pitcher filter.
  pitcher: string;
  // "Over" / "Under", or "all" for no side filter.
  selection: string;
};

/**
 * Filter the trades feeding every card and chart. A trade is kept when it
 * matches the chosen pitcher and side and falls within the from/to bounds. The
 * date bounds are compared on the trade's US Eastern calendar day (so a
 * late-night game lands on the correct baseball date) and are inclusive at both
 * ends. Empty-string bounds and "all" selectors are treated as no filter.
 */
export function filterTrades(trades: PaperTrade[], filters: TradeFilters): PaperTrade[] {
  return trades.filter((t) => {
    if (filters.pitcher !== "all" && t.pitcher !== filters.pitcher) return false;
    if (filters.selection !== "all" && t.selection !== filters.selection) return false;
    const day = easternDayKey(String(t.commenceTime));
    if (filters.from && day < filters.from) return false;
    if (filters.to && day > filters.to) return false;
    return true;
  });
}

export type ClvPoint = {
  idx: number;
  label: string;
  clv: number;
  cumAvg: number;
  pitcher: string;
};

/**
 * The "CLV Over Time" series: for each graded trade (expected in chronological
 * order of first pitch), the individual trade CLV and the running/cumulative
 * average CLV up to and including that trade. An empty graded set yields an
 * empty series so the chart never plots a NaN point. Values are rounded to two
 * decimals to match the chart's display; a missing clvPercent counts as 0.
 */
export function computeClvSeries(graded: PaperTrade[]): ClvPoint[] {
  let sum = 0;
  return graded.map((t, i) => {
    sum += t.clvPercent ?? 0;
    const d = new Date(t.commenceTime);
    return {
      idx: i,
      label: Number.isNaN(d.getTime())
        ? ""
        : d.toLocaleDateString([], { month: "short", day: "numeric" }),
      clv: Math.round((t.clvPercent ?? 0) * 100) / 100,
      cumAvg: Math.round((sum / (i + 1)) * 100) / 100,
      pitcher: t.pitcher,
    };
  });
}
