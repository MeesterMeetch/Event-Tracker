import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb, stubDrizzleOrm, type FakeDbModule } from "../lib/__fixtures__/fake-db";

/**
 * Guards the model-validation paper-trade routes. The summary route scores the
 * model's picks (beat-the-close rate, average CLV); a regression wouldn't crash
 * — it would misreport how the model is doing, e.g. by counting ungraded flags
 * (no closing line captured) as losses, or by returning NaN on an empty book.
 * The create route is the front line against bad data corrupting those stats,
 * so its guards are exercised too. Runs the real routes against an in-memory db
 * stand-in.
 */

vi.mock("drizzle-orm", async () => stubDrizzleOrm());
vi.mock("@workspace/db", () => makeFakeDb());

let dbMod: FakeDbModule;

beforeEach(async () => {
  dbMod = (await import("@workspace/db")) as unknown as FakeDbModule;
  dbMod.__reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function buildApp(): Promise<Express> {
  const { default: paperTradesRouter } = await import("./paper-trades");
  const app = express();
  app.use(express.json());
  app.use("/api", paperTradesRouter);
  return app;
}

type Method = "GET" | "POST" | "DELETE";

async function request(
  app: Express,
  method: Method,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path,
          method,
          headers: payload
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {},
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null }),
          );
        },
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function seedTrade(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return dbMod.__seedPaperTrade({
    sport: "baseball_mlb",
    gameId: "evt-mlb-1",
    commenceTime: new Date("2026-07-10T18:00:00Z"),
    homeTeam: "Los Angeles Dodgers",
    awayTeam: "San Francisco Giants",
    pitcher: "Blake Snell",
    pitcherId: 605483,
    team: "Los Angeles Dodgers",
    opponent: "San Francisco Giants",
    selection: "Over",
    point: 6.5,
    book: "FanDuel",
    americanOdds: -110,
    modelProb: 0.6,
    marketProb: 0.52,
    edgePercent: null,
    expectedStrikeouts: 7.2,
    projectedBattersFaced: 25,
    recommendedUnits: 1,
    kellyMultiplier: 0.25,
    status: "open",
    ...overrides,
  });
}

const PT_BODY = {
  sport: "baseball_mlb",
  gameId: "evt-mlb-9",
  commenceTime: "2026-07-15T18:00:00Z",
  homeTeam: "Los Angeles Dodgers",
  awayTeam: "San Francisco Giants",
  pitcher: "Blake Snell",
  pitcherId: 605483,
  team: "Los Angeles Dodgers",
  opponent: "San Francisco Giants",
  selection: "Over",
  point: 6.5,
  book: "FanDuel",
  americanOdds: -110,
  modelProb: 0.6,
  marketProb: 0.52,
  edgePercent: 8,
  expectedStrikeouts: 7.2,
  projectedBattersFaced: 25,
  recommendedUnits: 1,
  kellyMultiplier: 0.25,
};

describe("POST /paper-trades — guards against stat-corrupting bad data", () => {
  it("logs a valid flag as open", async () => {
    const app = await buildApp();

    const { status, body } = await request(app, "POST", "/api/paper-trades", PT_BODY);

    expect(status).toBe(201);
    expect((body as { status: string }).status).toBe("open");
    expect(dbMod.__stores.pitcher_k_paper_trades).toHaveLength(1);
  });

  it("rejects odds of 0 with a 400 and never inserts", async () => {
    const app = await buildApp();

    const { status } = await request(app, "POST", "/api/paper-trades", { ...PT_BODY, americanOdds: 0 });

    expect(status).toBe(400);
    expect(dbMod.__stores.pitcher_k_paper_trades).toHaveLength(0);
  });

  it("rejects an out-of-range probability that would corrupt CLV math", async () => {
    const app = await buildApp();

    const { status, body } = await request(app, "POST", "/api/paper-trades", { ...PT_BODY, modelProb: 1.4 });

    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/between 0 and 1/i);
    expect(dbMod.__stores.pitcher_k_paper_trades).toHaveLength(0);
  });

  it("409s a duplicate pick instead of inflating the scorecard with a second row", async () => {
    const app = await buildApp();

    const first = await request(app, "POST", "/api/paper-trades", PT_BODY);
    const second = await request(app, "POST", "/api/paper-trades", PT_BODY);

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect((second.body as { error: string }).error).toMatch(/already logged/i);
    expect(dbMod.__stores.pitcher_k_paper_trades).toHaveLength(1);
  });

  it("409s a re-log even after the original pick was graded and closed", async () => {
    // Same pick as PT_BODY but already closed with a captured closing line —
    // re-logging it would add a second graded row to the scorecard.
    seedTrade({ gameId: PT_BODY.gameId, status: "closed", clvPercent: 4, beatClose: true });
    const app = await buildApp();

    const { status } = await request(app, "POST", "/api/paper-trades", PT_BODY);

    expect(status).toBe(409);
    expect(dbMod.__stores.pitcher_k_paper_trades).toHaveLength(1);
  });

  it("still accepts the same line at a different book or point", async () => {
    const app = await buildApp();

    const base = await request(app, "POST", "/api/paper-trades", PT_BODY);
    const otherBook = await request(app, "POST", "/api/paper-trades", { ...PT_BODY, book: "DraftKings" });
    const otherPoint = await request(app, "POST", "/api/paper-trades", { ...PT_BODY, point: 7.5 });

    expect(base.status).toBe(201);
    expect(otherBook.status).toBe(201);
    expect(otherPoint.status).toBe(201);
    expect(dbMod.__stores.pitcher_k_paper_trades).toHaveLength(3);
  });
});

describe("GET /paper-trades/summary — scores only what's actually graded", () => {
  it("computes beat-close and CLV from graded trades and ignores ungraded ones", async () => {
    // Two graded closed trades (closing line captured): one beat the close, one didn't.
    seedTrade({ status: "closed", clvPercent: 5, beatClose: true, edgePercent: 10 });
    seedTrade({ status: "closed", clvPercent: -2, beatClose: false, edgePercent: 10 });
    // A closed trade whose closing line was never captured — must NOT count as a loss.
    seedTrade({ status: "closed", clvPercent: null, beatClose: null, edgePercent: null });
    // Still-open and expired flags.
    seedTrade({ status: "open" });
    seedTrade({ status: "expired", clvPercent: null, beatClose: null });
    const app = await buildApp();

    const { status, body } = await request(app, "GET", "/api/paper-trades/summary");

    expect(status).toBe(200);
    const s = body as Record<string, number | null>;
    expect(s.total).toBe(5);
    expect(s.open).toBe(1);
    expect(s.closed).toBe(3);
    expect(s.expired).toBe(1);
    // Only the two rows with a captured closing line are graded.
    expect(s.gradedCount).toBe(2);
    expect(s.beatCloseCount).toBe(1);
    expect(s.beatCloseRate).toBe(0.5);
    // avg of +5 and -2
    expect(s.avgClvPercent).toBe(1.5);
    // avg of the two rows carrying an edge
    expect(s.avgEdgePercent).toBe(10);
  });

  it("returns null rates (not NaN) when nothing has been graded", async () => {
    const app = await buildApp();

    const { status, body } = await request(app, "GET", "/api/paper-trades/summary");

    expect(status).toBe(200);
    const s = body as Record<string, number | null>;
    expect(s.total).toBe(0);
    expect(s.gradedCount).toBe(0);
    expect(s.beatCloseRate).toBeNull();
    expect(s.avgClvPercent).toBeNull();
    expect(s.avgEdgePercent).toBeNull();
  });
});

describe("GET /paper-trades", () => {
  it("filters by status", async () => {
    seedTrade({ status: "open" });
    seedTrade({ status: "closed", clvPercent: 3, beatClose: true });
    const app = await buildApp();

    const { status, body } = await request(app, "GET", "/api/paper-trades?status=closed");

    expect(status).toBe(200);
    const rows = body as Array<{ status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("closed");
  });
});

describe("DELETE /paper-trades/:id", () => {
  it("deletes an existing trade", async () => {
    seedTrade({ id: 1 });
    const app = await buildApp();

    const { status } = await request(app, "DELETE", "/api/paper-trades/1");

    expect(status).toBe(204);
    expect(dbMod.__stores.pitcher_k_paper_trades).toHaveLength(0);
  });

  it("404s when the trade doesn't exist", async () => {
    const app = await buildApp();

    const { status } = await request(app, "DELETE", "/api/paper-trades/999");

    expect(status).toBe(404);
  });

  it("400s on a non-integer id", async () => {
    const app = await buildApp();

    const { status } = await request(app, "DELETE", "/api/paper-trades/abc");

    expect(status).toBe(400);
  });
});
