import { describe, it, expect } from "vitest";
import { compareScans, decayReport, edgeKeyOf, type EdgeSnapshot } from "./edge-decay";

function snap(
  selection: string,
  book: string,
  americanOdds: number,
  evPercent: number,
  overrides: Partial<EdgeSnapshot> = {},
): EdgeSnapshot {
  return {
    gameId: "g1",
    market: "totals",
    selection,
    point: 8.5,
    player: null,
    book,
    americanOdds,
    evPercent,
    ...overrides,
  };
}

describe("edgeKeyOf", () => {
  it("treats the same side at the same book as one identity", () => {
    expect(edgeKeyOf(snap("Over", "DK", -110, 3))).toBe(edgeKeyOf(snap("Over", "DK", 150, 9)));
  });

  it("separates different books", () => {
    expect(edgeKeyOf(snap("Over", "DK", -110, 3))).not.toBe(edgeKeyOf(snap("Over", "FD", -110, 3)));
  });

  it("separates different points on the same market", () => {
    expect(edgeKeyOf(snap("Over", "DK", -110, 3))).not.toBe(
      edgeKeyOf(snap("Over", "DK", -110, 3, { point: 9.5 })),
    );
  });
});

describe("compareScans", () => {
  it("marks a quote that disappeared as vanished", () => {
    const result = compareScans([snap("Over", "DK", 120, 4)], []);
    expect(result[0].fate).toBe("vanished");
    expect(result[0].after).toBeNull();
    expect(result[0].evDelta).toBeNull();
  });

  it("marks an unchanged price as persisted", () => {
    const result = compareScans([snap("Over", "DK", 120, 4)], [snap("Over", "DK", 120, 4)]);
    expect(result[0].fate).toBe("persisted");
    expect(result[0].evDelta).toBeCloseTo(0, 9);
  });

  it("marks a price that moved against the bettor as worsened", () => {
    const result = compareScans([snap("Over", "DK", 120, 4)], [snap("Over", "DK", 105, 1.2)]);
    expect(result[0].fate).toBe("worsened");
    expect(result[0].evDelta).toBeLessThan(0);
  });

  it("marks a price that moved toward the bettor as improved", () => {
    const result = compareScans([snap("Over", "DK", 120, 4)], [snap("Over", "DK", 135, 6.5)]);
    expect(result[0].fate).toBe("improved");
    expect(result[0].priceDelta).toBe(15);
  });
});

describe("decayReport", () => {
  /** Small edges hold, big edges evaporate: the stale-quote signature. */
  function staleTailSample() {
    const before: EdgeSnapshot[] = [];
    const after: EdgeSnapshot[] = [];
    for (let i = 0; i < 20; i++) {
      const s = snap("Over", "BookA", -105, 2.5, { gameId: `small${i}` });
      before.push(s);
      after.push(s);
    }
    for (let i = 0; i < 20; i++) {
      before.push(snap("Under", "BookB", 250, 12, { gameId: `big${i}` }));
      // none re-appear
    }
    return compareScans(before, after);
  }

  it("computes an overall survival rate", () => {
    const report = decayReport(staleTailSample());
    expect(report.totalEdges).toBe(40);
    expect(report.vanished).toBe(20);
    expect(report.overallSurvivalRate).toBeCloseTo(0.5, 6);
  });

  it("flags that large edges survive worse than small ones", () => {
    const report = decayReport(staleTailSample());
    expect(report.interpretation).toMatch(/survive markedly worse|latency artifact/i);
  });

  it("ranks the worst book first", () => {
    const report = decayReport(staleTailSample());
    expect(report.byBook[0].book).toBe("BookB");
    expect(report.byBook[0].vanishRate).toBeCloseTo(1, 6);
  });

  it("buckets by edge size", () => {
    const report = decayReport(staleTailSample());
    expect(report.byEvBucket.length).toBeGreaterThanOrEqual(2);
    const largest = report.byEvBucket[report.byEvBucket.length - 1];
    expect(largest.survivalRate).toBeLessThan(report.byEvBucket[0].survivalRate);
  });

  it("reports healthy persistence when prices hold", () => {
    const rows: EdgeSnapshot[] = Array.from({ length: 30 }, (_, i) =>
      snap("Over", "BookA", -105, 3, { gameId: `g${i}` }),
    );
    const report = decayReport(compareScans(rows, rows));
    expect(report.overallSurvivalRate).toBeCloseTo(1, 6);
    expect(report.interpretation).toMatch(/Most flagged edges were still there/i);
  });

  it("refuses to conclude on a small sample", () => {
    const rows = [snap("Over", "DK", 120, 4)];
    expect(decayReport(compareScans(rows, [])).interpretation).toMatch(/Fewer than 20/i);
  });

  it("handles an empty sample", () => {
    const report = decayReport([]);
    expect(report.totalEdges).toBe(0);
    expect(report.interpretation).toMatch(/nothing to measure/i);
  });
});
