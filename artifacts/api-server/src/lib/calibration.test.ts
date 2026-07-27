import { describe, it, expect } from "vitest";
import {
  brierScore,
  logLoss,
  reliabilityBuckets,
  calibrationReport,
  fitPlatt,
  applyPlatt,
  type Prediction,
} from "./calibration";

/** An overconfident model: claims 70 percent, wins 55. */
function overconfident(): Prediction[] {
  return Array.from({ length: 1000 }, (_, i) => ({ prob: 0.7, won: i < 550 }));
}

describe("scoring rules", () => {
  it("scores perfect predictions at zero Brier", () => {
    expect(brierScore([{ prob: 1, won: true }, { prob: 0, won: false }])).toBeCloseTo(0, 9);
  });

  it("punishes confident mistakes in log loss", () => {
    const confidentWrong = logLoss([{ prob: 0.99, won: false }]);
    const unsureWrong = logLoss([{ prob: 0.55, won: false }]);
    expect(confidentWrong).toBeGreaterThan(unsureWrong);
  });
});

describe("reliabilityBuckets", () => {
  it("reports a negative gap for an overconfident model", () => {
    const buckets = reliabilityBuckets(overconfident());
    expect(buckets).toHaveLength(1);
    expect(buckets[0].gap).toBeLessThan(0);
  });

  it("drops empty buckets rather than emitting NaN rows", () => {
    expect(reliabilityBuckets([{ prob: 0.5, won: true }])).toHaveLength(1);
  });
});

describe("calibrationReport", () => {
  it("surfaces the gap between predicted and actual", () => {
    const report = calibrationReport(overconfident());
    expect(report.meanPredicted).toBeCloseTo(0.7, 6);
    expect(report.actualRate).toBeCloseTo(0.55, 6);
    expect(report.actualRate).toBeLessThan(report.meanPredicted);
  });
});

describe("fitPlatt", () => {
  it("maps an overconfident probability back onto its realized rate", () => {
    const platt = fitPlatt(overconfident());
    expect(applyPlatt(0.7, platt)).toBeCloseTo(0.55, 2);
  });

  it("reports a slope below 1 when the model is overconfident", () => {
    expect(fitPlatt(overconfident()).a).toBeLessThan(1);
  });

  it("leaves a calibrated model close to the identity", () => {
    const predictions: Prediction[] = [];
    for (let i = 0; i < 2000; i++) {
      const prob = i % 2 === 0 ? 0.6 : 0.4;
      predictions.push({ prob, won: i % 2 === 0 ? i % 10 < 6 : i % 10 < 4 });
    }
    const platt = fitPlatt(predictions);
    expect(applyPlatt(0.6, platt)).toBeCloseTo(0.6, 1);
  });

  it("degrades gracefully on a sample too small to fit", () => {
    expect(fitPlatt([])).toEqual({ a: 1, b: 0 });
  });
});
