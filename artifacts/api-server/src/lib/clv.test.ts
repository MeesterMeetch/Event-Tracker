import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture, stubFetchRoutes } from "./__fixtures__/index";
import { makeFakeDb, stubDrizzleOrm, type FakeDbModule } from "./__fixtures__/fake-db";
import { computeClvPercent } from "./odds-math";

/**
 * Guards the game-line closing-line capture job. Like the settlement engine,
 * this is a silent-failure surface: a regression wouldn't crash, it would
 * record the wrong closing price (or a CLV built off a degraded/missing feed),
 * quietly inflating or deflating the model's apparent beat-the-close edge.
 * These tests prove the job captures a real consensus close and otherwise
 * leaves the bet open (closingOdds null) rather than writing a bogus number.
 *
 * The bulk odds feed is stubbed via global fetch (the mock-fetch fixture
 * pattern); the db handle, drizzle's helpers, and the logger are mocked so no
 * live Postgres or log noise is involved.
 */

vi.mock("drizzle-orm", async () => stubDrizzleOrm());
vi.mock("@workspace/db", () => makeFakeDb());
vi.mock("./logger", () => ({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}));

let dbMod: FakeDbModule;
let captureClosingLines: () => Promise<void>;

// Inside clv.ts's capture window: [kickoff - 30m, kickoff + 3h].
const IN_WINDOW = new Date();
// Kickoff far in the future — not yet inside the capture window.
const NOT_DUE = new Date(Date.now() + 6 * 60 * 60 * 1000);

beforeEach(async () => {
  process.env.ODDS_API_KEY = "test-odds-key";
  dbMod = (await import("@workspace/db")) as unknown as FakeDbModule;
  dbMod.__reset();
  ({ captureClosingLines } = await import("./clv"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A due, open (unpriced) game-line bet on the evt-mlb-1 fixture game. */
function seedDueBet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return dbMod.__seedBet({
    sport: "baseball_mlb",
    gameId: "evt-mlb-1",
    commenceTime: IN_WINDOW,
    homeTeam: "New York Yankees",
    awayTeam: "Boston Red Sox",
    market: "h2h",
    selection: "New York Yankees",
    point: null,
    americanOdds: 120,
    units: 1,
    status: "pending",
    closingOdds: null,
    clvPercent: null,
    ...overrides,
  });
}

function fetchCallCount(): number {
  const stub = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
  return stub.mock.calls.length;
}

describe("captureClosingLines — captures the consensus closing line", () => {
  it("records the averaged closing price and CLV for a due bet", async () => {
    // evt-mlb-1 h2h Yankees: DraftKings -110, FanDuel +120. Averaging in decimal
    // space: (1.909091 + 2.2) / 2 = 2.054545 → +105 American.
    seedDueBet({ id: 1, selection: "New York Yankees", americanOdds: 120 });
    stubFetchRoutes([{ contains: "/odds", payload: loadFixture("edges-slate-mlb.json") }]);

    await captureClosingLines();

    const bet = dbMod.__stores.bets[0];
    expect(bet.closingOdds).toBe(105);
    expect(bet.clvPercent).toBe(computeClvPercent(120, 105));
  });

  it("captures totals by side/point, not exact selection string", async () => {
    // evt-mlb-2 totals Over 8.5: DraftKings -110, FanDuel +115. Averaging in
    // decimal space: (1.909091 + 2.15) / 2 = 2.029545 → +103 American.
    seedDueBet({
      id: 1,
      gameId: "evt-mlb-2",
      homeTeam: "Los Angeles Dodgers",
      awayTeam: "San Francisco Giants",
      market: "totals",
      selection: "Over 8.5",
      point: 8.5,
      americanOdds: 115,
    });
    stubFetchRoutes([{ contains: "/odds", payload: loadFixture("edges-slate-mlb.json") }]);

    await captureClosingLines();

    const bet = dbMod.__stores.bets[0];
    expect(bet.closingOdds).toBe(103);
    expect(bet.clvPercent).toBe(computeClvPercent(115, 103));
  });
});

describe("captureClosingLines — leaves the bet open instead of writing a bogus CLV", () => {
  it("leaves closingOdds null when the game is missing from the feed", async () => {
    seedDueBet({ id: 1, gameId: "evt-not-in-feed" });
    stubFetchRoutes([{ contains: "/odds", payload: loadFixture("edges-slate-mlb.json") }]);

    await captureClosingLines();

    expect(dbMod.__stores.bets[0]).toMatchObject({ closingOdds: null, clvPercent: null });
  });

  it("leaves closingOdds null when the market/side has no quote", async () => {
    // Point mismatch: the bet is on a total of 9.5 but the feed only has 8.5.
    seedDueBet({
      id: 1,
      gameId: "evt-mlb-2",
      market: "totals",
      selection: "Over 9.5",
      point: 9.5,
    });
    stubFetchRoutes([{ contains: "/odds", payload: loadFixture("edges-slate-mlb.json") }]);

    await captureClosingLines();

    expect(dbMod.__stores.bets[0]).toMatchObject({ closingOdds: null, clvPercent: null });
  });

  it("does not crash and leaves the bet open when the odds feed errors", async () => {
    seedDueBet({ id: 1 });
    stubFetchRoutes([{ contains: "/odds", payload: {}, status: 500 }]);

    await expect(captureClosingLines()).resolves.toBeUndefined();
    expect(dbMod.__stores.bets[0]).toMatchObject({ closingOdds: null, clvPercent: null });
  });

  it("does not crash and leaves the bet open on an empty feed", async () => {
    seedDueBet({ id: 1 });
    stubFetchRoutes([{ contains: "/odds", payload: [] }]);

    await expect(captureClosingLines()).resolves.toBeUndefined();
    expect(dbMod.__stores.bets[0]).toMatchObject({ closingOdds: null, clvPercent: null });
  });
});

describe("captureClosingLines — spends nothing when there's nothing to capture", () => {
  it("does not fetch when the bet is outside the capture window", async () => {
    seedDueBet({ id: 1, commenceTime: NOT_DUE });
    stubFetchRoutes([{ contains: "/odds", payload: loadFixture("edges-slate-mlb.json") }]);

    await captureClosingLines();

    expect(fetchCallCount()).toBe(0);
    expect(dbMod.__stores.bets[0]).toMatchObject({ closingOdds: null });
  });

  it("does not fetch for prop markets (no bulk-feed closing line)", async () => {
    seedDueBet({ id: 1, market: "player_strikeouts", selection: "Over", point: 5.5 });
    stubFetchRoutes([{ contains: "/odds", payload: loadFixture("edges-slate-mlb.json") }]);

    await captureClosingLines();

    expect(fetchCallCount()).toBe(0);
    expect(dbMod.__stores.bets[0]).toMatchObject({ closingOdds: null });
  });

  it("does not fetch when a bet already has a closing line", async () => {
    seedDueBet({ id: 1, closingOdds: -105, clvPercent: 1.2 });
    stubFetchRoutes([{ contains: "/odds", payload: loadFixture("edges-slate-mlb.json") }]);

    await captureClosingLines();

    expect(fetchCallCount()).toBe(0);
    expect(dbMod.__stores.bets[0]).toMatchObject({ closingOdds: -105, clvPercent: 1.2 });
  });
});
