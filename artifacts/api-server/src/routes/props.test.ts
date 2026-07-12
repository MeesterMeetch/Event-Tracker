import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture, stubFetchRoutes } from "../lib/__fixtures__/index";
import { getPropMarkets } from "../lib/props";

/**
 * Guards the paid layer that drives the prop math: the /prop-edges route. Each
 * request makes a per-event Odds API call that is charged per market x region,
 * so a regression here wouldn't crash — it would quietly over-request markets
 * (burning credits), fetch props for a sport that has none, or drop games. The
 * only free call is the /sports lookup used to validate the sport; the paid
 * per-event call goes to /events/<id>/odds.
 *
 * Same mock-fetch fixture approach as rankings.test.ts: the real route runs
 * against stubbed Odds API payloads. The HTTP client is node:http (not global
 * fetch), so stubbing `fetch` only intercepts the route's upstream calls, never
 * the test's own request to the server.
 */

// Live /sports lookup (free) — decides which keys isSupportedSport accepts.
// MLB has props; soccer_epl is a real in-season sport with no prop markets.
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
  const { default: propsRouter } = await import("./props");
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
  app.use("/api", propsRouter);
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

describe("GET /prop-edges", () => {
  it("requests exactly the sport's supported prop markets — no extras that would burn credits", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      { contains: "/events/", payload: loadFixture("prop-event-mlb.json") },
    ]);
    const app = await buildApp();

    const { status } = await getJson(app, "/api/prop-edges?sport=baseball_mlb&eventId=evt-mlb-1");
    expect(status).toBe(200);

    const eventCalls = upstreamUrls().filter((u) => u.includes("/events/"));
    // Exactly one paid per-event call for the one game.
    expect(eventCalls).toHaveLength(1);

    const requested = new URL(eventCalls[0]).searchParams.get("markets");
    // The markets param must be precisely getPropMarkets(sport) — no more, no
    // fewer — since every extra market x region is a wasted credit.
    expect(requested).toBe(getPropMarkets("baseball_mlb")!.join(","));
    expect(new URL(eventCalls[0]).searchParams.get("regions")).toBe("us");
  });

  it("returns the positive-EV props found for the game", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      { contains: "/events/", payload: loadFixture("prop-event-mlb.json") },
    ]);
    const app = await buildApp();

    const { status, body } = await getJson(app, "/api/prop-edges?sport=baseball_mlb&eventId=evt-mlb-1");

    expect(status).toBe(200);
    const edges = body as Array<Record<string, unknown>>;
    expect(edges.length).toBeGreaterThan(0);
    // Two books quote Gerrit Cole's strikeout O/U; FanDuel's +120 Over beats the
    // devigged consensus, so it surfaces as an edge on the best-priced book.
    const overEdge = edges.find((e) => e.selection === "Over");
    expect(overEdge).toMatchObject({
      market: "pitcher_strikeouts",
      player: "Gerrit Cole",
      selection: "Over",
      book: "FanDuel",
    });
    expect(overEdge!.evPercent as number).toBeGreaterThan(0);
  });

  it("gates a sport with no prop markets out — never making the paid per-event call", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      // Present but must never be hit: soccer has no prop markets.
      { contains: "/events/", payload: loadFixture("prop-event-mlb.json") },
    ]);
    const app = await buildApp();

    const { status, body } = await getJson(app, "/api/prop-edges?sport=soccer_epl&eventId=evt-epl-1");

    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/not available/i);
    // sportSupportsProps short-circuits before any credit is spent.
    expect(upstreamUrls().some((u) => u.includes("/events/"))).toBe(false);
  });

  it("rejects a sport the Odds API doesn't list without spending a credit", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      { contains: "/events/", payload: loadFixture("prop-event-mlb.json") },
    ]);
    const app = await buildApp();

    const { status, body } = await getJson(app, "/api/prop-edges?sport=cricket_ipl&eventId=evt-x");

    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/unsupported sport/i);
    expect(upstreamUrls().some((u) => u.includes("/events/"))).toBe(false);
  });

  it("returns an empty slate (not an error) when the game has no prop data", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      {
        contains: "/events/",
        payload: {
          id: "evt-mlb-1",
          sport_key: "baseball_mlb",
          commence_time: "2026-07-12T23:05:00Z",
          home_team: "New York Yankees",
          away_team: "Boston Red Sox",
          bookmakers: [],
        },
      },
    ]);
    const app = await buildApp();

    const { status, body } = await getJson(app, "/api/prop-edges?sport=baseball_mlb&eventId=evt-mlb-1");

    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it("fails cleanly (502) instead of crashing when the upstream errors for a game", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      { contains: "/events/", payload: {}, status: 500 },
    ]);
    const app = await buildApp();

    const { status, body } = await getJson(app, "/api/prop-edges?sport=baseball_mlb&eventId=evt-mlb-1");

    expect(status).toBe(502);
    expect((body as { error: string }).error).toMatch(/try again/i);
  });
});
