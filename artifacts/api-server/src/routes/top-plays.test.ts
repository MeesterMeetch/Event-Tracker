import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubFetchRoutes } from "../lib/__fixtures__/index";

/**
 * Guards the cross-sport fan-out: the /top-plays route.
 *
 * The failure modes worth defending against here are not crashes. They are the
 * quiet ones. A sport silently dropped from the pool looks identical to a quiet
 * board. An upstream outage dressed up as an empty pick list tells the user to
 * sit out a day when in fact nothing was measured. And because every sport is a
 * separate billed scan, a regression in how the sport list is capped turns one
 * button press into a bill.
 *
 * These run the real route against a stubbed Odds API.
 */

const SPORTS_LIST = [
  { key: "baseball_mlb", group: "Baseball", title: "MLB", description: "", active: true, has_outrights: false },
  { key: "basketball_nba", group: "Basketball", title: "NBA", description: "", active: true, has_outrights: false },
  { key: "icehockey_nhl", group: "Ice Hockey", title: "NHL", description: "", active: true, has_outrights: false },
  { key: "soccer_epl", group: "Soccer", title: "EPL", description: "", active: true, has_outrights: false },
];

const SPORTS_ROUTE = { contains: "all=false", payload: SPORTS_LIST };

/** The free event listing for a sport. Matched ahead of that sport's odds URL. */
function listing(sport: string, commenceTimes: string[]) {
  return {
    contains: `${sport}/events`,
    payload: commenceTimes.map((t, i) => ({
      id: `${sport}-ev${i}`,
      sport_key: sport,
      commence_time: t,
      home_team: "Home",
      away_team: "Away",
    })),
  };
}

beforeEach(() => {
  vi.resetModules();
  process.env.ODDS_API_KEY = "test-odds-key";
  // The allowlist must be the production default, not vitest.setup's "all",
  // because which books may set the best price changes every EV number here.
  process.env.BETTABLE_BOOKS = "draftkings,fanduel,betmgm";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BETTABLE_BOOKS;
});

/**
 * Fixtures commence relative to now rather than at a fixed date. The route
 * bounds the pool by commence time, so a hardcoded timestamp would quietly
 * fall out of the default window once real time passed it and every
 * assertion here would start failing for a reason unrelated to the code.
 */
const SOON = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
const NEXT_MONTH = new Date(Date.now() + 32 * 24 * 60 * 60 * 1000).toISOString();

/**
 * A two-book game with a deliberately generous price at a bettable book, so it
 * clears the 1% floor and gives selectTopPlays something to pick.
 */
function game(
  id: string,
  home: string,
  away: string,
  homePrice: number,
  awayPrice: number,
  commenceTime: string = SOON,
) {
  return {
    id,
    sport_key: "ignored",
    commence_time: commenceTime,
    home_team: home,
    away_team: away,
    bookmakers: ["draftkings", "fanduel", "betmgm", "pinnacle"].map((key) => ({
      key,
      title: key,
      markets: [
        {
          key: "h2h",
          outcomes: [
            // Only DraftKings carries the outlier; the rest quote a tight,
            // normal market so the consensus is not dragged along with it.
            { name: home, price: key === "draftkings" ? homePrice : -110 },
            { name: away, price: key === "draftkings" ? awayPrice : -110 },
          ],
        },
      ],
    })),
  };
}

/** A slate where every price is standard, so nothing can clear the floor. */
function efficientGame(id: string) {
  return game(id, `${id} Home`, `${id} Away`, -110, -110);
}

async function buildApp(): Promise<Express> {
  const { default: topPlaysRouter } = await import("./top-plays");
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
  app.use("/api", topPlaysRouter);
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

function oddsCalls(): string[] {
  const stub = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
  return stub.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/odds"));
}

describe("GET /top-plays", () => {
  it("scans each requested sport exactly once and pools the results", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      { contains: "baseball_mlb/odds", payload: [game("mlb-1", "Yankees", "Red Sox", 145, -190)] },
      { contains: "basketball_nba/odds", payload: [game("nba-1", "Nuggets", "Lakers", 150, -195)] },
    ]);

    const { status, body } = await getJson(
      await buildApp(),
      "/api/top-plays?sports=baseball_mlb,basketball_nba",
    );

    expect(status).toBe(200);
    expect(oddsCalls()).toHaveLength(2);
    expect(body.sportsScanned.sort()).toEqual(["baseball_mlb", "basketball_nba"]);
    expect(body.sportsFailed).toEqual([]);
    // Both sports reached the pool, which is what the summary is computed over.
    expect(body.summary.sportsRepresented).toBe(2);
    expect(body.picks.length).toBeGreaterThan(0);
  });

  it("treats an efficient board as a normal 200 with an empty list, not an error", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      { contains: "baseball_mlb/odds", payload: [efficientGame("mlb-1"), efficientGame("mlb-2")] },
    ]);

    const { status, body } = await getJson(await buildApp(), "/api/top-plays?sports=baseball_mlb");

    expect(status).toBe(200);
    expect(body.picks).toEqual([]);
    // The summary still has to say something true about the day. An empty list
    // with an empty summary would be indistinguishable from a broken scan.
    expect(body.summary.totalEdges).toBeGreaterThan(0);
    expect(body.summary.interpretation).toContain("Nothing on the board clears the bar");
  });

  it("reports a failed sport rather than silently shrinking the board", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      { contains: "baseball_mlb/odds", payload: [game("mlb-1", "Yankees", "Red Sox", 145, -190)] },
      { contains: "basketball_nba/odds", payload: {}, status: 500 },
    ]);

    const { status, body } = await getJson(
      await buildApp(),
      "/api/top-plays?sports=baseball_mlb,basketball_nba",
    );

    expect(status).toBe(200);
    expect(body.sportsScanned).toEqual(["baseball_mlb"]);
    expect(body.sportsFailed).toHaveLength(1);
    expect(body.sportsFailed[0].sport).toBe("basketball_nba");
    expect(body.sportsFailed[0].reason).toBeTruthy();
  });

  it("fails loudly when every sport fails, instead of implying a quiet day", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      { contains: "baseball_mlb/odds", payload: {}, status: 500 },
      { contains: "basketball_nba/odds", payload: {}, status: 500 },
    ]);

    const { status, body } = await getJson(
      await buildApp(),
      "/api/top-plays?sports=baseball_mlb,basketball_nba",
    );

    expect(status).toBe(502);
    expect(body.error).toContain("Every sport failed");
  });

  it("caps how many sports it will scan, because each one is billed", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      { contains: "/odds", payload: [game("g-1", "Home", "Away", 145, -190)] },
    ]);

    const { status } = await getJson(
      await buildApp(),
      "/api/top-plays?sports=baseball_mlb,basketball_nba,icehockey_nhl,soccer_epl&maxSports=2",
    );

    expect(status).toBe(200);
    expect(oddsCalls()).toHaveLength(2);
  });

  it("refuses to exceed the absolute ceiling however large maxSports is", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      { contains: "/odds", payload: [game("g-1", "Home", "Away", 145, -190)] },
    ]);

    const many = Array.from({ length: 30 }, (_, i) => `sport_${i}`).join(",");
    const { status } = await getJson(
      await buildApp(),
      `/api/top-plays?sports=${many}&maxSports=999`,
    );

    expect(status).toBe(200);
    expect(oddsCalls().length).toBeLessThanOrEqual(12);
  });

  it("falls back to the in-season list when no sports are named", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      { contains: "/odds", payload: [game("g-1", "Home", "Away", 145, -190)] },
    ]);

    const { status, body } = await getJson(await buildApp(), "/api/top-plays");

    expect(status).toBe(200);
    // All four in-season sports from the stub, none invented.
    expect(body.sportsScanned.length).toBe(4);
    for (const s of body.sportsScanned) {
      expect(SPORTS_LIST.map((x) => x.key)).toContain(s);
    }
  });

  it("honours limit and lets the caller widen or tighten the EV floor", async () => {
    const slate = [
      game("g-1", "A Home", "A Away", 145, -190),
      game("g-2", "B Home", "B Away", 150, -195),
      game("g-3", "C Home", "C Away", 155, -200),
    ];
    stubFetchRoutes([SPORTS_ROUTE, { contains: "/odds", payload: slate }]);

    const { body } = await getJson(
      await buildApp(),
      "/api/top-plays?sports=baseball_mlb&limit=2",
    );
    expect(body.picks.length).toBeLessThanOrEqual(2);
    expect(body.picks.map((p: any) => p.rank)).toEqual(
      body.picks.map((_: unknown, i: number) => i + 1),
    );
  });

  it("stamps when the fan-out ran, since these prices go stale in minutes", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      { contains: "/odds", payload: [game("g-1", "Home", "Away", 145, -190)] },
    ]);

    const { body } = await getJson(await buildApp(), "/api/top-plays?sports=baseball_mlb");
    expect(Number.isNaN(Date.parse(body.scannedAt))).toBe(false);
  });

  it("rejects a sports parameter that names nothing", async () => {
    stubFetchRoutes([SPORTS_ROUTE]);
    const { status } = await getJson(await buildApp(), "/api/top-plays?sports=,,,");
    expect(status).toBe(400);
    expect(oddsCalls()).toHaveLength(0);
  });

  /**
   * The feed returns every upcoming event in a sport, not just today's. In
   * August that means September football arrives in the same list as tonight's
   * baseball, and since a play is ranked on confidence and EV rather than on
   * when it starts, a game five weeks out can outrank the whole live board.
   * "Top plays of the day" has to mean the day.
   */
  it("drops games outside the window and says how many it dropped", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      {
        contains: "baseball_mlb/odds",
        payload: [
          game("today", "Brewers", "Pirates", 145, -190),
          game("september", "Chiefs", "Ravens", 150, -195, NEXT_MONTH),
        ],
      },
    ]);

    const start = new Date(Date.now() - 60_000).toISOString();
    const end = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const { status, body } = await getJson(
      await buildApp(),
      `/api/top-plays?sports=baseball_mlb&startTime=${encodeURIComponent(start)}&endTime=${encodeURIComponent(end)}`,
    );

    expect(status).toBe(200);
    const ids = body.picks.map((p: any) => p.edge.gameId);
    expect(ids).toContain("today");
    expect(ids).not.toContain("september");
    expect(body.edgesOutsideWindow).toBeGreaterThan(0);
    expect(body.windowStart).toBe(start);
    expect(body.windowEnd).toBe(end);
  });

  /**
   * The summary is the part a user is told to read first, so it has to describe
   * the same board the picks came from. Summarising the unfiltered pool would
   * report a busy slate on an evening with two games left.
   */
  it("summarises only the window, not the rest of the season", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      {
        contains: "baseball_mlb/odds",
        payload: [
          game("today", "Brewers", "Pirates", 145, -190),
          game("later-1", "Chiefs", "Ravens", 150, -195, NEXT_MONTH),
          game("later-2", "Bills", "Jets", 150, -195, NEXT_MONTH),
        ],
      },
    ]);

    const start = new Date(Date.now() - 60_000).toISOString();
    const end = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const { body } = await getJson(
      await buildApp(),
      `/api/top-plays?sports=baseball_mlb&startTime=${encodeURIComponent(start)}&endTime=${encodeURIComponent(end)}`,
    );

    expect(body.summary.gamesRepresented).toBe(1);
  });

  it("excludes a game that has already started", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      {
        contains: "baseball_mlb/odds",
        payload: [
          game(
            "underway",
            "Brewers",
            "Pirates",
            145,
            -190,
            new Date(Date.now() - 30 * 60 * 1000).toISOString(),
          ),
        ],
      },
    ]);

    const { status, body } = await getJson(await buildApp(), "/api/top-plays?sports=baseball_mlb");

    expect(status).toBe(200);
    expect(body.picks).toEqual([]);
    expect(body.edgesOutsideWindow).toBeGreaterThan(0);
  });

  it("rejects a window that ends before it starts", async () => {
    stubFetchRoutes([SPORTS_ROUTE]);
    const start = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const end = new Date(Date.now()).toISOString();
    const { status, body } = await getJson(
      await buildApp(),
      `/api/top-plays?sports=baseball_mlb&startTime=${encodeURIComponent(start)}&endTime=${encodeURIComponent(end)}`,
    );
    expect(status).toBe(400);
    expect(String(body.error)).toContain("after startTime");
  });

  it("rejects an unparseable startTime rather than silently scanning everything", async () => {
    stubFetchRoutes([SPORTS_ROUTE]);
    const { status } = await getJson(
      await buildApp(),
      "/api/top-plays?sports=baseball_mlb&startTime=not-a-date",
    );
    expect(status).toBe(400);
  });

  /**
   * Listing a sport's events is free; only its odds are billed. Without this
   * pre-pass the fan-out pays six credits for NFL in August purely to learn it
   * has no game tonight, which on a summer slate is most of the spend.
   */
  it("skips a sport with nothing in the window without spending a credit", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      listing("baseball_mlb", [SOON]),
      listing("basketball_nba", [NEXT_MONTH]),
      { contains: "baseball_mlb/odds", payload: [game("mlb-1", "Yankees", "Red Sox", 145, -190)] },
      { contains: "basketball_nba/odds", payload: [game("nba-1", "Nuggets", "Lakers", 150, -195)] },
    ]);

    const { status, body } = await getJson(
      await buildApp(),
      "/api/top-plays?sports=baseball_mlb,basketball_nba",
    );

    expect(status).toBe(200);
    expect(oddsCalls()).toHaveLength(1);
    expect(oddsCalls()[0]).toContain("baseball_mlb");
    expect(body.sportsScanned).toEqual(["baseball_mlb"]);
    // Reported rather than silently dropped, so an absent sport reads as "no
    // games tonight" instead of looking like a bug.
    expect(body.sportsSkipped).toEqual(["basketball_nba"]);
  });

  /**
   * A failed free call is not evidence of an empty board. Dropping a sport on
   * one would turn a listing hiccup into a silently smaller slate, which is the
   * failure mode this whole route is built to avoid.
   */
  it("keeps a sport whose free listing fails rather than dropping it", async () => {
    stubFetchRoutes([
      SPORTS_ROUTE,
      { contains: "baseball_mlb/events", status: 500, payload: { message: "listing down" } },
      { contains: "baseball_mlb/odds", payload: [game("mlb-1", "Yankees", "Red Sox", 145, -190)] },
    ]);

    const { status, body } = await getJson(await buildApp(), "/api/top-plays?sports=baseball_mlb");

    expect(status).toBe(200);
    expect(oddsCalls()).toHaveLength(1);
    expect(body.sportsScanned).toEqual(["baseball_mlb"]);
    expect(body.sportsSkipped).toEqual([]);
  });
});
