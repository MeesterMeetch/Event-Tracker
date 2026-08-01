import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture, stubFetchRoutes } from "../lib/__fixtures__/index";

/**
 * Guards the MLB games schedule route: GET /mlb/games?date=YYYY-MM-DD.
 * A regression here wouldn't crash — it would silently drop games, misorder
 * them, lose score data, or accept a malformed date. These tests run the real
 * route against a stubbed MLB Stats API fixture.
 */

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function buildApp(): Promise<Express> {
  const { default: mlbRouter } = await import("./mlb");
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
  app.use("/api", mlbRouter);
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

function upstreamUrls(): string[] {
  const stub = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
  return stub.mock.calls.map((call) => String(call[0]));
}

describe("GET /mlb/games", () => {
  it("returns all games for the date sorted by start time, with scores and pitchers", async () => {
    stubFetchRoutes([
      { contains: "/schedule", payload: loadFixture("schedule-mlb-games.json") },
    ]);
    const app = await buildApp();

    const { status, body } = await getJson(app, "/api/mlb/games?date=2026-07-18");

    expect(status).toBe(200);
    const games = body as Array<Record<string, unknown>>;

    // All three fixture games survive.
    expect(games).toHaveLength(3);

    // Sorted by gameDate ascending — Final game first, then Live, then Scheduled.
    const pks = games.map((g) => g.gamePk);
    expect(pks).toEqual([800001, 800002, 800003]);

    // Final game: scores present, both pitchers present.
    const final = games[0] as Record<string, unknown>;
    expect(final.homeTeam).toBe("Los Angeles Dodgers");
    expect(final.awayTeam).toBe("San Francisco Giants");
    expect(final.homeScore).toBe(5);
    expect(final.awayScore).toBe(3);
    expect((final.homeProbablePitcher as Record<string, unknown>).name).toBe("Blake Snell");
    expect((final.awayProbablePitcher as Record<string, unknown>).name).toBe("Logan Webb");
    expect((final.status as Record<string, unknown>).abstractGameState).toBe("Final");

    // Live game: scores present.
    const live = games[1] as Record<string, unknown>;
    expect(live.homeScore).toBe(1);
    expect(live.awayScore).toBe(2);
    expect((live.status as Record<string, unknown>).abstractGameState).toBe("Live");

    // Scheduled game: no scores, away pitcher absent, home pitcher present.
    const scheduled = games[2] as Record<string, unknown>;
    expect(scheduled.homeScore).toBeNull();
    expect(scheduled.awayScore).toBeNull();
    expect(scheduled.awayProbablePitcher).toBeNull();
    expect((scheduled.homeProbablePitcher as Record<string, unknown>).name).toBe("Patrick Sandoval");
    expect((scheduled.status as Record<string, unknown>).detailedState).toBe("Scheduled");
  });

  it("hits the MLB Stats API with the correct date and hydrate params", async () => {
    stubFetchRoutes([
      { contains: "/schedule", payload: loadFixture("schedule-mlb-games.json") },
    ]);
    const app = await buildApp();

    await getJson(app, "/api/mlb/games?date=2026-07-18");

    const scheduleCalls = upstreamUrls().filter((u) => u.includes("/schedule"));
    expect(scheduleCalls).toHaveLength(1);
    const url = new URL(scheduleCalls[0]);
    expect(url.searchParams.get("date")).toBe("2026-07-18");
    expect(url.searchParams.get("sportId")).toBe("1");
    expect(url.searchParams.get("hydrate")).toContain("probablePitcher");
    expect(url.searchParams.get("hydrate")).toContain("linescore");
  });

  it("returns an empty array (not an error) when there are no games", async () => {
    stubFetchRoutes([
      { contains: "/schedule", payload: { dates: [] } },
    ]);
    const app = await buildApp();

    const { status, body } = await getJson(app, "/api/mlb/games?date=2026-07-18");

    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it("returns 400 when date param is missing", async () => {
    const app = await buildApp();

    const { status, body } = await getJson(app, "/api/mlb/games");

    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/YYYY-MM-DD/i);
  });

  it("returns 400 for a malformed date (wrong format)", async () => {
    const app = await buildApp();

    const { status, body } = await getJson(app, "/api/mlb/games?date=July-18-2026");

    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/YYYY-MM-DD/i);
  });

  it("returns 502 when the MLB Stats API errors", async () => {
    stubFetchRoutes([
      { contains: "/schedule", payload: {}, status: 503 },
    ]);
    const app = await buildApp();

    const { status, body } = await getJson(app, "/api/mlb/games?date=2026-07-18");

    expect(status).toBe(502);
    expect((body as { error: string }).error).toMatch(/try again/i);
  });
});
