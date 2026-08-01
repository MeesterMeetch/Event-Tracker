import { describe, it, expect } from "vitest";
import { tailBiasReport, resolvedTrades, isTailSide, lineGap, type GradedTrade } from "./model-diagnostics";

function trade(
  point: number,
  expectedStrikeouts: number,
  selection: "Over" | "Under",
  outcome: string,
  modelProb = 0.6,
  clvPercent: number | null = 1,
): GradedTrade {
  return {
    selection,
    point,
    expectedStrikeouts,
    modelProb,
    marketProb: 0.5,
    edgePercent: 3,
    clvPercent,
    beatClose: clvPercent == null ? null : clvPercent > 0,
    outcome,
    isFlagged: true,
  };
}

/** Near lines priced correctly, distant lines badly: the tail-bias signature. */
function biasedSample(): GradedTrade[] {
  const trades: GradedTrade[] = [];
  for (let i = 0; i < 40; i++) trades.push(trade(6.5, 6.4, "Over", i < 24 ? "won" : "lost", 0.6));
  for (let i = 0; i < 40; i++) trades.push(trade(9.5, 6.4, "Under", i < 12 ? "won" : "lost", 0.62, -1.5));
  return trades;
}

describe("resolvedTrades", () => {
  it("excludes pushes and voids", () => {
    const trades = [trade(6, 6, "Over", "won"), trade(6, 6, "Over", "push"), trade(6, 6, "Over", "void")];
    expect(resolvedTrades(trades)).toHaveLength(1);
  });
});

describe("lineGap", () => {
  it("measures absolute distance from the projection", () => {
    expect(lineGap(trade(9.5, 6.5, "Over", "won"))).toBeCloseTo(3, 9);
    expect(lineGap(trade(4.5, 6.5, "Over", "won"))).toBeCloseTo(2, 9);
  });
});

describe("isTailSide", () => {
  it("treats an over above the projection as the tail side", () => {
    expect(isTailSide(trade(9.5, 6.4, "Over", "won"))).toBe(true);
  });

  it("treats an under above the projection as the inside", () => {
    expect(isTailSide(trade(9.5, 6.4, "Under", "won"))).toBe(false);
  });

  it("treats an under below the projection as the tail side", () => {
    expect(isTailSide(trade(3.5, 6.4, "Under", "won"))).toBe(true);
  });
});

describe("tailBiasReport", () => {
  it("detects decay in accuracy as the line moves from the projection", () => {
    const report = tailBiasReport(biasedSample());
    expect(report.spread).not.toBeNull();
    expect(report.spread as number).toBeLessThan(-0.08);
    expect(report.interpretation).toMatch(/tail bias/i);
  });

  it("reports a negative calibration gap in the distant bucket", () => {
    const report = tailBiasReport(biasedSample());
    const distant = report.buckets[report.buckets.length - 1];
    expect(distant.calibrationGap).toBeLessThan(0);
  });

  it("refuses to conclude on a small sample", () => {
    const report = tailBiasReport(biasedSample().slice(0, 10));
    expect(report.interpretation).toMatch(/not enough/i);
  });

  it("handles an empty sample without throwing", () => {
    const report = tailBiasReport([]);
    expect(report.gradedCount).toBe(0);
    expect(report.buckets).toHaveLength(0);
  });
});
