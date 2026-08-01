import { describe, it, expect, afterEach } from "vitest";
import { lineRegions, propRegions, creditCost } from "./odds-regions";

const KEYS = ["ODDS_REGIONS_LINES", "ODDS_REGIONS_PROPS"];
const original: Record<string, string | undefined> = {};
for (const k of KEYS) original[k] = process.env[k];

afterEach(() => {
  for (const k of KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

describe("region configuration", () => {
  it("defaults to US only so cost never changes without a decision", () => {
    delete process.env.ODDS_REGIONS_LINES;
    delete process.env.ODDS_REGIONS_PROPS;
    expect(lineRegions()).toBe("us");
    expect(propRegions()).toBe("us");
  });

  it("honours an explicit multi-region setting", () => {
    process.env.ODDS_REGIONS_LINES = "us,eu";
    expect(lineRegions()).toBe("us,eu");
  });

  it("configures lines and props independently, since their costs differ wildly", () => {
    process.env.ODDS_REGIONS_LINES = "us,eu";
    process.env.ODDS_REGIONS_PROPS = "us";
    expect(lineRegions()).toBe("us,eu");
    expect(propRegions()).toBe("us");
  });

  it("normalizes case and whitespace", () => {
    process.env.ODDS_REGIONS_LINES = " US , EU ";
    expect(lineRegions()).toBe("us,eu");
  });

  it("drops unrecognized regions rather than passing them through", () => {
    process.env.ODDS_REGIONS_LINES = "us,mars";
    expect(lineRegions()).toBe("us");
  });

  it("falls back when every value is invalid, since an empty region returns no books at all", () => {
    // This would otherwise look identical to a quiet slate, which is a
    // genuinely confusing failure to debug.
    process.env.ODDS_REGIONS_LINES = "mars,jupiter";
    expect(lineRegions()).toBe("us");
  });

  it("falls back on an empty string", () => {
    process.env.ODDS_REGIONS_LINES = "   ";
    expect(lineRegions()).toBe("us");
  });
});

describe("creditCost", () => {
  it("bills markets multiplied by regions", () => {
    expect(creditCost(3, "us")).toBe(3);
    expect(creditCost(3, "us,eu")).toBe(6);
  });

  it("shows why props are the expensive call", () => {
    // Eleven NFL prop markets, per event.
    expect(creditCost(11, "us")).toBe(11);
    expect(creditCost(11, "us,eu")).toBe(22);
  });

  it("never reports less than one credit", () => {
    expect(creditCost(0, "")).toBe(1);
  });
});
