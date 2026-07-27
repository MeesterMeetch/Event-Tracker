import { describe, it, expect } from "vitest";
import { blendProbabilities, fitBlendWeight, type BlendSample } from "./model-blend";

describe("blendProbabilities", () => {
  it("returns the model at weight 1", () => {
    expect(blendProbabilities(0.62, 0.55, 1)).toBeCloseTo(0.62, 9);
  });

  it("returns the market at weight 0", () => {
    expect(blendProbabilities(0.62, 0.55, 0)).toBeCloseTo(0.55, 9);
  });

  it("falls back to the model when no market price exists", () => {
    expect(blendProbabilities(0.62, null, 0.5)).toBeCloseTo(0.62, 9);
  });

  it("lands between the two inputs", () => {
    const mid = blendProbabilities(0.62, 0.55, 0.5);
    expect(mid).toBeGreaterThan(0.55);
    expect(mid).toBeLessThan(0.62);
  });

  it("clamps an out-of-range weight", () => {
    expect(blendProbabilities(0.62, 0.55, 5)).toBeCloseTo(0.62, 9);
    expect(blendProbabilities(0.62, 0.55, -5)).toBeCloseTo(0.55, 9);
  });
});

describe("fitBlendWeight", () => {
  it("puts low weight on a noisy model when the market is accurate", () => {
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const samples: BlendSample[] = [];
    for (let i = 0; i < 3000; i++) {
      const truth = 0.45 + rnd() * 0.2;
      samples.push({
        marketProb: truth,
        modelProb: Math.min(0.97, Math.max(0.03, truth + (rnd() - 0.5) * 0.5)),
        won: rnd() < truth,
      });
    }
    const fit = fitBlendWeight(samples);
    expect(fit.weight).toBeLessThan(0.4);
    expect(fit.logLoss).toBeLessThanOrEqual(fit.marketOnlyLogLoss + 1e-9);
  });

  it("reports an empty fit when there is nothing to fit on", () => {
    const fit = fitBlendWeight([]);
    expect(fit.sampleSize).toBe(0);
    expect(fit.weight).toBe(1);
  });
});
