import { describe, expect, it } from "vitest";
import { CreateBetBody, CreatePaperTradeBody, UpdateBetBody, UpdatePaperTradeBody } from "@workspace/api-zod";
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

/**
 * Boundary prices for the bet-edit vs paper-trade-edit lockstep check.
 * Includes every probe the ±100 gap rule pivots on.
 */
const EDIT_PARITY_ODDS = [-100.5, -100, -99.5, 0, 50, 99.5, 100, 100.5];

describe("bet edits and paper-trade edits ban the same impossible prices", () => {
  it.each(EDIT_PARITY_ODDS)(
    "UpdateBetBody and UpdatePaperTradeBody agree on americanOdds %s",
    (americanOdds) => {
      const bet = UpdateBetBody.safeParse({ americanOdds }).success;
      const paper = UpdatePaperTradeBody.safeParse({ americanOdds }).success;
      expect(
        paper,
        `BetUpdate and PaperTradeUpdate drifted apart on americanOdds ${americanOdds}: ` +
          `UpdateBetBody ${bet ? "accepts" : "rejects"} it but UpdatePaperTradeBody ` +
          `${paper ? "accepts" : "rejects"} it. Both schemas in lib/api-spec/openapi.yaml ` +
          `must keep the identical oneOf ban on the open interval (-100, 100).`,
      ).toBe(bet);
    },
  );

  it.each(EDIT_PARITY_ODDS)(
    "both edit schemas agree with the shared form rule for americanOdds %s",
    (americanOdds) => {
      const expected = isValidAmericanOdds(americanOdds);
      expect(
        UpdateBetBody.safeParse({ americanOdds }).success,
        `UpdateBetBody drifted from isValidAmericanOdds on ${americanOdds}; check the ` +
          `BetUpdate schema in lib/api-spec/openapi.yaml.`,
      ).toBe(expected);
      expect(
        UpdatePaperTradeBody.safeParse({ americanOdds }).success,
        `UpdatePaperTradeBody drifted from isValidAmericanOdds on ${americanOdds}; check the ` +
          `PaperTradeUpdate schema in lib/api-spec/openapi.yaml.`,
      ).toBe(expected);
    },
  );
});

/** A create payload for CreatePaperTradeBody that is valid except for whatever the test overrides. */
const VALID_CREATE_PAPER = {
  sport: "baseball_mlb",
  gameId: "evt-parity-pt-1",
  commenceTime: "2026-07-15T18:00:00Z",
  homeTeam: "Los Angeles Dodgers",
  awayTeam: "San Francisco Giants",
  pitcher: "Clayton Kershaw",
  team: "Los Angeles Dodgers",
  opponent: "San Francisco Giants",
  selection: "Over",
  point: 6.5,
  book: "draftkings",
  americanOdds: -120,
  modelProb: 0.58,
  expectedStrikeouts: 7.2,
  projectedBattersFaced: 24,
  recommendedUnits: 0.5,
  kellyMultiplier: 0.25,
};

function paperTradeCreateAccepts(overrides: Partial<typeof VALID_CREATE_PAPER>): boolean {
  return CreatePaperTradeBody.safeParse({ ...VALID_CREATE_PAPER, ...overrides }).success;
}

/**
 * Boundary prices for the bet-create vs paper-trade-create lockstep check.
 * Includes every probe the ±100 gap rule pivots on.
 */
const CREATE_PARITY_ODDS = [-100.5, -100, -99.5, 0, 50, 99.5, 100, 100.5];

describe("paper-trade create and bet create ban the same impossible prices", () => {
  it.each(CREATE_PARITY_ODDS)(
    "CreateBetBody and CreatePaperTradeBody agree on americanOdds %s",
    (americanOdds) => {
      const bet = createAccepts({ americanOdds });
      const paper = paperTradeCreateAccepts({ americanOdds });
      expect(
        paper,
        `CreateBetBody and CreatePaperTradeBody drifted apart on americanOdds ${americanOdds}: ` +
          `CreateBetBody ${bet ? "accepts" : "rejects"} it but CreatePaperTradeBody ` +
          `${paper ? "accepts" : "rejects"} it. Both schemas in lib/api-spec/openapi.yaml ` +
          `must keep the identical oneOf ban on the open interval (-100, 100).`,
      ).toBe(bet);
    },
  );

  it.each(CREATE_PARITY_ODDS)(
    "both create schemas agree with the shared form rule for americanOdds %s",
    (americanOdds) => {
      const expected = isValidAmericanOdds(americanOdds);
      expect(
        createAccepts({ americanOdds }),
        `CreateBetBody drifted from isValidAmericanOdds on ${americanOdds}; check the ` +
          `BetInput schema in lib/api-spec/openapi.yaml.`,
      ).toBe(expected);
      expect(
        paperTradeCreateAccepts({ americanOdds }),
        `CreatePaperTradeBody drifted from isValidAmericanOdds on ${americanOdds}; check the ` +
          `PaperTradeInput schema in lib/api-spec/openapi.yaml.`,
      ).toBe(expected);
    },
  );
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
