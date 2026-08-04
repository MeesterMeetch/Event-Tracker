import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture, stubFetchRoutes } from "../lib/__fixtures__/index";

/**
 * Guards the slate-wide strikeout scan.
 *
 * The risks here are the quiet ones, same as the game-line fan-out. A game
 * dropped from the board looks identical to a model that likes nothing. An
 * upstream outage returning an empty list tells you to sit out a slate that was
 * never measured. And because this bills one credit per event, a regression in
 * how the event list is windowed or capped turns one button press into a bill.
 *
 * Both upstreams are stubbed through global fetch: the free event listing and
 * the paid per-event strikeout market, plus the MLB Stats feeds that
 * getMatchupKInputs reads.
 */

const MLB_FEED_ROUTES = [
  { contains: "/schedule", payload: loadFixture("schedule-mlb-probable.json") },
  { contains: "/people/605483", payload: loadFixture("people-kstats-snell.json") },
  { contains: "/people/657277", payload: loadFixture("people-kstats-webb.json") },
  { contains: "/teams/137/stats", payload: loadFixture("team-kprofile-giants.json") },
  { contains: "/teams/119/stats", payload: loadFixture("team-kprofile-dodgers.json") },
];

const SOON = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
const NEXT_WEEK = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString();

function eventStub(id: string, commence: string = SOON) {
  return {
    id,
    sport_key: "baseball_mlb",
    commence_time: commence,
    home_team: "Los Angeles Dodgers",
    away_team: "San Francisco Giants",
  };
}

/** The free listing call, matched before the paid per-event one. */
const eventsList = (payload: unknown) => ({ contains: "/events?", payload });
const eventOdds = { contains: "/events/", payload: loadFixture("model-event-mlb.json") };

beforeEach(() => {
  // Fresh module graph per test so the MLB K-inputs cache cannot leak between them.
  vi.resetModules();
  process.env.ODDS_API_KEY = "test-odds-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function buildApp(): Promise<Express> {
  const { default: slateRouter } = await import("./model-edges-slate");
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, () => void> }).log = {
      error() {},
      warn() {},
      info() {},
      debug() {},
    };
    next();
  });
  app.use("/api", slateRouter);
  return app;
}

async function getJson(app: Express, path: string): Promise<{ status: number; body: any }> {
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

function paidCalls(): string[] {
  const stub = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
  return stub.mock.calls.map((c) => String(c[0])).filter((u) => /\/events\/[^/]+\/odds/.test(u));
}

describe("GET /model-edges/slate", () => {
  it("scans every game in the window, one billed call each", async () => {
    stubFetchRoutes([
      eventsList([eventStub("g1"), eventStub("g2")]),
      eventOdds,
      ...MLB_FEED_ROUTES,
    ]);

    const { status, body } = await getJson(await buildApp(), "/api/model-edges/slate");

    expect(status).toBe(200);
    expect(paidCalls()).toHaveLength(2);
    expect(body.summary.eventsScanned).toBe(2);
    expect(body.eventsFailed).toEqual([]);
  });

  /**
   * The listing is free and the per-event call is not, so filtering has to
   * happen before the spend rather than after it.
   */
  it("does not spend a credit on a game outside the window", async () => {
    stubFetchRoutes([
      eventsList([eventStub("today"), eventStub("next-week", NEXT_WEEK)]),
      eventOdds,
      ...MLB_FEED_ROUTES,
    ]);

    const { status, body } = await getJson(await buildApp(), "/api/model-edges/slate");

    expect(status).toBe(200);
    expect(paidCalls()).toHaveLength(1);
    expect(paidCalls()[0]).toContain("/events/today/odds");
    expect(body.summary.eventsScanned).toBe(1);
  });

  it("caps how many games it will scan, because each one is billed", async () => {
    stubFetchRoutes([
      eventsList([eventStub("g1"), eventStub("g2"), eventStub("g3"), eventStub("g4")]),
      eventOdds,
      ...MLB_FEED_ROUTES,
    ]);

    const { status } = await getJson(await buildApp(), "/api/model-edges/slate?maxEvents=2");

    expect(status).toBe(200);
    expect(paidCalls()).toHaveLength(2);
  });

  it("ranks by model edge, descending, and numbers the ranks", async () => {
    stubFetchRoutes([eventsList([eventStub("g1")]), eventOdds, ...MLB_FEED_ROUTES]);

    const { status, body } = await getJson(
      await buildApp(),
      "/api/model-edges/slate?minEdgePercent=-100&limit=20",
    );

    expect(status).toBe(200);
    expect(body.plays.length).toBeGreaterThan(0);
    const edges = body.plays.map((p: any) => p.edgePercent);
    expect([...edges].sort((a: number, b: number) => b - a)).toEqual(edges);
    expect(body.plays.map((p: any) => p.rank)).toEqual(
      body.plays.map((_: unknown, i: number) => i + 1),
    );
    // Every ranked line carries the sample behind it, so a thin projection is
    // visible rather than buried in the edge number.
    for (const p of body.plays) expect(typeof p.sampleStarts).toBe("number");
  });

  /**
   * An outage that returns an empty board would read as "the model likes
   * nothing today", which is the most expensive possible way to be wrong.
   */
  it("fails loudly when every game fails, rather than implying a quiet board", async () => {
    stubFetchRoutes([
      eventsList([eventStub("g1"), eventStub("g2")]),
      { contains: "/events/", status: 500, payload: { message: "upstream down" } },
      ...MLB_FEED_ROUTES,
    ]);

    const { status, body } = await getJson(await buildApp(), "/api/model-edges/slate");

    expect(status).toBe(502);
    expect(String(body.error)).toMatch(/every game failed/i);
  });

  it("rejects a window that ends before it starts", async () => {
    stubFetchRoutes([eventsList([]), eventOdds, ...MLB_FEED_ROUTES]);
    const start = new Date(Date.now() + 3600_000).toISOString();
    const end = new Date().toISOString();

    const { status, body } = await getJson(
      await buildApp(),
      `/api/model-edges/slate?startTime=${encodeURIComponent(start)}&endTime=${encodeURIComponent(end)}`,
    );

    expect(status).toBe(400);
    expect(String(body.error)).toContain("after startTime");
  });
});
