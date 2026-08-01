import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb, stubDrizzleOrm, type FakeDbModule } from "../lib/__fixtures__/fake-db";

/**
 * Guards the bet-tracking route that settles a logged pick and books its
 * realized P&L: PATCH /bets/{id}. A regression here wouldn't crash — it would
 * quietly write the wrong result or a stale/incorrect pnl into the user's
 * performance history. These tests exercise the real route (status/pnl
 * lockstep, validation, 404s) against an in-memory db stand-in so no live
 * Postgres is touched.
 *
 * The db handle and drizzle's eq/desc are mocked; the route code is otherwise
 * run verbatim. The test's own request uses node:http.
 */

vi.mock("drizzle-orm", async () => stubDrizzleOrm());
vi.mock("@workspace/db", () => makeFakeDb());

let dbMod: FakeDbModule;

beforeEach(async () => {
  dbMod = (await import("@workspace/db")) as unknown as FakeDbModule;
  dbMod.__reset();
});

async function buildApp(): Promise<Express> {
  const { default: betsRouter } = await import("./bets");
  const app = express();
  app.use(express.json());
  app.use("/api", betsRouter);
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

/** A complete pending bet row for seeding straight into the fake store. */
function seedPending(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return dbMod.__seedBet({
    sport: "baseball_mlb",
    gameId: "evt-mlb-1",
    commenceTime: new Date("2026-07-10T18:00:00Z"),
    homeTeam: "New York Yankees",
    awayTeam: "Boston Red Sox",
    market: "h2h",
    selection: "New York Yankees",
    point: null,
    americanOdds: 150,
    units: 2,
    status: "pending",
    pnl: null,
    createdAt: new Date("2026-07-10T12:00:00Z"),
    ...overrides,
  });
}

const NEW_BET = {
  sport: "baseball_mlb",
  gameId: "evt-mlb-9",
  commenceTime: "2026-07-15T18:00:00Z",
  homeTeam: "Los Angeles Dodgers",
  awayTeam: "San Francisco Giants",
  market: "h2h",
  selection: "Los Angeles Dodgers",
  point: null,
  americanOdds: -120,
  units: 1,
};

describe("POST /bets", () => {
  it("logs a new bet as pending with no pnl yet", async () => {
    const app = await buildApp();

    const { status, body } = await request(app, "POST", "/api/bets", NEW_BET);

    expect(status).toBe(201);
    const bet = body as Record<string, unknown>;
    expect(bet.status).toBe("pending");
    expect(bet.pnl).toBeNull();
    expect(bet.selection).toBe("Los Angeles Dodgers");
    // The row is actually persisted, not just echoed back.
    expect(dbMod.__stores.bets).toHaveLength(1);
  });

  it("rejects odds of 0 (bad data) with a 400 and never inserts", async () => {
    const app = await buildApp();

    const { status, body } = await request(app, "POST", "/api/bets", { ...NEW_BET, americanOdds: 0 });

    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/americanOdds/i);
    expect(dbMod.__stores.bets).toHaveLength(0);
  });

  it("rejects impossible American odds inside (-100, 100), like a +50 typo, and never inserts", async () => {
    const app = await buildApp();

    for (const americanOdds of [50, -12, 99.5, -99]) {
      const { status, body } = await request(app, "POST", "/api/bets", { ...NEW_BET, americanOdds });

      expect(status).toBe(400);
      expect((body as { error: string }).error).toMatch(/americanOdds/i);
    }
    expect(dbMod.__stores.bets).toHaveLength(0);
  });

  it("accepts the boundary prices -100 and +100", async () => {
    const app = await buildApp();

    const even = await request(app, "POST", "/api/bets", { ...NEW_BET, americanOdds: 100 });
    expect(even.status).toBe(201);
    const layEven = await request(app, "POST", "/api/bets", { ...NEW_BET, gameId: "evt-mlb-10", americanOdds: -100 });
    expect(layEven.status).toBe(201);
    expect(dbMod.__stores.bets).toHaveLength(2);
  });

  it("rejects a malformed body with a 400", async () => {
    const app = await buildApp();

    const { status } = await request(app, "POST", "/api/bets", { sport: "baseball_mlb" });

    expect(status).toBe(400);
    expect(dbMod.__stores.bets).toHaveLength(0);
  });
});

describe("POST /bets — duplicate open-bet guard", () => {
  // The identity key: gameId + market + selection + point + book. NEW_BET is
  // an h2h pick, so point and book are both null — the null-safe branch.
  it("409s when the identical bet is still pending, and never double-inserts", async () => {
    const app = await buildApp();
    await request(app, "POST", "/api/bets", NEW_BET);

    const { status, body } = await request(app, "POST", "/api/bets", NEW_BET);

    expect(status).toBe(409);
    expect((body as { error: string }).error).toMatch(/already in your bet log/i);
    expect(dbMod.__stores.bets).toHaveLength(1);
  });

  it("allows re-logging the same market once the earlier bet has settled", async () => {
    seedPending({
      id: 1,
      gameId: NEW_BET.gameId,
      market: NEW_BET.market,
      selection: NEW_BET.selection,
      point: null,
      book: null,
      status: "won",
      pnl: 1.25,
    });
    const app = await buildApp();

    const { status } = await request(app, "POST", "/api/bets", NEW_BET);

    expect(status).toBe(201);
    expect(dbMod.__stores.bets).toHaveLength(2);
  });

  it("blocks a duplicate prop bet (point + book set) at the same book", async () => {
    const prop = {
      ...NEW_BET,
      market: "batter_home_runs",
      selection: "Aaron Judge Over",
      point: 0.5,
      book: "DraftKings",
    };
    const app = await buildApp();
    await request(app, "POST", "/api/bets", prop);

    const { status, body } = await request(app, "POST", "/api/bets", prop);

    expect(status).toBe(409);
    expect((body as { error: string }).error).toContain("Aaron Judge Over 0.5 @ DraftKings");
    expect(dbMod.__stores.bets).toHaveLength(1);
  });

  it("does not block the same selection taken at a different book or point", async () => {
    const prop = {
      ...NEW_BET,
      market: "batter_home_runs",
      selection: "Aaron Judge Over",
      point: 0.5,
      book: "DraftKings",
    };
    const app = await buildApp();
    await request(app, "POST", "/api/bets", prop);

    const otherBook = await request(app, "POST", "/api/bets", { ...prop, book: "FanDuel" });
    const otherPoint = await request(app, "POST", "/api/bets", { ...prop, point: 1.5 });

    expect(otherBook.status).toBe(201);
    expect(otherPoint.status).toBe(201);
    expect(dbMod.__stores.bets).toHaveLength(3);
  });
});

describe("GET /bets", () => {
  it("returns all bets newest-first", async () => {
    seedPending({ id: 1, createdAt: new Date("2026-07-10T10:00:00Z") });
    seedPending({ id: 2, createdAt: new Date("2026-07-10T12:00:00Z") });
    const app = await buildApp();

    const { status, body } = await request(app, "GET", "/api/bets");

    expect(status).toBe(200);
    const bets = body as Array<{ id: number }>;
    expect(bets.map((b) => b.id)).toEqual([2, 1]);
  });

  it("filters by status when asked", async () => {
    seedPending();
    seedPending({ status: "won", pnl: 3 });
    const app = await buildApp();

    const { status, body } = await request(app, "GET", "/api/bets?status=won");

    expect(status).toBe(200);
    const bets = body as Array<{ status: string }>;
    expect(bets).toHaveLength(1);
    expect(bets[0].status).toBe("won");
  });

  it("hides soft-deleted bets from the log", async () => {
    seedPending({ id: 1 });
    seedPending({ id: 2, gameId: "evt-mlb-2", deletedAt: new Date() });
    const app = await buildApp();

    const { status, body } = await request(app, "GET", "/api/bets");

    expect(status).toBe(200);
    expect((body as Array<{ id: number }>).map((b) => b.id)).toEqual([1]);
  });

  it("returns an empty list (not an error) when nothing is logged", async () => {
    const app = await buildApp();

    const { status, body } = await request(app, "GET", "/api/bets");

    expect(status).toBe(200);
    expect(body).toEqual([]);
  });
});

describe("GET /bets/:id", () => {
  it("404s for a bet that doesn't exist", async () => {
    const app = await buildApp();

    const { status } = await request(app, "GET", "/api/bets/999");

    expect(status).toBe(404);
  });
});

describe("PATCH /bets/:id — settlement books the correct P&L", () => {
  it("settles a win and books profit at the bet's odds", async () => {
    seedPending({ id: 1, americanOdds: 150, units: 2 });
    const app = await buildApp();

    const { status, body } = await request(app, "PATCH", "/api/bets/1", { status: "won" });

    expect(status).toBe(200);
    const bet = body as { status: string; pnl: number };
    expect(bet.status).toBe("won");
    // +150 on 2u returns +3.0
    expect(bet.pnl).toBe(3);
  });

  it("settles a loss and books the staked units as the loss", async () => {
    seedPending({ id: 1, americanOdds: 150, units: 2 });
    const app = await buildApp();

    const { status, body } = await request(app, "PATCH", "/api/bets/1", { status: "lost" });

    expect(status).toBe(200);
    expect((body as { pnl: number }).pnl).toBe(-2);
  });

  it("settles a push at zero P&L", async () => {
    seedPending({ id: 1, americanOdds: 150, units: 2 });
    const app = await buildApp();

    const { status, body } = await request(app, "PATCH", "/api/bets/1", { status: "push" });

    expect(status).toBe(200);
    expect((body as { pnl: number }).pnl).toBe(0);
  });

  it("clears the pnl when a settled bet is reopened to pending (no stale result)", async () => {
    seedPending({ id: 1, status: "won", pnl: 3 });
    const app = await buildApp();

    const { status, body } = await request(app, "PATCH", "/api/bets/1", { status: "pending" });

    expect(status).toBe(200);
    const bet = body as { status: string; pnl: number | null };
    expect(bet.status).toBe("pending");
    expect(bet.pnl).toBeNull();
  });

  it("honors an explicit pnl as a manual correction over the computed value", async () => {
    seedPending({ id: 1, americanOdds: 150, units: 2 });
    const app = await buildApp();

    const { status, body } = await request(app, "PATCH", "/api/bets/1", { status: "won", pnl: 2.75 });

    expect(status).toBe(200);
    expect((body as { pnl: number }).pnl).toBe(2.75);
  });

  it("rejects an explicit pnl on a bet being set to pending (settled ⟺ pnl stays intact)", async () => {
    seedPending({ id: 1 });
    const app = await buildApp();

    const { status, body } = await request(app, "PATCH", "/api/bets/1", { status: "pending", pnl: 2.5 });

    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/pending bet cannot have a P&L/i);
    expect(dbMod.__stores.bets[0]?.pnl).toBeNull();
  });

  it("rejects an explicit pnl when the bet stays pending (status omitted from the patch)", async () => {
    seedPending({ id: 1 });
    const app = await buildApp();

    const { status } = await request(app, "PATCH", "/api/bets/1", { pnl: 2.5 });

    expect(status).toBe(400);
    expect(dbMod.__stores.bets[0]?.pnl).toBeNull();
  });

  it("still allows an explicit null pnl alongside a pending status (redundant but consistent)", async () => {
    seedPending({ id: 1, status: "won", pnl: 3 });
    const app = await buildApp();

    const { status, body } = await request(app, "PATCH", "/api/bets/1", { status: "pending", pnl: null });

    expect(status).toBe(200);
    expect((body as { pnl: number | null }).pnl).toBeNull();
  });

  it("rejects odds of 0 (bad data) with a 400", async () => {
    seedPending({ id: 1 });
    const app = await buildApp();

    const { status } = await request(app, "PATCH", "/api/bets/1", { americanOdds: 0 });

    expect(status).toBe(400);
  });

  it("rejects impossible American odds inside (-100, 100), like a +50 typo, without touching the bet", async () => {
    seedPending({ id: 1, americanOdds: -120 });
    const app = await buildApp();

    for (const americanOdds of [50, -12, 99.5]) {
      const { status, body } = await request(app, "PATCH", "/api/bets/1", { americanOdds });

      expect(status).toBe(400);
      expect((body as { error: string }).error).toMatch(/americanOdds/i);
    }
    expect(dbMod.__stores.bets[0]?.americanOdds).toBe(-120);
  });

  it("accepts an edit to the boundary price +100 and recomputes P&L from it", async () => {
    seedPending({ id: 1, status: "won", americanOdds: 150, units: 1, pnl: 1.5 });
    const app = await buildApp();

    const { status, body } = await request(app, "PATCH", "/api/bets/1", { americanOdds: 100 });

    expect(status).toBe(200);
    expect((body as { pnl: number }).pnl).toBe(1);
  });

  it("404s when settling a bet that doesn't exist", async () => {
    const app = await buildApp();

    const { status } = await request(app, "PATCH", "/api/bets/999", { status: "won" });

    expect(status).toBe(404);
  });
});

describe("DELETE /bets/:id — soft delete backing the undo affordance", () => {
  it("soft-deletes: hidden from the log and dashboard-visible stats but the row survives for undo", async () => {
    seedPending({ id: 1, status: "won", pnl: 3, clvPercent: 2.5 });
    const app = await buildApp();

    const { status } = await request(app, "DELETE", "/api/bets/1");

    expect(status).toBe(204);
    // Row is kept (tombstoned), not dropped — that's what makes undo exact.
    expect(dbMod.__stores.bets).toHaveLength(1);
    expect(dbMod.__stores.bets[0].deletedAt).toBeInstanceOf(Date);

    const list = await request(app, "GET", "/api/bets");
    expect(list.body).toHaveLength(0);
    const one = await request(app, "GET", "/api/bets/1");
    expect(one.status).toBe(404);
  });

  it("404s when deleting a bet that doesn't exist", async () => {
    const app = await buildApp();

    const { status } = await request(app, "DELETE", "/api/bets/999");

    expect(status).toBe(404);
  });

  it("404s a second delete of the same bet instead of re-stamping the tombstone", async () => {
    seedPending({ id: 1 });
    const app = await buildApp();

    const first = await request(app, "DELETE", "/api/bets/1");
    const second = await request(app, "DELETE", "/api/bets/1");

    expect(first.status).toBe(204);
    expect(second.status).toBe(404);
  });

  it("blocks settling a soft-deleted bet during the grace window", async () => {
    seedPending({ id: 1 });
    const app = await buildApp();

    await request(app, "DELETE", "/api/bets/1");
    const { status } = await request(app, "PATCH", "/api/bets/1", { status: "won" });

    expect(status).toBe(404);
  });

  it("purges tombstones past the grace window on the next delete", async () => {
    // Soft-deleted two hours ago — well past the 1h restore grace.
    seedPending({ id: 1, deletedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) });
    seedPending({ id: 2, gameId: "evt-mlb-2" });
    const app = await buildApp();

    const { status } = await request(app, "DELETE", "/api/bets/2");

    expect(status).toBe(204);
    // The stale tombstone is gone; only the freshly soft-deleted row remains.
    expect(dbMod.__stores.bets).toHaveLength(1);
    expect(dbMod.__stores.bets[0].id).toBe(2);
  });
});

describe("POST /bets/:id/restore — undo brings the exact bet back", () => {
  it("restores a soft-deleted bet with its settled P&L and CLV intact", async () => {
    seedPending({ id: 1, status: "won", pnl: 3, closingOdds: 130, clvPercent: 2.5 });
    const app = await buildApp();

    await request(app, "DELETE", "/api/bets/1");
    const restored = await request(app, "POST", "/api/bets/1/restore");

    expect(restored.status).toBe(200);
    const row = restored.body as Record<string, unknown>;
    expect(row.id).toBe(1);
    expect(row.status).toBe("won");
    expect(row.pnl).toBe(3);
    expect(row.clvPercent).toBe(2.5);

    // Back in the log.
    const list = await request(app, "GET", "/api/bets");
    expect(list.body).toHaveLength(1);
  });

  it("404s when the bet was never deleted (double-tapping undo is harmless)", async () => {
    seedPending({ id: 1 });
    const app = await buildApp();

    const { status, body } = await request(app, "POST", "/api/bets/1/restore");

    expect(status).toBe(404);
    expect((body as { error: string }).error).toMatch(/no longer be restored/i);
  });

  it("cannot restore a bet once the grace window has elapsed — the tombstone is purged instead", async () => {
    // Soft-deleted two hours ago, well past the 1h grace. No intervening
    // delete has run, so only the restore path's own purge can enforce it.
    seedPending({ id: 1, deletedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) });
    const app = await buildApp();

    const { status, body } = await request(app, "POST", "/api/bets/1/restore");

    expect(status).toBe(404);
    expect((body as { error: string }).error).toMatch(/no longer be restored/i);
    // The expired tombstone is gone for good, not lingering invisibly.
    expect(dbMod.__stores.bets).toHaveLength(0);
  });

  it("404s for an unknown id and 400s on a non-integer id", async () => {
    const app = await buildApp();

    const missing = await request(app, "POST", "/api/bets/999/restore");
    const malformed = await request(app, "POST", "/api/bets/abc/restore");

    expect(missing.status).toBe(404);
    expect(malformed.status).toBe(400);
  });

  it("cannot restore a pending bet that was re-logged after deletion — no double-counted duplicate", async () => {
    seedPending({
      id: 1,
      gameId: NEW_BET.gameId,
      market: NEW_BET.market,
      selection: NEW_BET.selection,
      point: null,
      book: null,
    });
    const app = await buildApp();

    // Delete the wager, then log the exact same wager again: the tombstone is
    // purged so the re-log succeeds as a fresh row instead of 409ing.
    await request(app, "DELETE", "/api/bets/1");
    const relog = await request(app, "POST", "/api/bets", NEW_BET);
    expect(relog.status).toBe(201);

    // The stale undo can't resurrect the old row into a duplicate open bet.
    const restored = await request(app, "POST", "/api/bets/1/restore");
    expect(restored.status).toBe(404);

    const list = await request(app, "GET", "/api/bets");
    expect(list.body).toHaveLength(1);
  });
});
