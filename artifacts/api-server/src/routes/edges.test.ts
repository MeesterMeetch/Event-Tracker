import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture, stubFetchRoutes } from "../lib/__fixtures__/index";

/**
 * Guards the game-line scanner: the /edges route. It scans h2h/spreads/totals
 * for every upcoming game in a sport in one bulk Odds API call, so a regression
 * here wouldn't crash — it would silently drop games from the slate, request
 * the wrong markets, or turn an upstream failure into a broken/empty result
 * instead of a clean error. These tests run the real route against stubbed Odds
 * API payloads.
 *
 * Two upstream endpoints are involved: the free /sports lookup (validates the
 * sport, matched by `all=false`) and the bulk /sports/<key>/odds call that does
 * the scan (matched by `/odds`). The test's own request to the server uses
 * node:http, so stubbing global `fetch` only intercepts the route's upstream
 * calls.
 */

// Live /sports lookup (free) — decides which keys isSupportedSport accepts.
const SPORTS_LIST = [
  { key: "baseball_mlb", group: "Baseball", title: "MLB", description: "", active: true, has_outrights: false },
  { key: "basketball_nba", group: "Basketball", title: "NBA", description: "", active: true, has_outrights: false },
  { key: "soccer_epl", group: "Soccer", title: "EPL", description: "", active: true, has_outrights: false },
];

const SPORTS_ROUTE = { contains: "all=false", payload: SPORTS_LIST };

beforeEach(() => {
  // Fresh module graph per test so sports.ts's in-memory cache never leaks the
  // previous test's /sports payload.
  vi.resetModules();
  process.env.ODDS_API_KEY = "test-odds-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function buildApp(): Promise<Express> {
  const { default: edgesRouter } = await import("./edges");
  const app = express();
  // The real server attaches req.log via pino-http; provide a no-op stand-in.
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, () => void> }).log = {
      error() {},
      warn() {},
      info() {},
      debug() {},
    };
    next();
  });
  app.use("/api", edgesRouter);
  return app;
}

async function getJson(app: Express, path: string): Promise<{ status: number; body: unknown }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path }, (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null }),
          );
        })
        .on("error", reject);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** URLs the route asked the (stubbed) Odds API for, in call order. */
function upstreamUrls(): string[] {
  const stub = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
  return stub.mock.calls.map((call) => String(call[0]));
}

describe("GET /edges", () => {
  it("requests exactly the game-line markets across US books for the sport", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      { contains: "/odds", payload: loadFixture("edges-slate-mlb.json") },
    ]);
    const app = await buildApp();

    const { status } = await getJson(app, "/api/edges?sport=baseball_mlb");
    expect(status).toBe(200);

    const oddsCalls = upstreamUrls().filter((u) => u.includes("/odds"));
    // Exactly one bulk call scans the whole slate.
    expect(oddsCalls).toHaveLength(1);

    const url = new URL(oddsCalls[0]);
    expect(url.pathname).toContain("/sports/baseball_mlb/odds");
    // The bulk scan must request h2h/spreads/totals and nothing else.
    expect(url.searchParams.get("markets")).toBe("h2h,spreads,totals");
    expect(url.searchParams.get("regions")).toBe("us");
    expect(url.searchParams.get("oddsFormat")).toBe("american");
  });

  it("returns the positive-EV edges for a normal slate without dropping any game", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      { contains: "/odds", payload: loadFixture("edges-slate-mlb.json") },
    ]);
    const app = await buildApp();

    const { status, body } = await getJson(app, "/api/edges?sport=baseball_mlb");

    expect(status).toBe(200);
    const edges = body as Array<Record<string, unknown>>;
    expect(edges.length).toBeGreaterThan(0);

    // Both games in the slate must be represented — neither silently dropped.
    const gameIds = new Set(edges.map((e) => e.gameId));
    expect(gameIds).toEqual(new Set(["evt-mlb-1", "evt-mlb-2"]));

    // Game 1: FanDuel's +120 on the Yankees beats the devigged consensus, so it
    // surfaces as an h2h edge on the best-priced book.
    const h2hEdge = edges.find((e) => e.market === "h2h");
    expect(h2hEdge).toMatchObject({
      gameId: "evt-mlb-1",
      market: "h2h",
      selection: "New York Yankees",
      book: "FanDuel",
      americanOdds: 120,
      player: null,
    });
    expect(h2hEdge!.evPercent as number).toBeGreaterThan(0);

    // Game 2: FanDuel's +115 Over 8.5 beats the consensus total.
    const totalsEdge = edges.find((e) => e.market === "totals");
    expect(totalsEdge).toMatchObject({
      gameId: "evt-mlb-2",
      market: "totals",
      selection: "Over",
      point: 8.5,
      book: "FanDuel",
    });
    expect(totalsEdge!.evPercent as number).toBeGreaterThan(0);
  });

  it("honors minEdgePercent, filtering out edges below the threshold", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      { contains: "/odds", payload: loadFixture("edges-slate-mlb.json") },
    ]);
    const app = await buildApp();

    // Set the bar above any edge in the fixture so nothing qualifies.
    const { status, body } = await getJson(app, "/api/edges?sport=baseball_mlb&minEdgePercent=99");

    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it("rejects a sport the Odds API doesn't list without spending a credit", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      { contains: "/odds", payload: loadFixture("edges-slate-mlb.json") },
    ]);
    const app = await buildApp();

    const { status, body } = await getJson(app, "/api/edges?sport=cricket_ipl");

    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/unsupported sport/i);
    // The bulk odds scan must never run for an unsupported sport.
    expect(upstreamUrls().some((u) => u.includes("/odds"))).toBe(false);
  });

  it("returns an empty slate (not an error) when there are no upcoming games", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      { contains: "/odds", payload: [] },
    ]);
    const app = await buildApp();

    const { status, body } = await getJson(app, "/api/edges?sport=baseball_mlb");

    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it("fails cleanly (502) instead of crashing when the upstream errors", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      { contains: "/odds", payload: {}, status: 500 },
    ]);
    const app = await buildApp();

    const { status, body } = await getJson(app, "/api/edges?sport=baseball_mlb");

    expect(status).toBe(502);
    expect((body as { error: string }).error).toMatch(/try again/i);
  });
});
