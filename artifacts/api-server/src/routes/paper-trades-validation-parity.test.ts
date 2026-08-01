import { describe, expect, it } from "vitest";
import { CreatePaperTradeBody, UpdatePaperTradeBody } from "@workspace/api-zod";
import { isValidAmericanOdds } from "@workspace/format";

/**
 * Lockstep guard between the shared American-odds rule
 * (lib/format/src/betInputs.ts) and the paper-trade zod schemas generated
 * from lib/api-spec/openapi.yaml (used verbatim by POST /paper-trades and
 * PATCH /paper-trades/:id). A paper trade logged at an impossible price like
 * +50 or 0 would silently skew the model's CLV and P&L validation record, so
 * the ledger's schemas must ban the same (-100, 100) gap the bet log bans.
 *
 * Companion to bets-validation-parity.test.ts — if either side's odds rule
 * drifts alone, one of these assertions breaks loudly.
 */

/** A create payload that is valid except for whatever the test overrides. */
const VALID_CREATE = {
  sport: "baseball_mlb",
  gameId: "evt-parity-pt-1",
  commenceTime: "2026-07-15T18:00:00Z",
  homeTeam: "Los Angeles Dodgers",
  awayTeam: "San Francisco Giants",
  pitcher: "Blake Snell",
  pitcherId: 605483,
  team: "Los Angeles Dodgers",
  opponent: "San Francisco Giants",
  selection: "Over",
  point: 6.5,
  book: "FanDuel",
  americanOdds: -110,
  modelProb: 0.6,
  marketProb: 0.52,
  edgePercent: 8,
  expectedStrikeouts: 7.2,
  projectedBattersFaced: 25,
  recommendedUnits: 1,
  kellyMultiplier: 0.25,
};

function createAccepts(overrides: Partial<typeof VALID_CREATE>): boolean {
  return CreatePaperTradeBody.safeParse({ ...VALID_CREATE, ...overrides }).success;
}

function updateAccepts(patch: Record<string, unknown>): boolean {
  return UpdatePaperTradeBody.safeParse(patch).success;
}

/** Boundary prices around the ±100 American-odds gap. */
const ODDS_BOUNDARIES = [-100.5, -100, -99.5, 0, 99.5, 100, 100.5];

describe("paper-trade create validation matches the shared odds rule", () => {
  it.each(ODDS_BOUNDARIES)("agrees with isValidAmericanOdds for odds of %s", (americanOdds) => {
    expect(createAccepts({ americanOdds })).toBe(isValidAmericanOdds(americanOdds));
  });
});

describe("paper-trade update validation matches the shared odds rule", () => {
  it.each(ODDS_BOUNDARIES)("agrees with isValidAmericanOdds for odds of %s", (americanOdds) => {
    expect(updateAccepts({ americanOdds })).toBe(isValidAmericanOdds(americanOdds));
  });
});

describe("boundary sanity (pins the exact rules, not just parity)", () => {
  it("rejects odds strictly inside (-100, 100), including zero, on create", () => {
    expect(createAccepts({ americanOdds: -99.5 })).toBe(false);
    expect(createAccepts({ americanOdds: 0 })).toBe(false);
    expect(createAccepts({ americanOdds: 99.5 })).toBe(false);
    expect(createAccepts({ americanOdds: -100 })).toBe(true);
    expect(createAccepts({ americanOdds: 100 })).toBe(true);
  });

  it("rejects odds strictly inside (-100, 100), including zero, on update", () => {
    expect(updateAccepts({ americanOdds: -99.5 })).toBe(false);
    expect(updateAccepts({ americanOdds: 0 })).toBe(false);
    expect(updateAccepts({ americanOdds: 99.5 })).toBe(false);
    expect(updateAccepts({ americanOdds: -100 })).toBe(true);
    expect(updateAccepts({ americanOdds: 100 })).toBe(true);
  });

  it("rejects a negative recommendedUnits (the model clamps to >= 0) and accepts 0", () => {
    expect(createAccepts({ recommendedUnits: -0.5 })).toBe(false);
    expect(createAccepts({ recommendedUnits: 0 })).toBe(true);
  });
});
