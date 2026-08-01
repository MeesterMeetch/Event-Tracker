import { describe, it, expect, afterEach } from "vitest";
import {
  devig,
  devigProportional,
  devigPower,
  devigShin,
  devigAdditive,
  configuredDevigMethod,
  DEFAULT_DEVIG_METHOD,
  DEVIG_METHODS,
} from "./devig";
import { americanToImpliedProb } from "./odds-math";

const imp = americanToImpliedProb;
/** The lopsided market from the module docs: Over -250 against Under +190. */
const LOPSIDED = [imp(-250), imp(190)];
const SYMMETRIC = [imp(-110), imp(-110)];

describe("the favourite-longshot bias this module exists to fix", () => {
  it("shows proportional crediting the longshot more than power", () => {
    expect(devigProportional(LOPSIDED)[1]).toBeGreaterThan(devigPower(LOPSIDED)[1]);
  });

  it("shows proportional crediting the longshot more than shin", () => {
    expect(devigProportional(LOPSIDED)[1]).toBeGreaterThan(devigShin(LOPSIDED)[1]);
  });

  it("is a material gap, not a rounding difference", () => {
    const gap = devigProportional(LOPSIDED)[1] - devigPower(LOPSIDED)[1];
    expect(gap).toBeGreaterThan(0.01);
  });

  it("widens as the market gets more lopsided", () => {
    const mild = [imp(-150), imp(120)];
    const severe = [imp(-800), imp(600)];
    const mildGap = devigProportional(mild)[1] - devigShin(mild)[1];
    const severeGap = devigProportional(severe)[1] - devigShin(severe)[1];
    expect(severeGap).toBeGreaterThan(mildGap);
  });
});

describe("shin equals additive on two-way markets", () => {
  // Verified against an independent brute-force solve of Shin's constraint.
  // Documented as a test so the equivalence is not mistaken for a bug later.
  it.each([
    [-250, 190],
    [-400, 300],
    [-2000, 1200],
  ])("holds for %i / %i", (fav, dog) => {
    const pair = [imp(fav), imp(dog)];
    const shin = devigShin(pair);
    const additive = devigAdditive(pair);
    shin.forEach((p, i) => expect(p).toBeCloseTo(additive[i], 9));
  });

  it("diverges on a three-way market", () => {
    const three = [imp(150), imp(240), imp(190)];
    const shin = devigShin(three);
    const additive = devigAdditive(three);
    const maxDiff = Math.max(...shin.map((p, i) => Math.abs(p - additive[i])));
    expect(maxDiff).toBeGreaterThan(1e-5);
  });
});

describe.each(DEVIG_METHODS)("%s", (method) => {
  it("produces a normalized distribution", () => {
    const r = devig(LOPSIDED, method);
    expect(r.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it("keeps every probability strictly inside (0, 1)", () => {
    expect(devig(LOPSIDED, method).every((p) => p > 0 && p < 1)).toBe(true);
  });

  it("preserves the ordering of outcomes", () => {
    const r = devig(LOPSIDED, method);
    expect(r[0]).toBeGreaterThan(r[1]);
  });

  it("splits a symmetric market evenly", () => {
    const r = devig(SYMMETRIC, method);
    expect(r[0]).toBeCloseTo(0.5, 6);
    expect(r[1]).toBeCloseTo(0.5, 6);
  });

  it("normalizes a three-way market", () => {
    const r = devig([imp(150), imp(240), imp(190)], method);
    expect(r.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it("handles a sub-1 overround (arbitrage) without breaking", () => {
    const arb = [imp(120), imp(120)];
    const r = devig(arb, method);
    expect(r.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(r.every((p) => p > 0 && p < 1)).toBe(true);
  });

  it("stays finite on an extreme longshot", () => {
    const r = devig([imp(-10000), imp(5000)], method);
    expect(r.every((p) => Number.isFinite(p) && p > 0 && p < 1)).toBe(true);
    expect(r[0]).toBeGreaterThan(r[1]);
  });
});

describe("degenerate inputs", () => {
  it("returns an empty array for no outcomes", () => {
    expect(devig([], "shin")).toEqual([]);
  });

  it("returns certainty for a single outcome", () => {
    expect(devig([0.5], "shin")).toEqual([1]);
  });

  it("does not emit NaN when an outcome has zero probability", () => {
    expect(devig([0, 0.5], "shin").every((p) => Number.isFinite(p))).toBe(true);
  });
});

describe("configuredDevigMethod", () => {
  const original = process.env.DEVIG_METHOD;
  afterEach(() => {
    if (original === undefined) delete process.env.DEVIG_METHOD;
    else process.env.DEVIG_METHOD = original;
  });

  it("defaults to shin", () => {
    delete process.env.DEVIG_METHOD;
    expect(configuredDevigMethod()).toBe("shin");
    expect(DEFAULT_DEVIG_METHOD).toBe("shin");
  });

  it("honours a valid override", () => {
    process.env.DEVIG_METHOD = "power";
    expect(configuredDevigMethod()).toBe("power");
  });

  it("falls back to the default on an unrecognized value", () => {
    process.env.DEVIG_METHOD = "nonsense";
    expect(configuredDevigMethod()).toBe("shin");
  });
});
