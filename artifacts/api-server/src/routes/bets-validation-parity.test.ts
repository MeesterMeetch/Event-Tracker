import { describe, expect, it } from "vitest";
import { CreateBetBody, UpdateBetBody } from "@workspace/api-zod";
import {
  isValidAmericanOdds,
  isValidUnitsStake,
  MIN_UNITS_STAKE,
} from "@workspace/format";

/**
 * Lockstep guard between the shared client-side bet rules
 * (lib/format/src/betInputs.ts, used verbatim by the web dialogs and the
 * phone's sheets) and the server-side zod schemas generated from
 * lib/api-spec/openapi.yaml (used verbatim by POST /bets and PATCH /bets/:id).
 *
 * For every boundary value the two sides must agree: a stake or price the
 * forms accept must pass the API schema, and one the forms reject must fail
 * it. If either side's rule drifts alone — the spec's odds range, its minimum
 * stake, or the shared predicates — one of these assertions breaks loudly.
 */

/** A create payload that is valid except for whatever the test overrides. */
const VALID_CREATE = {
  sport: "baseball_mlb",
  gameId: "evt-parity-1",
  commenceTime: "2026-07-15T18:00:00Z",
  homeTeam: "Los Angeles Dodgers",
  awayTeam: "San Francisco Giants",
  market: "h2h",
  selection: "Los Angeles Dodgers",
  point: null,
  americanOdds: -120,
  units: 1,
};

function createAccepts(overrides: Partial<typeof VALID_CREATE>): boolean {
  return CreateBetBody.safeParse({ ...VALID_CREATE, ...overrides }).success;
}

function updateAccepts(patch: Record<string, unknown>): boolean {
  return UpdateBetBody.safeParse(patch).success;
}

/**
 * Boundary stakes around the shared minimum. Derived from MIN_UNITS_STAKE so
 * the probes track the shared rule if it ever moves.
 */
const STAKE_BOUNDARIES = [
  MIN_UNITS_STAKE - 0.001, // 0.009u — just below the minimum
  MIN_UNITS_STAKE, // 0.01u — exactly the minimum
  0,
  -1,
  1,
];

/** Boundary prices around the ±100 American-odds gap. */
const ODDS_BOUNDARIES = [-100.5, -100, -99.5, 0, 99.5, 100, 100.5];

describe("bet-create validation matches the shared form rules", () => {
  it.each(STAKE_BOUNDARIES)("agrees with isValidUnitsStake for %su stakes", (units) => {
    expect(createAccepts({ units })).toBe(isValidUnitsStake(units));
  });

  it.each(ODDS_BOUNDARIES)("agrees with isValidAmericanOdds for odds of %s", (americanOdds) => {
    expect(createAccepts({ americanOdds })).toBe(isValidAmericanOdds(americanOdds));
  });
});

describe("bet-update validation matches the shared form rules", () => {
  it.each(STAKE_BOUNDARIES)("agrees with isValidUnitsStake for %su stakes", (units) => {
    expect(updateAccepts({ units })).toBe(isValidUnitsStake(units));
  });

  it.each(ODDS_BOUNDARIES)("agrees with isValidAmericanOdds for odds of %s", (americanOdds) => {
    expect(updateAccepts({ americanOdds })).toBe(isValidAmericanOdds(americanOdds));
  });
});

describe("boundary sanity (pins the exact rules, not just parity)", () => {
  it("rejects a 0.009u stake and accepts a 0.01u stake", () => {
    expect(createAccepts({ units: 0.009 })).toBe(false);
    expect(createAccepts({ units: 0.01 })).toBe(true);
  });

  it("rejects odds strictly inside (-100, 100), including zero", () => {
    expect(createAccepts({ americanOdds: -99.5 })).toBe(false);
    expect(createAccepts({ americanOdds: 0 })).toBe(false);
    expect(createAccepts({ americanOdds: 99.5 })).toBe(false);
    expect(createAccepts({ americanOdds: -100 })).toBe(true);
    expect(createAccepts({ americanOdds: 100 })).toBe(true);
  });
});
