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
    expect((body as { error: string }).error).toMatch(/americanOdds cannot be 0/i);
    expect(dbMod.__stores.bets).toHaveLength(0);
  });

  it("rejects a malformed body with a 400", async () => {
    const app = await buildApp();

    const { status } = await request(app, "POST", "/api/bets", { sport: "baseball_mlb" });

    expect(status).toBe(400);
    expect(dbMod.__stores.bets).toHaveLength(0);
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

  it("rejects odds of 0 (bad data) with a 400", async () => {
    seedPending({ id: 1 });
    const app = await buildApp();

    const { status } = await request(app, "PATCH", "/api/bets/1", { americanOdds: 0 });

    expect(status).toBe(400);
  });

  it("404s when settling a bet that doesn't exist", async () => {
    const app = await buildApp();

    const { status } = await request(app, "PATCH", "/api/bets/999", { status: "won" });

    expect(status).toBe(404);
  });
});

describe("DELETE /bets/:id", () => {
  it("deletes an existing bet", async () => {
    seedPending({ id: 1 });
    const app = await buildApp();

    const { status } = await request(app, "DELETE", "/api/bets/1");

    expect(status).toBe(204);
    expect(dbMod.__stores.bets).toHaveLength(0);
  });

  it("404s when deleting a bet that doesn't exist", async () => {
    const app = await buildApp();

    const { status } = await request(app, "DELETE", "/api/bets/999");

    expect(status).toBe(404);
  });
});
