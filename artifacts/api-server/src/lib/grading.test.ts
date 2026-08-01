import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture, stubFetchRoutes } from "./__fixtures__/index";
import { makeFakeDb, stubDrizzleOrm, type FakeDbModule } from "./__fixtures__/fake-db";

/**
 * Guards the auto-settlement engine that turns a finished game into a graded
 * bet with realized P&L. This is the highest-risk silent-failure surface in the
 * bet tracker: a regression wouldn't crash — it would settle bets against the
 * wrong score, or "confirm" a result off a degraded/missing scores feed and
 * corrupt the user's performance history. gradeBet already refuses to guess on
 * bad data; these tests prove the surrounding orchestration honors that and
 * leaves anything it can't cleanly grade as pending.
 *
 * The scores feed is stubbed via global fetch (the mock-fetch fixture pattern);
 * the db handle, drizzle's eq, and the logger are mocked so no live Postgres or
 * log noise is involved.
 */

vi.mock("drizzle-orm", async () => stubDrizzleOrm());
vi.mock("@workspace/db", () => makeFakeDb());
vi.mock("./logger", () => ({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}));

let dbMod: FakeDbModule;
let settlePendingBets: () => Promise<void>;

// Comfortably past grading.ts's GRADE_AFTER_MS (2.5h) window.
const FOUR_HOURS_AGO = new Date(Date.now() - 4 * 60 * 60 * 1000);
const JUST_NOW = new Date();

beforeEach(async () => {
  process.env.ODDS_API_KEY = "test-odds-key";
  dbMod = (await import("@workspace/db")) as unknown as FakeDbModule;
  dbMod.__reset();
  ({ settlePendingBets } = await import("./grading"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A due, pending, auto-gradable bet on the completed fixture game. */
function seedDueBet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return dbMod.__seedBet({
    sport: "baseball_mlb",
    gameId: "evt-mlb-1",
    commenceTime: FOUR_HOURS_AGO,
    homeTeam: "New York Yankees",
    awayTeam: "Boston Red Sox",
    market: "h2h",
    selection: "New York Yankees",
    point: null,
    americanOdds: 100,
    units: 1,
    status: "pending",
    pnl: null,
    ...overrides,
  });
}

function fetchCallCount(): number {
  const stub = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
  return stub.mock.calls.length;
}

describe("settlePendingBets — settles from final scores", () => {
  it("settles win, loss, and push against the confirmed final score", async () => {
    // Yankees 5, Red Sox 3, total 8 in the fixture.
    seedDueBet({ id: 1, selection: "New York Yankees", americanOdds: 100, units: 1 }); // win → +1
    seedDueBet({ id: 2, selection: "Boston Red Sox", americanOdds: -110, units: 1 }); // loss → -1
    seedDueBet({ id: 3, market: "totals", selection: "Over", point: 8, americanOdds: -110, units: 1 }); // push → 0
    stubFetchRoutes([{ contains: "/scores", payload: loadFixture("scores-mlb.json") }]);

    await settlePendingBets();

    const byId = new Map(dbMod.__stores.bets.map((b) => [b.id, b]));
    expect(byId.get(1)).toMatchObject({ status: "won", pnl: 1 });
    expect(byId.get(2)).toMatchObject({ status: "lost", pnl: -1 });
    expect(byId.get(3)).toMatchObject({ status: "push", pnl: 0 });
  });
});

describe("settlePendingBets — abstains instead of mis-settling on bad data", () => {
  it("leaves a bet pending when the game hasn't completed yet", async () => {
    // evt-mlb-2 is in progress (completed:false, scores:null) in the fixture.
    seedDueBet({ id: 1, gameId: "evt-mlb-2", homeTeam: "Chicago Cubs", awayTeam: "St. Louis Cardinals", selection: "Chicago Cubs" });
    stubFetchRoutes([{ contains: "/scores", payload: loadFixture("scores-mlb.json") }]);

    await settlePendingBets();

    expect(dbMod.__stores.bets[0]).toMatchObject({ status: "pending", pnl: null });
  });

  it("leaves a bet pending when the game is missing from the feed", async () => {
    seedDueBet({ id: 1, gameId: "evt-not-in-feed" });
    stubFetchRoutes([{ contains: "/scores", payload: [] }]);

    await settlePendingBets();

    expect(dbMod.__stores.bets[0]).toMatchObject({ status: "pending", pnl: null });
  });

  it("does not crash and leaves bets pending when the scores feed errors", async () => {
    seedDueBet({ id: 1 });
    stubFetchRoutes([{ contains: "/scores", payload: {}, status: 500 }]);

    await expect(settlePendingBets()).resolves.toBeUndefined();
    expect(dbMod.__stores.bets[0]).toMatchObject({ status: "pending", pnl: null });
  });
});

describe("settlePendingBets — spends nothing when there's nothing to grade", () => {
  it("does not fetch scores when no pending bet is due yet", async () => {
    seedDueBet({ id: 1, commenceTime: JUST_NOW }); // too recent to be due
    stubFetchRoutes([{ contains: "/scores", payload: loadFixture("scores-mlb.json") }]);

    await settlePendingBets();

    expect(fetchCallCount()).toBe(0);
    expect(dbMod.__stores.bets[0]).toMatchObject({ status: "pending", pnl: null });
  });

  it("skips prop markets it can't grade from team scores without fetching", async () => {
    seedDueBet({ id: 1, market: "player_strikeouts", selection: "Over" });
    stubFetchRoutes([{ contains: "/scores", payload: loadFixture("scores-mlb.json") }]);

    await settlePendingBets();

    expect(fetchCallCount()).toBe(0);
    expect(dbMod.__stores.bets[0]).toMatchObject({ status: "pending", pnl: null });
  });
});
