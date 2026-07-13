import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture, stubFetchRoutes } from "./__fixtures__/index";
import { makeFakeDb, stubDrizzleOrm, type FakeDbModule } from "./__fixtures__/fake-db";
import { computeClvPercent } from "./odds-math";
import { closingConsensusForLine } from "./pitcher-k-scanner";
import type { OddsEvent } from "./odds";

/**
 * Guards the pitcher-strikeout paper-trade closing-line job. This is what turns
 * an open paper trade into the closed, CLV-scored record the "beats the market"
 * summary reads from. A regression here wouldn't crash — it would write a
 * closing price off a degraded/thin feed (too few books to devig) or grade off
 * the wrong line, silently faking a beat-the-close edge. These tests prove the
 * job only closes on a real 2+ book consensus, expires when the window lapses
 * with no quote, and never fabricates a CLV in between.
 *
 * The per-event odds feed is stubbed via global fetch; the db handle, drizzle's
 * helpers, and the logger are mocked so no live Postgres or log noise runs.
 */

vi.mock("drizzle-orm", async () => stubDrizzleOrm());
vi.mock("@workspace/db", () => makeFakeDb());
vi.mock("./logger", () => ({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}));

let dbMod: FakeDbModule;
let captureModelClosingLines: () => Promise<void>;

// Due: past kickoff - 30m, still inside the 3h give-up window.
const DUE_NOT_EXPIRED = new Date(Date.now() - 30 * 60 * 1000);
// Due but past the 3h give-up window → eligible to be marked expired.
const DUE_EXPIRED = new Date(Date.now() - 4 * 60 * 60 * 1000);
// Not due yet: kickoff still more than 30m out.
const NOT_DUE = new Date(Date.now() + 6 * 60 * 60 * 1000);

beforeEach(async () => {
  process.env.ODDS_API_KEY = "test-odds-key";
  dbMod = (await import("@workspace/db")) as unknown as FakeDbModule;
  dbMod.__reset();
  ({ captureModelClosingLines } = await import("./model-clv"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** An open, unpriced paper trade on the evt-mlb-k1 fixture (Blake Snell O5.5). */
function seedOpenTrade(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return dbMod.__seedPaperTrade({
    sport: "baseball_mlb",
    gameId: "evt-mlb-k1",
    commenceTime: DUE_NOT_EXPIRED,
    homeTeam: "Los Angeles Dodgers",
    awayTeam: "San Francisco Giants",
    pitcher: "Blake Snell",
    selection: "Over",
    point: 5.5,
    book: "draftkings",
    americanOdds: 150,
    status: "open",
    closingOdds: null,
    closingProb: null,
    clvPercent: null,
    beatClose: null,
    ...overrides,
  });
}

function fetchCallCount(): number {
  const stub = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
  return stub.mock.calls.length;
}

describe("captureModelClosingLines — closes a trade on a real consensus", () => {
  it("sets closingOdds/closingProb/clvPercent/beatClose from the 2-book consensus", async () => {
    const event = loadFixture("model-event-mlb.json") as OddsEvent;
    const expected = closingConsensusForLine(event, "Blake Snell", 5.5, "Over");
    expect(expected).not.toBeNull();

    seedOpenTrade({ id: 1, americanOdds: 150 });
    stubFetchRoutes([{ contains: "/events/", payload: event }]);

    await captureModelClosingLines();

    const trade = dbMod.__stores.pitcher_k_paper_trades[0];
    const clv = computeClvPercent(150, expected!.closingAmerican);
    expect(trade).toMatchObject({
      status: "closed",
      closingOdds: expected!.closingAmerican,
      closingProb: expected!.closingProb,
      clvPercent: clv,
      beatClose: clv > 0,
    });
  });

  it("records beatClose=false when the bet price lagged the close", async () => {
    const event = loadFixture("model-event-mlb.json") as OddsEvent;
    const expected = closingConsensusForLine(event, "Blake Snell", 5.5, "Over")!;

    // Price well worse than the consensus close → negative CLV.
    seedOpenTrade({ id: 1, americanOdds: -200 });
    stubFetchRoutes([{ contains: "/events/", payload: event }]);

    await captureModelClosingLines();

    const trade = dbMod.__stores.pitcher_k_paper_trades[0];
    const clv = computeClvPercent(-200, expected.closingAmerican);
    expect(clv).toBeLessThan(0);
    expect(trade).toMatchObject({ status: "closed", beatClose: false, clvPercent: clv });
  });
});

describe("captureModelClosingLines — abstains instead of faking a CLV", () => {
  it("keeps the trade open (no CLV) when the game is missing and the window is still live", async () => {
    seedOpenTrade({ id: 1, commenceTime: DUE_NOT_EXPIRED });
    stubFetchRoutes([{ contains: "/events/", payload: { id: "evt-mlb-k1", bookmakers: [] } }]);

    await captureModelClosingLines();

    expect(dbMod.__stores.pitcher_k_paper_trades[0]).toMatchObject({
      status: "open",
      closingOdds: null,
      clvPercent: null,
      beatClose: null,
    });
  });

  it("keeps the trade open when only one book quotes the line (can't devig)", async () => {
    // Strip the fixture down to a single book so books.size < 2.
    const event = loadFixture("model-event-mlb.json") as OddsEvent;
    const oneBook = { ...event, bookmakers: event.bookmakers.slice(0, 1) };
    seedOpenTrade({ id: 1, commenceTime: DUE_NOT_EXPIRED });
    stubFetchRoutes([{ contains: "/events/", payload: oneBook }]);

    await captureModelClosingLines();

    expect(dbMod.__stores.pitcher_k_paper_trades[0]).toMatchObject({
      status: "open",
      closingOdds: null,
      clvPercent: null,
    });
  });

  it("marks the trade expired (never a bogus CLV) once the give-up window lapses with no quote", async () => {
    seedOpenTrade({ id: 1, commenceTime: DUE_EXPIRED });
    stubFetchRoutes([{ contains: "/events/", payload: { id: "evt-mlb-k1", bookmakers: [] } }]);

    await captureModelClosingLines();

    expect(dbMod.__stores.pitcher_k_paper_trades[0]).toMatchObject({
      status: "expired",
      closingOdds: null,
      clvPercent: null,
      beatClose: null,
    });
  });

  it("does not crash and keeps the trade open when the feed errors mid-window", async () => {
    seedOpenTrade({ id: 1, commenceTime: DUE_NOT_EXPIRED });
    stubFetchRoutes([{ contains: "/events/", payload: {}, status: 500 }]);

    await expect(captureModelClosingLines()).resolves.toBeUndefined();
    expect(dbMod.__stores.pitcher_k_paper_trades[0]).toMatchObject({
      status: "open",
      closingOdds: null,
    });
  });

  it("expires (not crashes) when the feed errors after the give-up window", async () => {
    seedOpenTrade({ id: 1, commenceTime: DUE_EXPIRED });
    stubFetchRoutes([{ contains: "/events/", payload: {}, status: 500 }]);

    await expect(captureModelClosingLines()).resolves.toBeUndefined();
    expect(dbMod.__stores.pitcher_k_paper_trades[0]).toMatchObject({
      status: "expired",
      closingOdds: null,
    });
  });
});

describe("captureModelClosingLines — spends nothing when there's nothing due", () => {
  it("does not fetch when no open trade is inside the capture window", async () => {
    seedOpenTrade({ id: 1, commenceTime: NOT_DUE });
    stubFetchRoutes([{ contains: "/events/", payload: loadFixture("model-event-mlb.json") }]);

    await captureModelClosingLines();

    expect(fetchCallCount()).toBe(0);
    expect(dbMod.__stores.pitcher_k_paper_trades[0]).toMatchObject({ status: "open" });
  });

  it("does not fetch for trades that are already closed", async () => {
    seedOpenTrade({ id: 1, status: "closed", closingOdds: -110, clvPercent: 3.3 });
    stubFetchRoutes([{ contains: "/events/", payload: loadFixture("model-event-mlb.json") }]);

    await captureModelClosingLines();

    expect(fetchCallCount()).toBe(0);
    expect(dbMod.__stores.pitcher_k_paper_trades[0]).toMatchObject({
      status: "closed",
      closingOdds: -110,
      clvPercent: 3.3,
    });
  });
});
