import { describe, expect, it } from "vitest";
import {
  americanToDecimal,
  americanToImpliedProb,
  baseSelection,
  computeClvPercent,
  decimalToAmerican,
  probToAmerican,
} from "./odds-math";

/**
 * These are the primitive conversions that every edge/EV number is built on. A
 * silent regression here would quietly poison every displayed price, so each
 * case below is hand-computed from the definition of American odds rather than
 * derived from the code under test.
 */

describe("americanToDecimal", () => {
  it("converts positive American odds (underdog)", () => {
    // +150 pays 1.5x profit → 2.5 decimal.
    expect(americanToDecimal(150)).toBeCloseTo(2.5, 10);
  });

  it("converts negative American odds (favorite)", () => {
    // -120 → 1 + 100/120.
    expect(americanToDecimal(-120)).toBeCloseTo(1.8333333, 6);
  });

  it("maps the pick'em prices to 2.0", () => {
    expect(americanToDecimal(100)).toBeCloseTo(2.0, 10);
    expect(americanToDecimal(-100)).toBeCloseTo(2.0, 10);
  });
});

describe("americanToImpliedProb", () => {
  it("gives the raw (vig-included) probability for an underdog", () => {
    // 100 / (150 + 100) = 0.4.
    expect(americanToImpliedProb(150)).toBeCloseTo(0.4, 10);
  });

  it("gives the raw probability for a favorite", () => {
    // 120 / (120 + 100) = 0.5454...
    expect(americanToImpliedProb(-120)).toBeCloseTo(0.5454545, 6);
  });

  it("treats a standard -110 line as ~0.5238", () => {
    expect(americanToImpliedProb(-110)).toBeCloseTo(0.5238095, 6);
  });

  it("pick'em prices imply exactly 0.5", () => {
    expect(americanToImpliedProb(100)).toBeCloseTo(0.5, 10);
    expect(americanToImpliedProb(-100)).toBeCloseTo(0.5, 10);
  });
});

describe("decimalToAmerican", () => {
  it("round-trips an underdog price", () => {
    expect(decimalToAmerican(2.5)).toBe(150);
  });

  it("round-trips a favorite price", () => {
    expect(decimalToAmerican(1.8333333)).toBe(-120);
  });

  it("maps even money to +100", () => {
    expect(decimalToAmerican(2.0)).toBe(100);
  });

  it("returns 0 for degenerate decimals at or below 1", () => {
    expect(decimalToAmerican(1)).toBe(0);
    expect(decimalToAmerican(0.5)).toBe(0);
  });
});

describe("probToAmerican", () => {
  it("maps a coin flip to -100", () => {
    expect(probToAmerican(0.5)).toBe(-100);
  });

  it("maps a 0.4 fair probability to +150", () => {
    // (1 - 0.4) / 0.4 * 100 = 150.
    expect(probToAmerican(0.4)).toBe(150);
  });

  it("maps a 0.6 fair probability to -150", () => {
    expect(probToAmerican(0.6)).toBe(-150);
  });

  it("clamps extreme probabilities instead of dividing by zero", () => {
    expect(Number.isFinite(probToAmerican(0))).toBe(true);
    expect(Number.isFinite(probToAmerican(1))).toBe(true);
  });
});

describe("computeClvPercent", () => {
  it("is positive when the bet price beat the close", () => {
    // Bet +150 (2.5), closed +130 (2.3): 2.5/2.3 - 1 = 8.70%.
    expect(computeClvPercent(150, 130)).toBeCloseTo(8.7, 2);
  });

  it("beating a favorite's closing line is still positive", () => {
    // Bet -110 (1.9091), closed -120 (1.8333): +4.13%.
    expect(computeClvPercent(-110, -120)).toBeCloseTo(4.13, 2);
  });

  it("is negative when the line moved against the bettor", () => {
    // Bet -120 (1.8333), closed -110 (1.9091): -3.97%.
    expect(computeClvPercent(-120, -110)).toBeCloseTo(-3.97, 2);
  });

  it("is zero when bet and close match", () => {
    expect(computeClvPercent(150, 150)).toBe(0);
  });
});

describe("baseSelection", () => {
  it("collapses a totals Over line to Over", () => {
    expect(baseSelection("totals", "Over 8.5")).toBe("Over");
  });

  it("collapses a totals Under line to Under", () => {
    expect(baseSelection("totals", "Under 8.5")).toBe("Under");
  });

  it("leaves non-totals selections untouched", () => {
    expect(baseSelection("h2h", "New York Yankees")).toBe("New York Yankees");
    expect(baseSelection("spreads", "Over 8.5")).toBe("Over 8.5");
  });
});
