import { describe, expect, it } from "vitest";
import type { PaperTrade } from "@workspace/api-client-react";
import {
  MIN_GRADED_SAMPLE,
  beatCloseRate,
  buildBreakdown,
  computeBucketSeries,
  computeClvSeries,
  computeFlaggedSplit,
  computeHeadline,
  deriveGradedSet,
  filterTrades,
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

const ALL: Parameters<typeof filterTrades>[1] = {
  from: "",
  to: "",
  pitcher: "all",
  selection: "all",
};

describe("filterTrades", () => {
  it("returns every trade when no filter is set", () => {
    const rows = [trade(), trade(), trade()];
    expect(filterTrades(rows, ALL)).toHaveLength(3);
  });

  it("selects only the chosen side and leaves 'all' untouched", () => {
    const rows = [
      trade({ selection: "Over" }),
      trade({ selection: "Under" }),
      trade({ selection: "Over" }),
    ];
    expect(filterTrades(rows, { ...ALL, selection: "Over" }).map((t) => t.selection)).toEqual([
      "Over",
      "Over",
    ]);
    expect(filterTrades(rows, { ...ALL, selection: "Under" }).map((t) => t.selection)).toEqual([
      "Under",
    ]);
    expect(filterTrades(rows, { ...ALL, selection: "all" })).toHaveLength(3);
  });

  it("filters by pitcher, leaving 'all' untouched", () => {
    const rows = [trade({ pitcher: "A" }), trade({ pitcher: "B" }), trade({ pitcher: "A" })];
    expect(filterTrades(rows, { ...ALL, pitcher: "A" }).map((t) => t.pitcher)).toEqual(["A", "A"]);
    expect(filterTrades(rows, { ...ALL, pitcher: "all" })).toHaveLength(3);
  });

  it("filters on the Eastern calendar day, not the UTC day", () => {
    // 2026-07-15T01:30:00Z is still July 14 in US Eastern (UTC-4 in summer),
    // so a filter pinned to the 14th must keep it and a filter on the 15th drop it.
    const lateNight = trade({ commenceTime: "2026-07-15T01:30:00Z" });
    expect(filterTrades([lateNight], { ...ALL, from: "2026-07-14", to: "2026-07-14" })).toHaveLength(
      1,
    );
    expect(filterTrades([lateNight], { ...ALL, from: "2026-07-15", to: "2026-07-15" })).toHaveLength(
      0,
    );
  });

  it("treats the from bound as inclusive at the lower edge", () => {
    const rows = [
      trade({ commenceTime: "2026-07-13T18:00:00Z" }), // Jul 13 ET
      trade({ commenceTime: "2026-07-14T18:00:00Z" }), // Jul 14 ET
      trade({ commenceTime: "2026-07-15T18:00:00Z" }), // Jul 15 ET
    ];
    const kept = filterTrades(rows, { ...ALL, from: "2026-07-14" });
    expect(kept.map((t) => easternDayKeyOf(t))).toEqual(["2026-07-14", "2026-07-15"]);
  });

  it("treats the to bound as inclusive at the upper edge", () => {
    const rows = [
      trade({ commenceTime: "2026-07-13T18:00:00Z" }),
      trade({ commenceTime: "2026-07-14T18:00:00Z" }),
      trade({ commenceTime: "2026-07-15T18:00:00Z" }),
    ];
    const kept = filterTrades(rows, { ...ALL, to: "2026-07-14" });
    expect(kept.map((t) => easternDayKeyOf(t))).toEqual(["2026-07-13", "2026-07-14"]);
  });

  it("keeps only the days inside an inclusive from/to window", () => {
    const rows = [
      trade({ commenceTime: "2026-07-13T18:00:00Z" }),
      trade({ commenceTime: "2026-07-14T18:00:00Z" }),
      trade({ commenceTime: "2026-07-15T18:00:00Z" }),
      trade({ commenceTime: "2026-07-16T18:00:00Z" }),
    ];
    const kept = filterTrades(rows, { ...ALL, from: "2026-07-14", to: "2026-07-15" });
    expect(kept.map((t) => easternDayKeyOf(t))).toEqual(["2026-07-14", "2026-07-15"]);
  });

  it("combines pitcher, side, and date filters", () => {
    const rows = [
      trade({ pitcher: "A", selection: "Over", commenceTime: "2026-07-14T18:00:00Z" }), // match
      trade({ pitcher: "A", selection: "Under", commenceTime: "2026-07-14T18:00:00Z" }), // wrong side
      trade({ pitcher: "B", selection: "Over", commenceTime: "2026-07-14T18:00:00Z" }), // wrong pitcher
      trade({ pitcher: "A", selection: "Over", commenceTime: "2026-07-20T18:00:00Z" }), // out of range
    ];
    const kept = filterTrades(rows, {
      from: "2026-07-14",
      to: "2026-07-14",
      pitcher: "A",
      selection: "Over",
    });
    expect(kept).toHaveLength(1);
    expect(kept[0].commenceTime).toBe("2026-07-14T18:00:00Z");
  });
});

function easternDayKeyOf(t: PaperTrade): string {
  return new Date(t.commenceTime).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

describe("deriveGradedSet", () => {
  it("keeps only graded trades (captured closing line)", () => {
    const rows = [
      trade({ id: 1, clvPercent: null }), // open — dropped
      graded({ id: 2, clvPercent: 1.5 }),
      trade({ id: 3, clvPercent: null }), // open — dropped
      graded({ id: 4, clvPercent: -0.5 }),
    ];
    expect(deriveGradedSet(rows).map((t) => t.id)).toEqual([2, 4]);
  });

  it("sorts ascending by commence time so the CLV line runs in first-pitch order", () => {
    const rows = [
      graded({ id: 1, commenceTime: "2026-07-16T18:00:00Z" }),
      graded({ id: 2, commenceTime: "2026-07-14T18:00:00Z" }),
      graded({ id: 3, commenceTime: "2026-07-15T18:00:00Z" }),
    ];
    expect(deriveGradedSet(rows).map((t) => t.id)).toEqual([2, 3, 1]);
  });

  it("compares by instant, not by string, so mixed timezone offsets order correctly", () => {
    const rows = [
      // Lexicographically first but chronologically last.
      graded({ id: 1, commenceTime: "2026-07-14T23:05:00-04:00" }), // 03:05Z on the 15th
      graded({ id: 2, commenceTime: "2026-07-14T23:05:00Z" }),
    ];
    expect(deriveGradedSet(rows).map((t) => t.id)).toEqual([2, 1]);
  });

  it("keeps ties and already-sorted input in stable (input) order", () => {
    const sameTime = "2026-07-14T18:00:00Z";
    const tied = [
      graded({ id: 1, commenceTime: sameTime }),
      graded({ id: 2, commenceTime: sameTime }),
      graded({ id: 3, commenceTime: sameTime }),
    ];
    expect(deriveGradedSet(tied).map((t) => t.id)).toEqual([1, 2, 3]);

    const sorted = [
      graded({ id: 1, commenceTime: "2026-07-13T18:00:00Z" }),
      graded({ id: 2, commenceTime: "2026-07-14T18:00:00Z" }),
      graded({ id: 3, commenceTime: "2026-07-15T18:00:00Z" }),
    ];
    expect(deriveGradedSet(sorted).map((t) => t.id)).toEqual([1, 2, 3]);
  });

  it("pushes unparseable commence times to the end without disturbing good rows", () => {
    const rows = [
      graded({ id: 1, commenceTime: "not-a-date" }),
      graded({ id: 2, commenceTime: "2026-07-15T18:00:00Z" }),
      graded({ id: 3, commenceTime: "" }),
      graded({ id: 4, commenceTime: "2026-07-14T18:00:00Z" }),
    ];
    // Good rows sort chronologically first; the two bad rows land at the end
    // in their original relative order — deterministic, no throw.
    expect(deriveGradedSet(rows).map((t) => t.id)).toEqual([4, 2, 1, 3]);
  });

  it("does not mutate the input array", () => {
    const rows = [
      graded({ id: 1, commenceTime: "2026-07-16T18:00:00Z" }),
      graded({ id: 2, commenceTime: "2026-07-14T18:00:00Z" }),
    ];
    deriveGradedSet(rows);
    expect(rows.map((t) => t.id)).toEqual([1, 2]);
  });

  it("returns an empty set for no trades or no graded trades", () => {
    expect(deriveGradedSet([])).toEqual([]);
    expect(deriveGradedSet([trade(), trade()])).toEqual([]);
  });
});

describe("computeClvSeries", () => {
  it("returns an empty series (no NaN points) for an empty graded set", () => {
    expect(computeClvSeries([])).toEqual([]);
  });

  it("is a true running mean of CLV in the given order", () => {
    const series = computeClvSeries([
      graded({ clvPercent: 2 }),
      graded({ clvPercent: 4 }),
      graded({ clvPercent: 0 }),
      graded({ clvPercent: -2 }),
    ]);
    // Each cumAvg is the mean of all CLVs up to and including that point.
    expect(series.map((p) => p.cumAvg)).toEqual([2, 3, 2, 1]);
    // Each point also carries its own trade CLV.
    expect(series.map((p) => p.clv)).toEqual([2, 4, 0, -2]);
    expect(series.map((p) => p.idx)).toEqual([0, 1, 2, 3]);
  });

  it("tracks the cumulative average as chronologically-sorted trades accrue", () => {
    const rows = deriveGradedSet([
      graded({ commenceTime: "2026-07-16T18:00:00Z", clvPercent: 6 }),
      graded({ commenceTime: "2026-07-14T18:00:00Z", clvPercent: 2 }),
      graded({ commenceTime: "2026-07-15T18:00:00Z", clvPercent: 4 }),
    ]);
    const series = computeClvSeries(rows);
    expect(series.map((p) => p.clv)).toEqual([2, 4, 6]);
    expect(series.map((p) => p.cumAvg)).toEqual([2, 3, 4]);
  });

  it("counts a missing CLV as 0 rather than emitting NaN", () => {
    const series = computeClvSeries([graded({ clvPercent: null }), graded({ clvPercent: 4 })]);
    expect(series[0].clv).toBe(0);
    expect(series[0].cumAvg).toBe(0);
    expect(series[1].cumAvg).toBe(2); // (0 + 4) / 2
    for (const p of series) {
      expect(Number.isNaN(p.clv)).toBe(false);
      expect(Number.isNaN(p.cumAvg)).toBe(false);
    }
  });

  it("rounds both trade CLV and cumulative average to two decimals", () => {
    const series = computeClvSeries([graded({ clvPercent: 1 }), graded({ clvPercent: 2 })]);
    // (1 + 2) / 2 = 1.5 exactly; a third point would surface rounding.
    const three = computeClvSeries([
      graded({ clvPercent: 1 }),
      graded({ clvPercent: 1 }),
      graded({ clvPercent: 2 }),
    ]);
    expect(series[1].cumAvg).toBe(1.5);
    expect(three[2].cumAvg).toBe(1.33); // 4/3 = 1.333… → 1.33
  });

  it("emits an empty label for an unparseable commence time instead of throwing", () => {
    const series = computeClvSeries([graded({ commenceTime: "not-a-date", clvPercent: 3 })]);
    expect(series[0].label).toBe("");
    expect(series[0].clv).toBe(3);
  });
});
