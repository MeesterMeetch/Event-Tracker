import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture, stubFetchRoutes } from "../lib/__fixtures__/index";

/**
 * Guards the free upcoming-games list the UI drives off: the /events route. It
 * lists a sport's upcoming games via the free Odds API events endpoint. A
 * regression here wouldn't crash — it would silently drop games from the slate,
 * misorder them, or turn an upstream failure into a broken/empty result. These
 * tests run the real route against stubbed Odds API payloads.
 *
 * Two upstream endpoints are involved: the free /sports lookup (validates the
 * sport, matched by `all=false`) and the free /sports/<key>/events list
 * (matched by `/events`). The test's own request to the server uses node:http,
 * so stubbing global `fetch` only intercepts the route's upstream calls.
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
  const { default: eventsRouter } = await import("./events");
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
  app.use("/api", eventsRouter);
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

describe("GET /events", () => {
  it("lists every upcoming game for the sport, sorted by start time, without dropping any", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      { contains: "/events", payload: loadFixture("events-mlb.json") },
    ]);
    const app = await buildApp();

    const { status, body } = await getJson(app, "/api/events?sport=baseball_mlb");

    expect(status).toBe(200);
    const events = body as Array<Record<string, unknown>>;

    // All three fixture games survive — none silently dropped.
    expect(events.map((e) => e.id)).toEqual(["evt-mlb-1", "evt-mlb-2", "evt-mlb-3"]);

    // The fixture is out of chronological order; the route must sort ascending.
    const times = events.map((e) => e.commenceTime as string);
    expect([...times]).toEqual([...times].sort());

    // Each game maps the upstream shape to the API contract.
    expect(events[0]).toMatchObject({
      id: "evt-mlb-1",
      sport: "baseball_mlb",
      homeTeam: "New York Yankees",
      awayTeam: "Boston Red Sox",
    });
  });

  it("hits the free events endpoint for the requested sport", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      { contains: "/events", payload: loadFixture("events-mlb.json") },
    ]);
    const app = await buildApp();

    await getJson(app, "/api/events?sport=baseball_mlb");

    const eventCalls = upstreamUrls().filter((u) => u.includes("/events"));
    expect(eventCalls).toHaveLength(1);
    expect(new URL(eventCalls[0]).pathname).toContain("/sports/baseball_mlb/events");
  });

  it("rejects a sport the Odds API doesn't list", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      { contains: "/events", payload: loadFixture("events-mlb.json") },
    ]);
    const app = await buildApp();

    const { status, body } = await getJson(app, "/api/events?sport=cricket_ipl");

    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/unsupported sport/i);
    // The events list must never run for an unsupported sport.
    expect(upstreamUrls().some((u) => u.includes("/events"))).toBe(false);
  });

  it("returns an empty slate (not an error) when there are no upcoming games", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      { contains: "/events", payload: [] },
    ]);
    const app = await buildApp();

    const { status, body } = await getJson(app, "/api/events?sport=baseball_mlb");

    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it("fails cleanly (502) instead of crashing when the upstream errors", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      { contains: "/events", payload: {}, status: 500 },
    ]);
    const app = await buildApp();

    const { status, body } = await getJson(app, "/api/events?sport=baseball_mlb");

    expect(status).toBe(502);
    expect((body as { error: string }).error).toMatch(/try again/i);
  });
});
