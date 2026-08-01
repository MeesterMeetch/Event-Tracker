import { describe, it, expect } from "vitest";
import {
  bfDistributionFromSamples,
  compoundKPmf,
  binomialPmf,
  betaBinomialPmf,
  lineProbabilitiesFromPmf,
  pmfMean,
  pmfVariance,
  discretizedNormalBf,
  DEFAULT_CONCENTRATION,
} from "./k-distribution";

/**
 * The point of this module is that a fixed-n binomial understates the variance
 * of a start's strikeout total. These tests assert that directly rather than
 * pinning exact numbers, so the constants stay tunable.
 */

const BF_SAMPLES = [18, 21, 24, 25, 27, 22, 26, 19, 24, 28];
const PROJ_BF = 24;
const RATE = 0.25;

function compound() {
  const bf = bfDistributionFromSamples(BF_SAMPLES, PROJ_BF, 12, 30);
  return compoundKPmf({ bf, perTrialProb: RATE, concentration: DEFAULT_CONCENTRATION });
}

describe("compound strikeout distribution", () => {
  it("has more variance than a fixed-n binomial", () => {
    expect(pmfVariance(compound())).toBeGreaterThan(pmfVariance(binomialPmf(PROJ_BF, RATE)));
  });

  it("inflates variance materially, not trivially", () => {
    const ratio = pmfVariance(compound()) / pmfVariance(binomialPmf(PROJ_BF, RATE));
    expect(ratio).toBeGreaterThan(1.15);
  });

  it("preserves the mean exactly, so widening variance never moves the projection", () => {
    // Regression guard: rounding each recentered sample instead of splitting
    // its mass biased this upward by ~0.4 batters faced.
    expect(pmfMean(compound())).toBeCloseTo(PROJ_BF * RATE, 6);
  });

  it("is a proper distribution", () => {
    expect(compound().reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it("puts more mass in both tails than the binomial", () => {
    const c = compound();
    const b = binomialPmf(PROJ_BF, RATE);
    const highC = c.slice(11).reduce((a, v) => a + v, 0);
    const highB = b.slice(11).reduce((a, v) => a + v, 0);
    const lowC = c.slice(0, 3).reduce((a, v) => a + v, 0);
    const lowB = b.slice(0, 3).reduce((a, v) => a + v, 0);
    expect(highC).toBeGreaterThan(highB);
    expect(lowC).toBeGreaterThan(lowB);
  });

  it("reduces to a plain binomial with fixed volume and no overdispersion", () => {
    const pmf = compoundKPmf({
      bf: { outcomes: [PROJ_BF], weights: [1] },
      perTrialProb: RATE,
      concentration: null,
    });
    const plain = binomialPmf(PROJ_BF, RATE);
    pmf.forEach((v, i) => expect(v).toBeCloseTo(plain[i], 12));
  });
});

describe("betaBinomialPmf", () => {
  it("converges to the binomial as concentration grows", () => {
    const bb = betaBinomialPmf(PROJ_BF, RATE, 1e9);
    const plain = binomialPmf(PROJ_BF, RATE);
    bb.forEach((v, i) => expect(v).toBeCloseTo(plain[i], 4));
  });

  it("is more dispersed than the binomial at finite concentration", () => {
    expect(pmfVariance(betaBinomialPmf(PROJ_BF, RATE, 50))).toBeGreaterThan(
      pmfVariance(binomialPmf(PROJ_BF, RATE)),
    );
  });
});

describe("bfDistributionFromSamples", () => {
  it("recenters the sample onto the projected workload", () => {
    const bf = bfDistributionFromSamples(BF_SAMPLES, 20, 12, 30);
    const mean = bf.outcomes.reduce((a, o, i) => a + o * bf.weights[i], 0);
    expect(mean).toBeCloseTo(20, 6);
  });

  it("falls back to a normal shape when starts are too few", () => {
    const bf = bfDistributionFromSamples([24], 24, 12, 30);
    expect(bf.outcomes.length).toBeGreaterThan(1);
    expect(bf.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it("respects the workload clamp", () => {
    const bf = bfDistributionFromSamples([5, 40, 45], 24, 12, 30);
    expect(Math.min(...bf.outcomes)).toBeGreaterThanOrEqual(12);
    expect(Math.max(...bf.outcomes)).toBeLessThanOrEqual(30);
  });
});

describe("discretizedNormalBf", () => {
  it("produces normalized weights", () => {
    const bf = discretizedNormalBf(24, 4, 12, 30);
    expect(bf.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });
});

describe("lineProbabilitiesFromPmf", () => {
  it("cannot push on a half-point line", () => {
    const lp = lineProbabilitiesFromPmf(compound(), 5.5);
    expect(lp.pPush).toBe(0);
    expect(lp.pOver + lp.pUnder).toBeCloseTo(1, 9);
  });

  it("carries push mass on an integer line", () => {
    const lp = lineProbabilitiesFromPmf(compound(), 6);
    expect(lp.pPush).toBeGreaterThan(0);
    expect(lp.pOver + lp.pUnder + lp.pPush).toBeCloseTo(1, 9);
  });

  it("renormalizes conditional probabilities over resolving outcomes", () => {
    const lp = lineProbabilitiesFromPmf(compound(), 6);
    expect(lp.condOver + lp.condUnder).toBeCloseTo(1, 9);
  });
});
