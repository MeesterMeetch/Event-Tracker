import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture, stubFetchRoutes } from "../lib/__fixtures__/index";
import { PITCHER_K_MARKET } from "../lib/pitcher-k-scanner";

/**
 * Guards the route that actually generates the model's betting picks: the
 * /model-edges strikeout projection route. A regression here wouldn't crash —
 * it would emit misleading picks. The specific silent-failure risk is that when
 * the MLB Stats feed degrades, getMatchupKInputs returns zeroed/null inputs
 * (never throwing), so the model could quietly project off the league average
 * instead of abstaining.
 *
 * Two upstreams are stubbed, both via global fetch:
 *  - the paid per-event Odds API call at /events/<id>/odds (the strikeout
 *    market for one game), and
 *  - the free MLB Stats API feeds getMatchupKInputs reads: /schedule (probable
 *    starters), /people/<id> (pitcher K stats), and /teams/<id>/stats (lineup
 *    K% splits).
 * The test's own request to the server uses node:http, so stubbing global
 * `fetch` only intercepts the route's upstream calls.
 *
 * The schedule fixture pairs the Dodgers (Blake Snell) at home with the Giants
 * (Logan Webb) away; the event fixture quotes both starters' strikeout O/U so
 * the assembled inputs and the market lines line up by pitcher name.
 */

// MLB Stats feeds getMatchupKInputs reads for the Dodgers/Giants matchup.
const MLB_FEED_ROUTES = [
  { contains: "/schedule", payload: loadFixture("schedule-mlb-probable.json") },
  { contains: "/people/605483", payload: loadFixture("people-kstats-snell.json") },
  { contains: "/people/657277", payload: loadFixture("people-kstats-webb.json") },
  { contains: "/teams/137/stats", payload: loadFixture("team-kprofile-giants.json") },
  { contains: "/teams/119/stats", payload: loadFixture("team-kprofile-dodgers.json") },
];

beforeEach(() => {
  // Fresh module graph per test so the mlb K-inputs in-memory cache never leaks
  // one test's feed payloads into the next.
  vi.resetModules();
  process.env.ODDS_API_KEY = "test-odds-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function buildApp(): Promise<Express> {
  const { default: modelEdgesRouter } = await import("./model-edges");
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
  app.use("/api", modelEdgesRouter);
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

/** URLs the route asked the (stubbed) Odds API / MLB feeds for, in call order. */
function upstreamUrls(): string[] {
  const stub = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
  return stub.mock.calls.map((call) => String(call[0]));
}

describe("GET /model-edges", () => {
  it("rejects a non-MLB sport (400) without spending a credit", async () => {
    stubFetchRoutes([
      { contains: "/events/", payload: loadFixture("model-event-mlb.json") },
      ...MLB_FEED_ROUTES,
    ]);
    const app = await buildApp();

    const { status, body } = await getJson(
      app,
      "/api/model-edges?sport=basketball_nba&eventId=evt-mlb-k1",
    );

    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/mlb only/i);
    // The projection model is MLB-only; nothing upstream should be touched.
    expect(upstreamUrls()).toHaveLength(0);
  });

  it("requests exactly the pitcher-strikeouts market for the one event", async () => {
    stubFetchRoutes([
      { contains: "/events/", payload: loadFixture("model-event-mlb.json") },
      ...MLB_FEED_ROUTES,
    ]);
    const app = await buildApp();

    const { status } = await getJson(app, "/api/model-edges?sport=baseball_mlb&eventId=evt-mlb-k1");
    expect(status).toBe(200);

    const eventCalls = upstreamUrls().filter((u) => u.includes("/events/"));
    // Exactly one paid per-event call for the one game.
    expect(eventCalls).toHaveLength(1);

    const url = new URL(eventCalls[0]);
    expect(url.pathname).toContain("/sports/baseball_mlb/events/evt-mlb-k1/odds");
    // Only the strikeout market — no extra markets that would burn credits.
    expect(url.searchParams.get("markets")).toBe(PITCHER_K_MARKET);
    expect(url.searchParams.get("regions")).toBe("us");
    expect(url.searchParams.get("oddsFormat")).toBe("american");
  });

  it("returns computed strikeout projections for a normal event", async () => {
    stubFetchRoutes([
      { contains: "/events/", payload: loadFixture("model-event-mlb.json") },
      ...MLB_FEED_ROUTES,
    ]);
    const app = await buildApp();

    const { status, body } = await getJson(
      app,
      "/api/model-edges?sport=baseball_mlb&eventId=evt-mlb-k1",
    );

    expect(status).toBe(200);
    const projections = body as Array<Record<string, unknown>>;
    // Both probable starters resolved, each with a quoted strikeout line.
    expect(projections.length).toBe(2);

    const snell = projections.find((p) => p.pitcher === "Blake Snell");
    expect(snell).toBeDefined();
    expect(snell!.insufficientData).toBe(false);
    // A real rolling/season/career sample yields a genuine projection, not a
    // zeroed placeholder.
    expect(snell!.expectedStrikeouts as number).toBeGreaterThan(0);
    expect(snell!.ratePerBF as number).toBeGreaterThan(0);
    expect((snell!.lines as unknown[]).length).toBeGreaterThan(0);

    const webb = projections.find((p) => p.pitcher === "Logan Webb");
    expect(webb).toBeDefined();
    expect(webb!.insufficientData).toBe(false);
    expect(webb!.expectedStrikeouts as number).toBeGreaterThan(0);
  });

  it("abstains (no bogus league-average projection) when the MLB stats feed degrades", async () => {
    // The schedule resolves the probable starters, but their per-pitcher stats
    // feed fails. getMatchupKInputs swallows the failure and hands back zeroed
    // rolling stats with null season/career — the exact silent-misfire trap.
    // The model must surface insufficient data, not a confident number.
    stubFetchRoutes([
      { contains: "/events/", payload: loadFixture("model-event-mlb.json") },
      { contains: "/schedule", payload: loadFixture("schedule-mlb-probable.json") },
      { contains: "/people/", payload: {}, status: 500 },
      { contains: "/teams/", payload: {}, status: 500 },
    ]);
    const app = await buildApp();

    const { status, body } = await getJson(
      app,
      "/api/model-edges?sport=baseball_mlb&eventId=evt-mlb-k1",
    );

    expect(status).toBe(200);
    const projections = body as Array<Record<string, unknown>>;
    // Both starters surface, but flagged as insufficient data — never a
    // projection dressed up off zeroed inputs.
    expect(projections.length).toBeGreaterThan(0);
    for (const proj of projections) {
      expect(proj.insufficientData).toBe(true);
      expect(proj.lines).toEqual([]);
      // No misleadingly precise numbers leak through.
      expect(proj.expectedStrikeouts).toBe(0);
      expect(proj.ratePerBF).toBe(0);
    }
  });

  it("returns an empty result (not an error) when the event has no strikeout market", async () => {
    stubFetchRoutes([
      {
        contains: "/events/",
        payload: {
          id: "evt-mlb-k1",
          sport_key: "baseball_mlb",
          commence_time: "2025-07-02T02:10:00Z",
          home_team: "Los Angeles Dodgers",
          away_team: "San Francisco Giants",
          bookmakers: [],
        },
      },
      ...MLB_FEED_ROUTES,
    ]);
    const app = await buildApp();

    const { status, body } = await getJson(
      app,
      "/api/model-edges?sport=baseball_mlb&eventId=evt-mlb-k1",
    );

    // Starters resolve fine, but with no lines to compare against there's
    // nothing to project — an empty list, not a crash.
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it("fails cleanly (502) instead of crashing when the Odds API errors", async () => {
    stubFetchRoutes([
      { contains: "/events/", payload: {}, status: 500 },
      ...MLB_FEED_ROUTES,
    ]);
    const app = await buildApp();

    const { status, body } = await getJson(
      app,
      "/api/model-edges?sport=baseball_mlb&eventId=evt-mlb-k1",
    );

    expect(status).toBe(502);
    expect((body as { error: string }).error).toMatch(/try again/i);
  });
});
