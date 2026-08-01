import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb, stubDrizzleOrm, type FakeDbModule } from "../lib/__fixtures__/fake-db";

/**
 * Guards GET /dashboard/summary, the headline performance route the user reads
 * to judge whether they're actually winning: realized P&L, units risked, ROI,
 * and average CLV across every tracked bet. A regression here wouldn't crash —
 * it would quietly show the wrong number (e.g. counting pending stakes as risk,
 * averaging CLV over bets that never captured one, or emitting NaN on an empty
 * book). These tests exercise the real route against an in-memory db stand-in
 * so no live Postgres is touched; the test's own request uses node:http.
 */

vi.mock("drizzle-orm", async () => stubDrizzleOrm());
vi.mock("@workspace/db", () => makeFakeDb());

let dbMod: FakeDbModule;

beforeEach(async () => {
  dbMod = (await import("@workspace/db")) as unknown as FakeDbModule;
  dbMod.__reset();
});

async function buildApp(): Promise<Express> {
  const { default: dashboardRouter } = await import("./dashboard");
  const app = express();
  app.use(express.json());
  app.use("/api", dashboardRouter);
  return app;
}

async function getSummary(app: Express): Promise<{ status: number; body: SummaryBody }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/api/dashboard/summary", method: "GET" },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              body: data ? (JSON.parse(data) as SummaryBody) : (null as unknown as SummaryBody),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

interface SummaryBody {
  totalBets: number;
  won: number;
  lost: number;
  push: number;
  pending: number;
  totalUnits: number;
  pendingUnits: number;
  totalPnl: number;
  roiPercent: number;
  avgClvPercent: number | null;
  clvSampleSize: number;
  bySport: Array<{
    sport: string;
    bets: number;
    won: number;
    lost: number;
    push: number;
    pending: number;
    pendingUnits: number;
    settledUnits: number;
    roiPercent: number;
    pnl: number;
  }>;
}

/** Seeds a bet row with sane defaults; override only what a test cares about. */
function seedBet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return dbMod.__seedBet({
    sport: "baseball_mlb",
    gameId: "evt-1",
    commenceTime: new Date("2026-07-10T18:00:00Z"),
    homeTeam: "New York Yankees",
    awayTeam: "Boston Red Sox",
    market: "h2h",
    selection: "New York Yankees",
    point: null,
    americanOdds: 150,
    units: 1,
    status: "pending",
    pnl: null,
    clvPercent: null,
    createdAt: new Date("2026-07-10T12:00:00Z"),
    ...overrides,
  });
}

describe("GET /dashboard/summary — realized P&L and units", () => {
  it("sums P&L and units only over settled bets, excluding pending stakes", async () => {
    seedBet({ status: "won", pnl: 3, units: 2 });
    seedBet({ status: "lost", pnl: -1.5, units: 1.5 });
    // Pending bet: its stake must NOT count toward units risked, nor its (null) pnl.
    seedBet({ status: "pending", pnl: null, units: 5 });
    const app = await buildApp();

    const { status, body } = await getSummary(app);

    expect(status).toBe(200);
    expect(body.totalPnl).toBe(1.5);
    // 2 + 1.5 from the settled bets only; the pending 5u is excluded.
    expect(body.totalUnits).toBe(3.5);
    // ...but the pending 5u shows up as open exposure.
    expect(body.pendingUnits).toBe(5);
    expect(body.pending).toBe(1);
    expect(body.totalBets).toBe(3);
  });

  it("excludes soft-deleted pending bets from open exposure", async () => {
    seedBet({ status: "pending", pnl: null, units: 3 });
    seedBet({ status: "pending", pnl: null, units: 2, deletedAt: new Date("2026-07-11T00:00:00Z") });
    const app = await buildApp();

    const { body } = await getSummary(app);

    expect(body.pendingUnits).toBe(3);
    expect(body.pending).toBe(1);
  });

  it("excludes a bet whose pnl is still null even if its status is settled", async () => {
    seedBet({ status: "won", pnl: 4, units: 2 });
    // Marked won but pnl not yet booked — must not distort totals.
    seedBet({ status: "won", pnl: null, units: 3 });
    const app = await buildApp();

    const { body } = await getSummary(app);

    expect(body.totalPnl).toBe(4);
    expect(body.totalUnits).toBe(2);
  });

  it("counts a push toward units risked but as zero P&L", async () => {
    seedBet({ status: "push", pnl: 0, units: 2 });
    const app = await buildApp();

    const { body } = await getSummary(app);

    expect(body.totalPnl).toBe(0);
    expect(body.totalUnits).toBe(2);
    expect(body.push).toBe(1);
    // ROI is P&L / units; zero P&L over positive units is 0, not NaN.
    expect(body.roiPercent).toBe(0);
  });

  it("computes ROI as a rounded percentage of P&L over units risked", async () => {
    seedBet({ status: "won", pnl: 3, units: 2 });
    const app = await buildApp();

    const { body } = await getSummary(app);

    // 3 / 2 = 150%
    expect(body.roiPercent).toBe(150);
  });
});

describe("GET /dashboard/summary — average CLV", () => {
  it("averages CLV only over bets that captured one, ignoring nulls", async () => {
    seedBet({ status: "won", pnl: 1, clvPercent: 2 });
    seedBet({ status: "lost", pnl: -1, clvPercent: 4 });
    // No CLV captured — must not be treated as 0 in the average.
    seedBet({ status: "pending", pnl: null, clvPercent: null });
    const app = await buildApp();

    const { body } = await getSummary(app);

    // (2 + 4) / 2 = 3, NOT (2 + 4 + 0) / 3 = 2.
    expect(body.avgClvPercent).toBe(3);
    expect(body.clvSampleSize).toBe(2);
  });

  it("reports null avgClvPercent (not zero, not NaN) when no bet has a CLV", async () => {
    seedBet({ status: "won", pnl: 1, clvPercent: null });
    const app = await buildApp();

    const { body } = await getSummary(app);

    expect(body.avgClvPercent).toBeNull();
    expect(body.clvSampleSize).toBe(0);
  });

  it("includes CLV from a pending bet even though its P&L is excluded", async () => {
    // CLV is captured at bet time, independent of settlement.
    seedBet({ status: "pending", pnl: null, clvPercent: 5 });
    const app = await buildApp();

    const { body } = await getSummary(app);

    expect(body.avgClvPercent).toBe(5);
    expect(body.clvSampleSize).toBe(1);
    // ...but its stake still doesn't count as realized risk.
    expect(body.totalUnits).toBe(0);
    expect(body.totalPnl).toBe(0);
  });
});

describe("GET /dashboard/summary — empty book", () => {
  it("returns zeroed totals and a null CLV (never NaN) with no bets logged", async () => {
    const app = await buildApp();

    const { status, body } = await getSummary(app);

    expect(status).toBe(200);
    expect(body.totalBets).toBe(0);
    expect(body.totalUnits).toBe(0);
    expect(body.totalPnl).toBe(0);
    expect(body.roiPercent).toBe(0);
    expect(body.avgClvPercent).toBeNull();
    expect(body.clvSampleSize).toBe(0);
    expect(body.bySport).toEqual([]);
    // Guard against NaN leaking through as a number.
    expect(Number.isNaN(body.totalPnl)).toBe(false);
    expect(Number.isNaN(body.roiPercent)).toBe(false);
  });
});

describe("GET /dashboard/summary — per-sport breakdown", () => {
  it("splits P&L/units per sport over settled bets and sorts by bet count", async () => {
    seedBet({ sport: "baseball_mlb", status: "won", pnl: 2, units: 1 });
    seedBet({ sport: "baseball_mlb", status: "lost", pnl: -1, units: 1 });
    seedBet({ sport: "baseball_mlb", status: "pending", pnl: null, units: 3 });
    seedBet({ sport: "basketball_nba", status: "won", pnl: 5, units: 2 });
    const app = await buildApp();

    const { body } = await getSummary(app);

    expect(body.bySport.map((s) => s.sport)).toEqual(["baseball_mlb", "basketball_nba"]);

    const mlb = body.bySport.find((s) => s.sport === "baseball_mlb")!;
    expect(mlb.bets).toBe(3);
    expect(mlb.won).toBe(1);
    expect(mlb.lost).toBe(1);
    expect(mlb.pending).toBe(1);
    // Settled only: 2 + (-1) = 1 pnl over 1 + 1 = 2 units → 50% ROI.
    expect(mlb.pnl).toBe(1);
    expect(mlb.settledUnits).toBe(2);
    expect(mlb.roiPercent).toBe(50);
    // Open exposure: only the pending bet's 3 units ride for MLB.
    expect(mlb.pendingUnits).toBe(3);

    const nba = body.bySport.find((s) => s.sport === "basketball_nba")!;
    expect(nba.pnl).toBe(5);
    expect(nba.settledUnits).toBe(2);
    expect(nba.bets).toBe(1);
    expect(nba.pendingUnits).toBe(0);
  });

  it("excludes soft-deleted pending bets from a sport's pendingUnits", async () => {
    seedBet({ sport: "baseball_mlb", status: "pending", pnl: null, units: 2 });
    seedBet({ sport: "baseball_mlb", status: "pending", pnl: null, units: 5, deletedAt: new Date("2026-07-14T00:00:00Z") });
    const app = await buildApp();

    const { body } = await getSummary(app);

    const mlb = body.bySport.find((s) => s.sport === "baseball_mlb")!;
    expect(mlb.pending).toBe(1);
    expect(mlb.pendingUnits).toBe(2);
  });

  it("reports zero settledUnits for a sport whose settled bets have no pnl booked yet", async () => {
    // The "green zero" trap: marked won but pnl still null — this sport has a
    // non-zero W-L-P record yet no realized stake, so clients must be able to
    // key muting off settledUnits, not the record.
    seedBet({ sport: "baseball_mlb", status: "won", pnl: null, units: 2 });
    seedBet({ sport: "basketball_nba", status: "won", pnl: 3, units: 1 });
    const app = await buildApp();

    const { body } = await getSummary(app);

    const mlb = body.bySport.find((s) => s.sport === "baseball_mlb")!;
    expect(mlb.won).toBe(1);
    expect(mlb.settledUnits).toBe(0);
    expect(mlb.pnl).toBe(0);
    expect(mlb.roiPercent).toBe(0);

    const nba = body.bySport.find((s) => s.sport === "basketball_nba")!;
    expect(nba.settledUnits).toBe(1);
  });
});
