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

type Method = "GET" | "POST" | "PATCH" | "DELETE";

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

  it("rejects americanOdds = 50 (impossible price inside (-100, 100)) with 400 at the HTTP layer, never inserting", async () => {
    // This is the route-level integration complement to the schema-only parity
    // suite: it confirms that the zod parse inside the handler actually produces
    // a 400 and that no row reaches the db — catching any future middleware gap
    // between schema validation and the INSERT.
    const app = await buildApp();

    const { status } = await request(app, "POST", "/api/paper-trades", { ...PT_BODY, americanOdds: 50 });

    expect(status).toBe(400);
    expect(dbMod.__stores.pitcher_k_paper_trades).toHaveLength(0);
  });

  it("accepts americanOdds = -120 (valid) and returns 201", async () => {
    // Counterpart to the impossible-odds rejection: a canonical negative-line
    // price must pass the schema, reach the INSERT, and come back as 201 open.
    const app = await buildApp();

    const { status, body } = await request(app, "POST", "/api/paper-trades", { ...PT_BODY, americanOdds: -120 });

    expect(status).toBe(201);
    expect((body as { status: string }).status).toBe("open");
    expect((body as { americanOdds: number }).americanOdds).toBe(-120);
    expect(dbMod.__stores.pitcher_k_paper_trades).toHaveLength(1);
  });

  it("accepts americanOdds = -100 (exact lower boundary) and returns 201", async () => {
    // -100 is the outermost valid negative American odds; the forbidden zone is
    // the open interval (-100, 100), so the edge itself must be allowed through
    // the schema, reach the INSERT, and come back as 201 open.
    const app = await buildApp();

    const { status, body } = await request(app, "POST", "/api/paper-trades", { ...PT_BODY, americanOdds: -100 });

    expect(status).toBe(201);
    expect((body as { status: string }).status).toBe("open");
    expect((body as { americanOdds: number }).americanOdds).toBe(-100);
    expect(dbMod.__stores.pitcher_k_paper_trades).toHaveLength(1);
  });

  it("accepts americanOdds = 100 (exact upper boundary) and returns 201", async () => {
    // +100 is the outermost valid positive American odds; the forbidden zone is
    // the open interval (-100, 100), so the edge itself must be allowed through
    // the schema, reach the INSERT, and come back as 201 open.
    const app = await buildApp();

    const { status, body } = await request(app, "POST", "/api/paper-trades", { ...PT_BODY, americanOdds: 100 });

    expect(status).toBe(201);
    expect((body as { status: string }).status).toBe("open");
    expect((body as { americanOdds: number }).americanOdds).toBe(100);
    expect(dbMod.__stores.pitcher_k_paper_trades).toHaveLength(1);
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

describe("PATCH /paper-trades/:id — correcting a mistyped price without delete-and-relog", () => {
  it("corrects the odds on an ungraded trade and leaves the closing fields alone", async () => {
    const trade = seedTrade({ americanOdds: -1100 }); // fat-fingered -110
    const app = await buildApp();

    const { status, body } = await request(app, "PATCH", `/api/paper-trades/${trade.id}`, { americanOdds: -110 });

    expect(status).toBe(200);
    const updated = body as { americanOdds: number; closingOdds: number | null; clvPercent: number | null };
    expect(updated.americanOdds).toBe(-110);
    expect(updated.closingOdds).toBeNull();
    expect(updated.clvPercent).toBeNull();
  });

  it("rejects impossible prices inside (-100, 100), including 0, via the shared schema", async () => {
    const trade = seedTrade();
    const app = await buildApp();

    for (const bad of [50, -50, 0, 99.5]) {
      const { status } = await request(app, "PATCH", `/api/paper-trades/${trade.id}`, { americanOdds: bad });
      expect(status).toBe(400);
    }
    expect(dbMod.__stores.pitcher_k_paper_trades[0].americanOdds).toBe(-110);
  });

  it("recomputes CLV% and beat-close from the corrected price when a close was captured, without touching the close", async () => {
    // Logged as -1100 by mistake; close captured at -120. Against the typo the
    // pick looks like a huge closing-line loss — the corrected price flips it.
    const trade = seedTrade({
      americanOdds: -1100,
      closingOdds: -120,
      closingProb: 0.5455,
      clvPercent: -40.55,
      beatClose: false,
      status: "closed",
    });
    const app = await buildApp();

    const { status, body } = await request(app, "PATCH", `/api/paper-trades/${trade.id}`, { americanOdds: -110 });

    expect(status).toBe(200);
    const updated = body as {
      americanOdds: number;
      closingOdds: number | null;
      closingProb: number | null;
      clvPercent: number | null;
      beatClose: boolean | null;
      status: string;
    };
    expect(updated.americanOdds).toBe(-110);
    // The captured market close is history — never rewritten by an edit.
    expect(updated.closingOdds).toBe(-120);
    expect(updated.closingProb).toBe(0.5455);
    expect(updated.status).toBe("closed");
    // CLV re-derived from the corrected open price: -110 beat a -120 close.
    expect(updated.clvPercent).toBeGreaterThan(0);
    expect(updated.beatClose).toBe(true);
  });

  it("404s a soft-deleted trade — it must be restored before it can be edited", async () => {
    const trade = seedTrade({ deletedAt: new Date("2026-07-10T20:00:00Z") });
    const app = await buildApp();

    const { status } = await request(app, "PATCH", `/api/paper-trades/${trade.id}`, { americanOdds: -110 });

    expect(status).toBe(404);
  });

  it("404s an unknown id and 400s a non-integer id", async () => {
    const app = await buildApp();

    expect((await request(app, "PATCH", "/api/paper-trades/999", { americanOdds: -110 })).status).toBe(404);
    expect((await request(app, "PATCH", "/api/paper-trades/abc", { americanOdds: -110 })).status).toBe(400);
  });
});

describe("PATCH /paper-trades/:id — impossible-odds boundary sweep", () => {
  // The open interval (-100, 100) including 0 is forbidden; the exact edges
  // -100 and +100 are valid American odds and must pass. This suite exercises
  // the boundary explicitly so a future schema tweak can't silently slide the
  // cutoff and corrupt the scorecard without a test catching it.

  it("rejects prices inside the impossible interval: 50 and 0 → 400", async () => {
    const trade = seedTrade();
    const app = await buildApp();

    for (const bad of [50, 0]) {
      const { status } = await request(app, "PATCH", `/api/paper-trades/${trade.id}`, { americanOdds: bad });
      expect(status, `americanOdds=${bad} should be rejected`).toBe(400);
    }
    // No mutation should have occurred.
    expect(dbMod.__stores.pitcher_k_paper_trades[0].americanOdds).toBe(-110);
  });

  it("accepts the exact boundary values -100 and 100 → 200", async () => {
    // -100 and +100 are the outermost valid American odds; the forbidden zone
    // is the open interval (-100, 100), so both edges must be allowed.
    const app = await buildApp();

    const tradeMinus = seedTrade({ americanOdds: -200 });
    const { status: s1, body: b1 } = await request(app, "PATCH", `/api/paper-trades/${tradeMinus.id}`, {
      americanOdds: -100,
    });
    expect(s1, "americanOdds=-100 should be accepted").toBe(200);
    expect((b1 as { americanOdds: number }).americanOdds).toBe(-100);

    const tradePlus = seedTrade({ gameId: "evt-boundary-100", americanOdds: -200 });
    const { status: s2, body: b2 } = await request(app, "PATCH", `/api/paper-trades/${tradePlus.id}`, {
      americanOdds: 100,
    });
    expect(s2, "americanOdds=100 should be accepted").toBe(200);
    expect((b2 as { americanOdds: number }).americanOdds).toBe(100);
  });

  it("accepts a canonical valid price -110 → 200", async () => {
    // Counterpart to the rejections: a standard negative line must pass the
    // schema, update the row, and come back as 200 with the corrected odds.
    const trade = seedTrade({ americanOdds: -1100 });
    const app = await buildApp();

    const { status, body } = await request(app, "PATCH", `/api/paper-trades/${trade.id}`, { americanOdds: -110 });

    expect(status).toBe(200);
    expect((body as { americanOdds: number }).americanOdds).toBe(-110);
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

describe("DELETE /paper-trades/:id — soft delete backing the undo affordance", () => {
  it("soft-deletes: hidden from list and summary but the row survives for undo", async () => {
    seedTrade({ id: 1, status: "closed", clvPercent: 4, beatClose: true });
    const app = await buildApp();

    const { status } = await request(app, "DELETE", "/api/paper-trades/1");

    expect(status).toBe(204);
    // Row is kept (tombstoned), not dropped — that's what makes undo exact.
    expect(dbMod.__stores.pitcher_k_paper_trades).toHaveLength(1);
    expect(dbMod.__stores.pitcher_k_paper_trades[0].deletedAt).toBeInstanceOf(Date);

    const list = await request(app, "GET", "/api/paper-trades");
    expect(list.body).toHaveLength(0);
    const summary = await request(app, "GET", "/api/paper-trades/summary");
    expect((summary.body as { total: number }).total).toBe(0);
    expect((summary.body as { gradedCount: number }).gradedCount).toBe(0);
  });

  it("404s when the trade doesn't exist", async () => {
    const app = await buildApp();

    const { status } = await request(app, "DELETE", "/api/paper-trades/999");

    expect(status).toBe(404);
  });

  it("404s a second delete of the same trade instead of re-stamping the tombstone", async () => {
    seedTrade({ id: 1 });
    const app = await buildApp();

    const first = await request(app, "DELETE", "/api/paper-trades/1");
    const second = await request(app, "DELETE", "/api/paper-trades/1");

    expect(first.status).toBe(204);
    expect(second.status).toBe(404);
  });

  it("400s on a non-integer id", async () => {
    const app = await buildApp();

    const { status } = await request(app, "DELETE", "/api/paper-trades/abc");

    expect(status).toBe(400);
  });

  it("purges tombstones past the grace window on the next delete", async () => {
    // Soft-deleted two hours ago — well past the 1h restore grace.
    seedTrade({ id: 1, deletedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) });
    seedTrade({ id: 2, gameId: "evt-mlb-2" });
    const app = await buildApp();

    const { status } = await request(app, "DELETE", "/api/paper-trades/2");

    expect(status).toBe(204);
    // The stale tombstone is gone; only the freshly soft-deleted row remains.
    expect(dbMod.__stores.pitcher_k_paper_trades).toHaveLength(1);
    expect(dbMod.__stores.pitcher_k_paper_trades[0].id).toBe(2);
  });
});

describe("POST /paper-trades/:id/restore — undo brings the exact trade back", () => {
  it("restores a soft-deleted trade with its graded closing-line data intact", async () => {
    seedTrade({ id: 1, status: "closed", closingOdds: -125, clvPercent: 4, beatClose: true });
    const app = await buildApp();

    await request(app, "DELETE", "/api/paper-trades/1");
    const restored = await request(app, "POST", "/api/paper-trades/1/restore");

    expect(restored.status).toBe(200);
    const row = restored.body as Record<string, unknown>;
    expect(row.id).toBe(1);
    expect(row.status).toBe("closed");
    expect(row.clvPercent).toBe(4);

    // Back in the list and counting toward summary stats again.
    const list = await request(app, "GET", "/api/paper-trades");
    expect(list.body).toHaveLength(1);
    const summary = await request(app, "GET", "/api/paper-trades/summary");
    expect((summary.body as { total: number }).total).toBe(1);
    expect((summary.body as { gradedCount: number }).gradedCount).toBe(1);
  });

  it("404s when the trade was never deleted (double-tapping undo is harmless)", async () => {
    seedTrade({ id: 1 });
    const app = await buildApp();

    const { status, body } = await request(app, "POST", "/api/paper-trades/1/restore");

    expect(status).toBe(404);
    expect((body as { error: string }).error).toMatch(/no longer be restored/i);
  });

  it("404s for an unknown id", async () => {
    const app = await buildApp();

    const { status } = await request(app, "POST", "/api/paper-trades/999/restore");

    expect(status).toBe(404);
  });

  it("400s on a non-integer id", async () => {
    const app = await buildApp();

    const { status } = await request(app, "POST", "/api/paper-trades/abc/restore");

    expect(status).toBe(400);
  });

  it("cannot restore a pick that was re-logged after deletion — no duplicate row", async () => {
    seedTrade({ id: 1, gameId: PT_BODY.gameId, commenceTime: new Date(PT_BODY.commenceTime) });
    const app = await buildApp();

    // Delete the pick, then log the exact same pick again: the tombstone's
    // unique slot is cleared so the re-log succeeds as a fresh row.
    await request(app, "DELETE", "/api/paper-trades/1");
    const relog = await request(app, "POST", "/api/paper-trades", PT_BODY);
    expect(relog.status).toBe(201);

    // The stale undo can't resurrect the old row into a duplicate.
    const restored = await request(app, "POST", "/api/paper-trades/1/restore");
    expect(restored.status).toBe(404);

    const list = await request(app, "GET", "/api/paper-trades");
    expect(list.body).toHaveLength(1);
  });
});
