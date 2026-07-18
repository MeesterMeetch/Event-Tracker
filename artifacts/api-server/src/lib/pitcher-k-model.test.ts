import { describe, expect, it } from "vitest";
import {
  projectPitcherK,
  binomialPmf,
  lineProbabilities,
  kellyFraction,
  recommendedKellyUnits,
  DEFAULT_KELLY_MULTIPLIER,
  MAX_RECOMMENDED_UNITS,
  type PitcherKInputs,
  type OpponentKInputs,
} from "./pitcher-k-model";

/**
 * Guards the pure projection engine that drives every model probability, edge %,
 * and recommended Kelly stake. A silent regression in the rate regression, the
 * binomial distribution, the push-adjusted over/under, or the Kelly cap would
 * corrupt every projection without failing anything, so pin the math down with
 * concrete, hand-computed expectations.
 */

const LEAGUE_K_PER_PA = 0.22;

function pitcher(overrides: Partial<PitcherKInputs>): PitcherKInputs {
  return {
    throws: "R",
    rollingStrikeouts: 0,
    rollingBattersFaced: 0,
    rollingStarts: 0,
    rollingBfPerStart: null,
    rollingInningsPitched: null,
    seasonStrikeouts: null,
    seasonBattersFaced: null,
    seasonGamesStarted: null,
    careerStrikeouts: null,
    careerBattersFaced: null,
    ...overrides,
  };
}

describe("projectPitcherK — rate regression", () => {
  it("falls back to the league rate with no career/season/rolling data", () => {
    const proj = projectPitcherK(pitcher({}), null);
    // careerRate = LEAGUE_K_PER_PA, baseline = career, projRate = baseline.
    expect(proj.baseRatePerBF).toBeCloseTo(LEAGUE_K_PER_PA, 10);
    expect(proj.ratePerBF).toBeCloseTo(LEAGUE_K_PER_PA, 10);
    expect(proj.opponentFactor).toBe(1);
  });

  it("uses the raw career rate when only career data exists", () => {
    // careerRate = 1000 / 4000 = 0.25
    const proj = projectPitcherK(
      pitcher({ careerStrikeouts: 1000, careerBattersFaced: 4000 }),
      null,
    );
    expect(proj.baseRatePerBF).toBeCloseTo(0.25, 10);
    expect(proj.ratePerBF).toBeCloseTo(0.25, 10);
  });

  it("regresses the season rate toward the career rate (CAREER_PRIOR_BF = 200)", () => {
    // careerRate = 800 / 4000 = 0.20
    // baseline = (200 + 200*0.20) / (800 + 200) = 240 / 1000 = 0.24
    const proj = projectPitcherK(
      pitcher({
        careerStrikeouts: 800,
        careerBattersFaced: 4000,
        seasonStrikeouts: 200,
        seasonBattersFaced: 800,
      }),
      null,
    );
    expect(proj.baseRatePerBF).toBeCloseTo(0.24, 10);
  });

  it("regresses the rolling rate toward the season+career baseline (FORM_PRIOR_BF = 150)", () => {
    // baseline (from prior test) = 0.24
    // projRate = (60 + 150*0.24) / (200 + 150) = 96 / 350 = 0.2742857...
    const proj = projectPitcherK(
      pitcher({
        careerStrikeouts: 800,
        careerBattersFaced: 4000,
        seasonStrikeouts: 200,
        seasonBattersFaced: 800,
        rollingStrikeouts: 60,
        rollingBattersFaced: 200,
        rollingStarts: 8,
      }),
      null,
    );
    expect(proj.baseRatePerBF).toBeCloseTo(96 / 350, 10);
  });

  it("clamps the final rate above MAX_RATE (0.55)", () => {
    // careerRate = 0.60 -> projRate 0.60 -> clamped to 0.55
    const proj = projectPitcherK(
      pitcher({ careerStrikeouts: 2400, careerBattersFaced: 4000 }),
      null,
    );
    expect(proj.baseRatePerBF).toBeCloseTo(0.6, 10);
    expect(proj.ratePerBF).toBeCloseTo(0.55, 10);
  });

  it("clamps the final rate below MIN_RATE (0.03)", () => {
    // careerRate = 10 / 4000 = 0.0025 -> clamped to 0.03
    const proj = projectPitcherK(
      pitcher({ careerStrikeouts: 10, careerBattersFaced: 4000 }),
      null,
    );
    expect(proj.baseRatePerBF).toBeCloseTo(0.0025, 10);
    expect(proj.ratePerBF).toBeCloseTo(0.03, 10);
  });
});

describe("projectPitcherK — opponent factor", () => {
  const base = pitcher({ careerStrikeouts: 1000, careerBattersFaced: 4000 }); // rate 0.25

  it("selects the RHP column for a right-hander and clamps to OPP_FACTOR_MAX (1.2)", () => {
    const opp: OpponentKInputs = { kPctVsLhp: 0.1, kPctVsRhp: 0.28 };
    // 0.28 / 0.22 = 1.2727 -> clamped to 1.2
    const proj = projectPitcherK({ ...base, throws: "R" }, opp);
    expect(proj.opponentFactor).toBeCloseTo(1.2, 10);
    expect(proj.ratePerBF).toBeCloseTo(0.25 * 1.2, 10);
  });

  it("selects the LHP column for a left-hander and clamps to OPP_FACTOR_MIN (0.85)", () => {
    const opp: OpponentKInputs = { kPctVsLhp: 0.11, kPctVsRhp: 0.4 };
    // 0.11 / 0.22 = 0.5 -> clamped to 0.85
    const proj = projectPitcherK({ ...base, throws: "L" }, opp);
    expect(proj.opponentFactor).toBeCloseTo(0.85, 10);
    expect(proj.ratePerBF).toBeCloseTo(0.25 * 0.85, 10);
  });

  it("leaves the factor inside the band untouched", () => {
    const opp: OpponentKInputs = { kPctVsLhp: null, kPctVsRhp: 0.242 };
    // 0.242 / 0.22 = 1.1 -> within [0.85, 1.2]
    const proj = projectPitcherK({ ...base, throws: "R" }, opp);
    expect(proj.opponentFactor).toBeCloseTo(1.1, 10);
  });

  it("keeps factor at 1 when the relevant column is null or non-positive", () => {
    const proj = projectPitcherK(
      { ...base, throws: "R" },
      { kPctVsLhp: 0.28, kPctVsRhp: null },
    );
    expect(proj.opponentFactor).toBe(1);
  });
});

describe("projectPitcherK — projected batters faced (volume)", () => {
  it("blends recent (0.6) and season (0.4) BF-per-start when both exist", () => {
    // seasonBfPerStart = 700 / 28 = 25; recent = 26
    // projBF = 0.6*26 + 0.4*25 = 25.6
    const proj = projectPitcherK(
      pitcher({
        rollingBfPerStart: 26,
        seasonBattersFaced: 700,
        seasonGamesStarted: 28,
        careerStrikeouts: 1000,
        careerBattersFaced: 4000,
      }),
      null,
    );
    expect(proj.projectedBattersFaced).toBeCloseTo(25.6, 10);
  });

  it("clamps projected BF up to MIN_PROJ_BF (12)", () => {
    const proj = projectPitcherK(pitcher({ rollingBfPerStart: 8 }), null);
    expect(proj.projectedBattersFaced).toBe(12);
  });

  it("clamps projected BF down to MAX_PROJ_BF (30)", () => {
    const proj = projectPitcherK(pitcher({ rollingBfPerStart: 40 }), null);
    expect(proj.projectedBattersFaced).toBe(30);
  });

  it("falls back to LEAGUE_BF_PER_START (24) with no per-start data", () => {
    const proj = projectPitcherK(pitcher({}), null);
    expect(proj.projectedBattersFaced).toBe(24);
  });

  it("derives binomial params keeping the mean exact (expectedK = rate * BF)", () => {
    // rate 0.25, BF fallback 24 -> expectedK = 6, trials = 24, p = 6/24 = 0.25
    const proj = projectPitcherK(
      pitcher({ careerStrikeouts: 1000, careerBattersFaced: 4000 }),
      null,
    );
    expect(proj.expectedStrikeouts).toBeCloseTo(6, 10);
    expect(proj.trials).toBe(24);
    expect(proj.perTrialProb).toBeCloseTo(0.25, 10);
    expect(proj.expectedStrikeouts).toBeCloseTo(proj.trials * proj.perTrialProb, 10);
  });
});

describe("binomialPmf", () => {
  it("returns a degenerate mass at 0 when p <= 0", () => {
    expect(binomialPmf(3, 0)).toEqual([1, 0, 0, 0]);
    expect(binomialPmf(3, -0.5)).toEqual([1, 0, 0, 0]);
  });

  it("returns a degenerate mass at n when p >= 1", () => {
    expect(binomialPmf(3, 1)).toEqual([0, 0, 0, 1]);
    expect(binomialPmf(3, 1.5)).toEqual([0, 0, 0, 1]);
  });

  it("matches the hand-computed pmf for n=2, p=0.5", () => {
    const pmf = binomialPmf(2, 0.5);
    expect(pmf[0]).toBeCloseTo(0.25, 10);
    expect(pmf[1]).toBeCloseTo(0.5, 10);
    expect(pmf[2]).toBeCloseTo(0.25, 10);
  });

  it("matches the hand-computed pmf for n=1, p=0.3", () => {
    const pmf = binomialPmf(1, 0.3);
    expect(pmf[0]).toBeCloseTo(0.7, 10);
    expect(pmf[1]).toBeCloseTo(0.3, 10);
  });

  it("produces a normalized distribution (sums to 1)", () => {
    const pmf = binomialPmf(24, 0.25);
    const total = pmf.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
    expect(pmf).toHaveLength(25);
  });
});

describe("lineProbabilities — integer (push) vs half-point lines", () => {
  it("half-point line cannot push and conditional == raw over/under", () => {
    // n=2, p=0.5, point 0.5 -> floor 0 -> pUnder = pmf[0] = 0.25, pOver = 0.75
    const lp = lineProbabilities(2, 0.5, 0.5);
    expect(lp.pPush).toBe(0);
    expect(lp.pUnder).toBeCloseTo(0.25, 10);
    expect(lp.pOver).toBeCloseTo(0.75, 10);
    // no push -> denom is 1 -> conditional equals raw
    expect(lp.condUnder).toBeCloseTo(0.25, 10);
    expect(lp.condOver).toBeCloseTo(0.75, 10);
  });

  it("integer line carries push mass and push-adjusts the conditional probs", () => {
    // n=2, p=0.5, point 1 -> pPush = pmf[1] = 0.5, pUnder = pmf[0] = 0.25,
    // pOver = 1 - 0.25 - 0.5 = 0.25; conditional normalizes over the resolving sides.
    const lp = lineProbabilities(2, 0.5, 1);
    expect(lp.pPush).toBeCloseTo(0.5, 10);
    expect(lp.pUnder).toBeCloseTo(0.25, 10);
    expect(lp.pOver).toBeCloseTo(0.25, 10);
    expect(lp.condOver).toBeCloseTo(0.5, 10);
    expect(lp.condUnder).toBeCloseTo(0.5, 10);
    expect(lp.condOver + lp.condUnder).toBeCloseTo(1, 10);
  });

  it("raw probabilities across the two half-points around an integer sum to 1 with the push", () => {
    const below = lineProbabilities(2, 0.5, 0.5); // pUnder 0.25
    const above = lineProbabilities(2, 0.5, 1.5); // pUnder 0.75
    // the difference is exactly the push mass at k = 1
    expect(above.pUnder - below.pUnder).toBeCloseTo(0.5, 10);
  });

  it("handles a zero line (no under mass possible)", () => {
    // point 0 integer -> pUnder = 0, pPush = pmf[0]
    const lp = lineProbabilities(2, 0.5, 0);
    expect(lp.pUnder).toBe(0);
    expect(lp.pPush).toBeCloseTo(0.25, 10);
    expect(lp.pOver).toBeCloseTo(0.75, 10);
  });
});

describe("kellyFraction", () => {
  it("returns 0 for non-positive edges (never stake a negative-EV bet)", () => {
    // winProb 0.4 at even-money decimal 2.0 -> f = (0.8 - 1)/1 < 0
    expect(kellyFraction(0.4, 2.0)).toBe(0);
  });

  it("returns 0 for break-even bets", () => {
    // winProb 0.5 at 2.0 -> f = 0
    expect(kellyFraction(0.5, 2.0)).toBe(0);
  });

  it("returns 0 when odds imply no payout (decimalOdds <= 1)", () => {
    expect(kellyFraction(0.9, 1.0)).toBe(0);
    expect(kellyFraction(0.9, 0.5)).toBe(0);
  });

  it("matches the Kelly formula for a positive edge", () => {
    // winProb 0.6 at 2.0 -> b=1 -> f = (1.2 - 1)/1 = 0.2
    expect(kellyFraction(0.6, 2.0)).toBeCloseTo(0.2, 10);
    // winProb 0.55 at 2.0 -> f = 0.1
    expect(kellyFraction(0.55, 2.0)).toBeCloseTo(0.1, 10);
  });
});

describe("recommendedKellyUnits", () => {
  it("returns 0 on a negative-EV bet", () => {
    expect(recommendedKellyUnits(0.4, 2.0)).toBe(0);
  });

  it("applies the default (quarter) Kelly multiplier and rounds to 2 decimals", () => {
    // full = 0.1, units = 0.1 * 0.25 * 100 = 2.5
    expect(DEFAULT_KELLY_MULTIPLIER).toBe(0.25);
    expect(recommendedKellyUnits(0.55, 2.0)).toBeCloseTo(2.5, 10);
  });

  it("caps the recommended stake at MAX_RECOMMENDED_UNITS", () => {
    // full = 0.2, units = 0.2 * 0.25 * 100 = 5 -> capped to 3
    expect(MAX_RECOMMENDED_UNITS).toBe(3);
    expect(recommendedKellyUnits(0.6, 2.0)).toBe(3);
  });

  it("respects a custom multiplier before capping", () => {
    // full = 0.1, units = 0.1 * 0.5 * 100 = 5 -> capped to 3
    expect(recommendedKellyUnits(0.55, 2.0, 0.5)).toBe(3);
    // full = 0.1, units = 0.1 * 0.1 * 100 = 1 -> uncapped
    expect(recommendedKellyUnits(0.55, 2.0, 0.1)).toBeCloseTo(1, 10);
  });
});
