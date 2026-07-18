import { describe, expect, it } from "vitest";
import type { PaperTrade } from "@workspace/api-client-react";
import { brierScore, calibrationBuckets, settledRoi } from "./calibration";

function trade(overrides: Partial<PaperTrade>): PaperTrade {
  return {
    id: 1,
    sport: "baseball_mlb",
    gameId: "g1",
    commenceTime: "2026-07-01T23:10:00Z",
    homeTeam: "Colorado Rockies",
    awayTeam: "San Francisco Giants",
    pitcher: "Logan Webb",
    pitcherId: 657277,
    team: "San Francisco Giants",
    opponent: "Colorado Rockies",
    selection: "Over",
    point: 5.5,
    book: "fanduel",
    americanOdds: -110,
    modelProb: 0.6,
    expectedStrikeouts: 6.2,
    projectedBattersFaced: 25,
    recommendedUnits: 0.5,
    kellyMultiplier: 0.25,
    status: "closed",
    ...overrides,
  } as PaperTrade;
}

describe("brierScore", () => {
  it("returns null with no settled trades", () => {
    expect(brierScore([trade({ outcome: null as never })])).toBeNull();
  });

  it("scores a perfect confident call as near zero", () => {
    const t = [trade({ modelProb: 0.99, outcome: "won" })];
    expect(brierScore(t)!).toBeCloseTo(0.0001, 4);
  });

  it("scores coin-flip probabilities at 0.25 regardless of results", () => {
    const t = [trade({ modelProb: 0.5, outcome: "won" }), trade({ modelProb: 0.5, outcome: "lost" })];
    expect(brierScore(t)!).toBeCloseTo(0.25, 6);
  });

  it("excludes pushes and voids", () => {
    const t = [
      trade({ modelProb: 0.6, outcome: "won" }),
      trade({ modelProb: 0.9, outcome: "push" }),
      trade({ modelProb: 0.9, outcome: "void" }),
    ];
    expect(brierScore(t)!).toBeCloseTo(0.16, 6);
  });
});

describe("calibrationBuckets", () => {
  it("places trades in the right buckets and computes hit rate", () => {
    const t = [
      trade({ modelProb: 0.55, outcome: "won" }),
      trade({ modelProb: 0.58, outcome: "lost" }),
      trade({ modelProb: 0.62, outcome: "won" }),
    ];
    const buckets = calibrationBuckets(t, 0.1);
    expect(buckets).toHaveLength(2);
    const fifties = buckets.find((b) => b.lo === 0.5)!;
    expect(fifties.count).toBe(2);
    expect(fifties.actual).toBeCloseTo(0.5);
    expect(fifties.predicted).toBeCloseTo(0.565);
  });

  it("clamps probability 1.0 into the top bucket", () => {
    const buckets = calibrationBuckets([trade({ modelProb: 1, outcome: "won" })], 0.1);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].lo).toBeCloseTo(0.9);
    expect(buckets[0].hi).toBe(1);
  });

  it("omits empty buckets", () => {
    const buckets = calibrationBuckets([trade({ modelProb: 0.31, outcome: "won" })], 0.1);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].lo).toBeCloseTo(0.3);
  });
});

describe("settledRoi", () => {
  it("returns null with nothing settled", () => {
    expect(settledRoi([trade({ outcome: "void" })])).toBeNull();
  });

  it("computes flat-stake ROI across wins and losses", () => {
    const t = [
      trade({ americanOdds: -110, outcome: "won" }), // +0.9091
      trade({ americanOdds: 120, outcome: "lost" }), // -1
      trade({ americanOdds: 150, outcome: "won" }), // +1.5
    ];
    expect(settledRoi(t)!).toBeCloseTo((0.9091 - 1 + 1.5) / 3, 3);
  });

  it("ignores pushes in both pnl and denominator", () => {
    const t = [trade({ americanOdds: -110, outcome: "won" }), trade({ outcome: "push" })];
    expect(settledRoi(t)!).toBeCloseTo(0.9091, 3);
  });
});
