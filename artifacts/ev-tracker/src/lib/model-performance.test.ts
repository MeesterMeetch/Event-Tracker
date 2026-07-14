import { describe, expect, it } from "vitest";
import type { PaperTrade } from "@workspace/api-client-react";
import {
  MIN_GRADED_SAMPLE,
  beatCloseRate,
  buildBreakdown,
  computeBucketSeries,
  computeFlaggedSplit,
  computeHeadline,
  isFlaggedTrade,
  isGraded,
  mean,
} from "./model-performance";

/**
 * These are the numbers the EV Tracker headline uses to claim the model beats
 * the market. They're a separate, client-side re-implementation of the math the
 * API suite already locks down, so a silent regression here would show a wrong
 * "beats the market" headline even while the backend is correct. These tests
 * pin the beat-close rate, mean CLV, edge bucketing, and flagged/graded
 * filtering — especially the empty/ungraded cases that must render "—" rather
 * than a bogus 0% or NaN.
 */

// Minimal PaperTrade factory: only the fields the aggregation reads matter, the
// rest are filled with inert placeholders.
function trade(overrides: Partial<PaperTrade> = {}): PaperTrade {
  return {
    id: 1,
    sport: "baseball_mlb",
    gameId: "g1",
    commenceTime: "2026-07-14T23:05:00Z",
    homeTeam: "Home",
    awayTeam: "Away",
    pitcher: "Pitcher A",
    pitcherId: null,
    team: "Home",
    opponent: "Away",
    selection: "Over",
    point: 5.5,
    book: "book1",
    americanOdds: -110,
    modelProb: 0.55,
    marketProb: 0.5,
    edgePercent: 2,
    isFlagged: null,
    expectedStrikeouts: 6,
    projectedBattersFaced: 24,
    recommendedUnits: 1,
    kellyMultiplier: 0.25,
    closingOdds: null,
    closingProb: null,
    clvPercent: null,
    beatClose: null,
    status: "open",
    createdAt: "2026-07-14T12:00:00Z",
    ...overrides,
  };
}

/** A graded trade: has a captured closing line (clvPercent set). */
function graded(overrides: Partial<PaperTrade> = {}): PaperTrade {
  return trade({ clvPercent: 1, beatClose: true, ...overrides });
}

describe("mean", () => {
  it("returns null for an empty list rather than NaN", () => {
    expect(mean([])).toBeNull();
  });

  it("averages the values", () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([-4, 4])).toBe(0);
    expect(mean([2.5])).toBe(2.5);
  });
});

describe("beatCloseRate", () => {
  it("returns null for an empty set (so the UI shows — not 0%)", () => {
    expect(beatCloseRate([])).toBeNull();
  });

  it("counts only beatClose === true as a win", () => {
    const trades = [
      graded({ beatClose: true }),
      graded({ beatClose: false }),
      graded({ beatClose: true }),
      graded({ beatClose: null }),
    ];
    expect(beatCloseRate(trades)).toBe(0.5); // 2 of 4
  });

  it("is 0 when nothing beat the close (distinct from null/no data)", () => {
    expect(beatCloseRate([graded({ beatClose: false }), graded({ beatClose: null })])).toBe(0);
  });

  it("is 1 when every trade beat the close", () => {
    expect(beatCloseRate([graded({ beatClose: true }), graded({ beatClose: true })])).toBe(1);
  });
});

describe("isGraded", () => {
  it("treats a captured closing line (clvPercent present) as graded", () => {
    expect(isGraded(trade({ clvPercent: 0 }))).toBe(true);
    expect(isGraded(trade({ clvPercent: -2.3 }))).toBe(true);
  });

  it("treats an open trade with no closing line as ungraded", () => {
    expect(isGraded(trade({ clvPercent: null }))).toBe(false);
  });
});

describe("isFlaggedTrade", () => {
  it("trusts the persisted decision when present", () => {
    expect(isFlaggedTrade(trade({ isFlagged: true, edgePercent: 0 }))).toBe(true);
    expect(isFlaggedTrade(trade({ isFlagged: false, edgePercent: 99, marketProb: 0.5 }))).toBe(
      false,
    );
  });

  it("re-derives from edge threshold for legacy rows without a stored decision", () => {
    // At/over the flag threshold with a market consensus → flagged.
    expect(isFlaggedTrade(trade({ isFlagged: null, marketProb: 0.5, edgePercent: 1 }))).toBe(true);
    expect(isFlaggedTrade(trade({ isFlagged: null, marketProb: 0.5, edgePercent: 4 }))).toBe(true);
    // Below the threshold → not flagged.
    expect(isFlaggedTrade(trade({ isFlagged: null, marketProb: 0.5, edgePercent: 0.9 }))).toBe(
      false,
    );
  });

  it("cannot be flagged without a market consensus, even at a high edge", () => {
    expect(isFlaggedTrade(trade({ isFlagged: null, marketProb: null, edgePercent: 10 }))).toBe(
      false,
    );
    expect(isFlaggedTrade(trade({ isFlagged: null, marketProb: 0.5, edgePercent: null }))).toBe(
      false,
    );
  });
});

describe("computeHeadline", () => {
  it("renders empty (nulls, not NaN/0%) when there are no trades at all", () => {
    const h = computeHeadline([], []);
    expect(h).toEqual({ total: 0, graded: 0, beatClose: null, avgClv: null, avgEdge: null });
  });

  it("shows an all-open list as ungraded so beat-close/CLV stay null (— not 0%)", () => {
    // Three logged trades, none graded yet.
    const filtered = [trade(), trade(), trade({ edgePercent: 4 })];
    const gradedSet = filtered.filter(isGraded); // empty
    const h = computeHeadline(filtered, gradedSet);
    expect(h.total).toBe(3);
    expect(h.graded).toBe(0);
    expect(h.beatClose).toBeNull();
    expect(h.avgClv).toBeNull();
    // Avg edge spans the full filtered view even before anything is graded.
    expect(h.avgEdge).toBeCloseTo((2 + 2 + 4) / 3, 10);
  });

  it("summarizes beat-close and CLV over the graded set only", () => {
    const filtered = [
      graded({ clvPercent: 2, beatClose: true, edgePercent: 3 }),
      graded({ clvPercent: -1, beatClose: false, edgePercent: 1 }),
      trade({ clvPercent: null, edgePercent: 5 }), // open, excluded from graded
    ];
    const gradedSet = filtered.filter(isGraded);
    const h = computeHeadline(filtered, gradedSet);
    expect(h.total).toBe(3);
    expect(h.graded).toBe(2);
    expect(h.beatClose).toBe(0.5);
    expect(h.avgClv).toBeCloseTo((2 + -1) / 2, 10);
    // Avg edge uses the full filtered view (includes the open trade's edge).
    expect(h.avgEdge).toBeCloseTo((3 + 1 + 5) / 3, 10);
  });

  it("ignores null edges when averaging edge", () => {
    const filtered = [trade({ edgePercent: 4 }), trade({ edgePercent: null })];
    const h = computeHeadline(filtered, []);
    expect(h.avgEdge).toBe(4);
  });
});

describe("computeBucketSeries", () => {
  it("returns all four buckets empty (rate 0, no data) for an empty graded set", () => {
    const series = computeBucketSeries([]);
    expect(series.map((b) => b.label)).toEqual(["<1%", "1–3%", "3–5%", "5%+"]);
    for (const b of series) {
      expect(b.count).toBe(0);
      expect(b.rate).toBe(0);
      expect(b.hasData).toBe(false);
      expect(b.lowSample).toBe(false);
    }
  });

  it("bins trades by edge and computes a whole-percent beat-close rate per bucket", () => {
    const gradedSet = [
      graded({ edgePercent: null, beatClose: true }), // <1% (null edge)
      graded({ edgePercent: 0.5, beatClose: false }), // <1%
      graded({ edgePercent: 1, beatClose: true }), // 1–3%
      graded({ edgePercent: 2.9, beatClose: false }), // 1–3%
      graded({ edgePercent: 3, beatClose: true }), // 3–5%
      graded({ edgePercent: 5, beatClose: true }), // 5%+
    ];
    const byLabel = Object.fromEntries(computeBucketSeries(gradedSet).map((b) => [b.label, b]));
    expect(byLabel["<1%"].count).toBe(2);
    expect(byLabel["<1%"].rate).toBe(50);
    expect(byLabel["1–3%"].count).toBe(2);
    expect(byLabel["1–3%"].rate).toBe(50);
    expect(byLabel["3–5%"].count).toBe(1);
    expect(byLabel["3–5%"].rate).toBe(100);
    expect(byLabel["5%+"].count).toBe(1);
    expect(byLabel["5%+"].rate).toBe(100);
  });

  it("flags a bucket as low-sample below the trust threshold but not at/above it", () => {
    const few = Array.from({ length: MIN_GRADED_SAMPLE - 1 }, () =>
      graded({ edgePercent: 2, beatClose: true }),
    );
    expect(computeBucketSeries(few).find((b) => b.label === "1–3%")?.lowSample).toBe(true);

    const enough = Array.from({ length: MIN_GRADED_SAMPLE }, () =>
      graded({ edgePercent: 2, beatClose: true }),
    );
    expect(computeBucketSeries(enough).find((b) => b.label === "1–3%")?.lowSample).toBe(false);
  });
});

describe("computeFlaggedSplit", () => {
  it("returns null summaries (not 0%) for both sides when there are no graded trades", () => {
    const { flagged, unflagged } = computeFlaggedSplit([]);
    for (const side of [flagged, unflagged]) {
      expect(side.count).toBe(0);
      expect(side.beatClose).toBeNull();
      expect(side.avgClv).toBeNull();
      expect(side.avgEdge).toBeNull();
    }
  });

  it("splits graded trades into the model's flagged picks vs the rest", () => {
    const gradedSet = [
      graded({ isFlagged: true, clvPercent: 3, beatClose: true, edgePercent: 4 }),
      graded({ isFlagged: true, clvPercent: 1, beatClose: false, edgePercent: 2 }),
      graded({ isFlagged: false, clvPercent: -2, beatClose: false, edgePercent: 0 }),
    ];
    const { flagged, unflagged } = computeFlaggedSplit(gradedSet);
    expect(flagged.count).toBe(2);
    expect(flagged.beatClose).toBe(0.5);
    expect(flagged.avgClv).toBeCloseTo((3 + 1) / 2, 10);
    expect(flagged.avgEdge).toBeCloseTo((4 + 2) / 2, 10);

    expect(unflagged.count).toBe(1);
    expect(unflagged.beatClose).toBe(0);
    expect(unflagged.avgClv).toBe(-2);
    expect(unflagged.avgEdge).toBe(0);
  });

  it("uses the derived flag for legacy rows without a stored decision", () => {
    const gradedSet = [
      // Legacy row over the threshold with a consensus → flagged.
      graded({ isFlagged: null, marketProb: 0.5, edgePercent: 2, clvPercent: 1, beatClose: true }),
      // Legacy row under the threshold → unflagged.
      graded({
        isFlagged: null,
        marketProb: 0.5,
        edgePercent: 0.5,
        clvPercent: -1,
        beatClose: false,
      }),
    ];
    const { flagged, unflagged } = computeFlaggedSplit(gradedSet);
    expect(flagged.count).toBe(1);
    expect(unflagged.count).toBe(1);
  });
});

describe("buildBreakdown", () => {
  it("groups graded trades by key and summarizes each group", () => {
    const gradedSet = [
      graded({ pitcher: "A", clvPercent: 2, beatClose: true }),
      graded({ pitcher: "A", clvPercent: 4, beatClose: false }),
      graded({ pitcher: "B", clvPercent: 1, beatClose: true }),
    ];
    const rows = buildBreakdown(gradedSet, (t) => t.pitcher);
    const a = rows.find((r) => r.key === "A")!;
    const b = rows.find((r) => r.key === "B")!;
    expect(a.count).toBe(2);
    expect(a.avgClv).toBeCloseTo(3, 10);
    expect(a.beatClose).toBe(0.5);
    expect(b.count).toBe(1);
    expect(b.avgClv).toBe(1);
    expect(b.beatClose).toBe(1);
  });

  it("ranks by avg CLV descending, breaking ties by count", () => {
    const gradedSet = [
      graded({ pitcher: "Low", clvPercent: 0 }),
      graded({ pitcher: "High", clvPercent: 5 }),
      graded({ pitcher: "Mid", clvPercent: 2 }),
      graded({ pitcher: "Mid", clvPercent: 2 }),
    ];
    const rows = buildBreakdown(gradedSet, (t) => t.pitcher);
    expect(rows.map((r) => r.key)).toEqual(["High", "Mid", "Low"]);
  });

  it("returns an empty list when there are no trades", () => {
    expect(buildBreakdown([], (t) => t.pitcher)).toEqual([]);
  });
});
