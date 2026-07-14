import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb, stubDrizzleOrm, type FakeDbModule } from "../lib/__fixtures__/fake-db";

/**
 * Guards GET /ledger-audit, the automatic corrupt-ledger watchdog behind the
 * dashboard warning banner. It must run the exact same shared predicates as
 * the manual audit script: impossible American odds (strictly inside
 * (-100, 100)), zero/negative units, settled bets with NULL pnl, and pnl
 * signs that contradict won/lost status — plus impossible odds on pitcher-K
 * paper trades. A regression here wouldn't crash; it would either hide real
 * corruption (banner never shows, profit/ROI silently skewed) or cry wolf on
 * a clean ledger. Tests run the real route and the real shared predicates
 * from @workspace/db/audit against the in-memory db stand-in.
 */

vi.mock("drizzle-orm", async () => stubDrizzleOrm());
vi.mock("@workspace/db", () => makeFakeDb());

let dbMod: FakeDbModule;

beforeEach(async () => {
  dbMod = (await import("@workspace/db")) as unknown as FakeDbModule;
  dbMod.__reset();
});

interface AuditBody {
  impossibleOddsBets: number;
  zeroOrNegativeUnitBets: number;
  settledNullPnlBets: number;
  contradictoryPnlBets: number;
  pushNonzeroPnlBets: number;
  impossibleOddsPaperTrades: number;
  total: number;
}

async function buildApp(): Promise<Express> {
  const { default: auditRouter } = await import("./audit");
  const app = express();
  app.use(express.json());
  app.use("/api", auditRouter);
  return app;
}

async function getAudit(app: Express): Promise<{ status: number; body: AuditBody }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/api/ledger-audit", method: "GET" },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              body: data ? (JSON.parse(data) as AuditBody) : (null as unknown as AuditBody),
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

function seedCleanBet(overrides: Record<string, unknown> = {}): void {
  dbMod.__seedBet({
    sport: "baseball_mlb",
    gameId: "g1",
    commenceTime: new Date("2026-07-14T23:00:00Z"),
    homeTeam: "Yankees",
    awayTeam: "Red Sox",
    market: "h2h",
    selection: "Yankees",
    americanOdds: -110,
    units: 1,
    status: "pending",
    pnl: null,
    ...overrides,
  });
}

describe("GET /ledger-audit", () => {
  it("returns all zeros for a clean ledger (pending, settled-with-pnl, push-with-null-pnl)", async () => {
    seedCleanBet();
    seedCleanBet({ status: "won", pnl: 0.91 });
    seedCleanBet({ status: "lost", pnl: -1 });
    // A push may legitimately carry pnl 0 — but NULL pnl on a push is still corrupt.
    seedCleanBet({ status: "push", pnl: 0 });
    // Boundary odds: exactly -100/+100 are legal quotes, not impossible.
    seedCleanBet({ americanOdds: 100 });
    seedCleanBet({ americanOdds: -100 });
    dbMod.__seedPaperTrade({ americanOdds: -115, status: "pending" });

    const app = await buildApp();
    const { status, body } = await getAudit(app);

    expect(status).toBe(200);
    expect(body).toEqual({
      impossibleOddsBets: 0,
      zeroOrNegativeUnitBets: 0,
      settledNullPnlBets: 0,
      contradictoryPnlBets: 0,
      pushNonzeroPnlBets: 0,
      impossibleOddsPaperTrades: 0,
      total: 0,
    });
  });

  it("counts each corruption category with the same rules as the audit script", async () => {
    seedCleanBet(); // clean control row
    seedCleanBet({ americanOdds: 50 }); // impossible odds (+50)
    seedCleanBet({ americanOdds: -12 }); // impossible odds (-12)
    seedCleanBet({ units: 0 }); // zero units
    seedCleanBet({ units: -2 }); // negative units
    seedCleanBet({ status: "won", pnl: null }); // settled, NULL pnl
    seedCleanBet({ status: "push", pnl: null }); // push counts as settled too
    seedCleanBet({ status: "won", pnl: -0.5 }); // won but negative pnl
    seedCleanBet({ status: "lost", pnl: 1.2 }); // lost but positive pnl
    seedCleanBet({ status: "push", pnl: 0.75 }); // push carrying a profit
    seedCleanBet({ status: "push", pnl: -1 }); // push carrying a loss
    dbMod.__seedPaperTrade({ americanOdds: 40, status: "pending" }); // impossible trade odds
    dbMod.__seedPaperTrade({ americanOdds: -140, status: "pending" }); // clean trade

    const app = await buildApp();
    const { status, body } = await getAudit(app);

    expect(status).toBe(200);
    expect(body).toEqual({
      impossibleOddsBets: 2,
      zeroOrNegativeUnitBets: 2,
      settledNullPnlBets: 2,
      contradictoryPnlBets: 2,
      pushNonzeroPnlBets: 2,
      impossibleOddsPaperTrades: 1,
      total: 11,
    });
  });

  it("still flags soft-deleted corrupt rows (a restored tombstone is corrupt again)", async () => {
    seedCleanBet({ americanOdds: 20, deletedAt: new Date("2026-07-14T00:00:00Z") });

    const app = await buildApp();
    const { body } = await getAudit(app);

    expect(body.impossibleOddsBets).toBe(1);
    expect(body.total).toBe(1);
  });
});
