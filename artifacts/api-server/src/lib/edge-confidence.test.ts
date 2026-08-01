import { describe, it, expect } from "vitest";
import { assessConfidence, describeTier, TIER_ORDER, type ConfidenceInputs } from "./edge-confidence";

function inputs(overrides: Partial<ConfidenceInputs> = {}): ConfidenceInputs {
  // A healthy baseline: deep market, books agree, sharps mildly on side.
  return {
    bookCount: 12,
    evPercent: 3,
    dispersionPercent: 0.8,
    sharpProb: 55,
    publicProb: 54,
    impliedProbPercent: 52,
    ...overrides,
  };
}

describe("assessConfidence \u2014 the core thesis", () => {
  it("rates a small edge in a deep agreeing market above a huge edge in a thin one", () => {
    // This is the whole point of the module: EV alone ranks these backwards.
    const boring = assessConfidence(inputs({ evPercent: 2.5 }));
    const exciting = assessConfidence(
      inputs({ evPercent: 14, bookCount: 3, dispersionPercent: 7, sharpProb: null }),
    );
    expect(boring.score).toBeGreaterThan(exciting.score);
    expect(TIER_ORDER[boring.tier]).toBeLessThan(TIER_ORDER[exciting.tier]);
  });

  it("penalizes an edge too large to be credible on a liquid market", () => {
    const plausible = assessConfidence(inputs({ evPercent: 3 }));
    const implausible = assessConfidence(inputs({ evPercent: 12 }));
    expect(implausible.score).toBeLessThan(plausible.score);
    expect(implausible.reasons.join(" ")).toMatch(/stale|too large/i);
  });

  it("is more forgiving of a large edge on a thin market, where outliers are real", () => {
    const thinBig = assessConfidence(inputs({ evPercent: 12, bookCount: 4 }));
    const deepBig = assessConfidence(inputs({ evPercent: 12, bookCount: 14 }));
    // The deep market gets the staleness penalty; the thin one does not.
    expect(deepBig.reasons.join(" ")).toMatch(/too large/i);
    expect(thinBig.reasons.join(" ")).not.toMatch(/too large/i);
  });
});

describe("sharp alignment", () => {
  it("marks an edge the sharps contradict as suspect regardless of other signals", () => {
    // Deep market, tight agreement, but Pinnacle says this side is worse than
    // the price implies. That is usually your error, not the market's.
    const result = assessConfidence(inputs({ sharpProb: 45, impliedProbPercent: 52 }));
    expect(result.sharpDisagrees).toBe(true);
    expect(result.tier).toBe("suspect");
    expect(result.reasons).toContain("sharp books disagree");
  });

  it("rewards an edge the sharps confirm", () => {
    const confirmed = assessConfidence(inputs({ sharpProb: 58, impliedProbPercent: 52 }));
    const neutral = assessConfidence(inputs({ sharpProb: 52, impliedProbPercent: 52 }));
    expect(confirmed.score).toBeGreaterThan(neutral.score);
    expect(confirmed.reasons).toContain("sharp books agree");
  });

  it("mildly penalizes having no sharp price at all", () => {
    const withSharp = assessConfidence(inputs({ sharpProb: 53, impliedProbPercent: 52 }));
    const without = assessConfidence(inputs({ sharpProb: null }));
    expect(without.score).toBeLessThan(withSharp.score);
    expect(without.reasons).toContain("no sharp price");
  });

  it("flags a sharp/public divergence as a moving line", () => {
    const result = assessConfidence(inputs({ sharpProb: 58, publicProb: 52 }));
    expect(result.reasons.join(" ")).toMatch(/diverge|moving/i);
  });
});

describe("market depth", () => {
  it("rewards depth", () => {
    const deep = assessConfidence(inputs({ bookCount: 15 }));
    const shallow = assessConfidence(inputs({ bookCount: 5 }));
    expect(deep.score).toBeGreaterThan(shallow.score);
  });

  it("caps a two-book market at fragile however good everything else looks", () => {
    // Deep-market signals cannot rescue a market this thin: with two quotes the
    // "consensus" is one stale price from fiction, and a sharp book agreeing
    // with a number nobody else posts is not real confirmation.
    const result = assessConfidence(
      inputs({ bookCount: 2, dispersionPercent: 0.2, sharpProb: 60, impliedProbPercent: 52 }),
    );
    expect(result.reasons.join(" ")).toMatch(/thin market/i);
    expect(TIER_ORDER[result.tier]).toBeGreaterThanOrEqual(TIER_ORDER.fragile);
  });
});

describe("book agreement", () => {
  it("rewards tight agreement and penalizes wild disagreement", () => {
    const tight = assessConfidence(inputs({ dispersionPercent: 0.5 }));
    const wild = assessConfidence(inputs({ dispersionPercent: 9 }));
    expect(tight.score).toBeGreaterThan(wild.score);
    expect(wild.reasons.join(" ")).toMatch(/disagree/i);
  });

  it("handles a missing dispersion figure without penalty", () => {
    expect(() => assessConfidence(inputs({ dispersionPercent: null }))).not.toThrow();
  });
});

describe("tiers", () => {
  it("assigns solid to the best case", () => {
    const result = assessConfidence(
      inputs({ bookCount: 15, evPercent: 3, dispersionPercent: 0.5, sharpProb: 58, impliedProbPercent: 52 }),
    );
    expect(result.tier).toBe("solid");
  });

  it("keeps the score bounded", () => {
    const great = assessConfidence(
      inputs({ bookCount: 20, dispersionPercent: 0.1, sharpProb: 80, impliedProbPercent: 50 }),
    );
    const awful = assessConfidence(
      inputs({ bookCount: 1, evPercent: 30, dispersionPercent: 20, sharpProb: 10, impliedProbPercent: 60 }),
    );
    expect(great.score).toBeLessThanOrEqual(100);
    expect(awful.score).toBeGreaterThanOrEqual(0);
  });

  it("orders tiers from most to least trustworthy", () => {
    expect(TIER_ORDER.solid).toBeLessThan(TIER_ORDER.playable);
    expect(TIER_ORDER.playable).toBeLessThan(TIER_ORDER.fragile);
    expect(TIER_ORDER.fragile).toBeLessThan(TIER_ORDER.suspect);
  });

  it("describes every tier", () => {
    for (const tier of ["solid", "playable", "fragile", "suspect"] as const) {
      expect(describeTier(tier).length).toBeGreaterThan(20);
    }
  });
});
