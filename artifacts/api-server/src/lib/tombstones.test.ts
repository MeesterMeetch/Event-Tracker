import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb, stubDrizzleOrm, type FakeDbModule } from "./__fixtures__/fake-db";

/**
 * Guards the periodic tombstone purge. Soft-deleted paper trades used to be
 * cleaned up only when another delete happened — if deletes stopped, the last
 * tombstones lingered invisibly forever, holding their unique pick slots. The
 * purge must drop only tombstones past the restore grace window, never live
 * rows or freshly deleted (still-undoable) ones.
 */

vi.mock("drizzle-orm", async () => stubDrizzleOrm());
vi.mock("@workspace/db", () => makeFakeDb());
vi.mock("./logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

let dbMod: FakeDbModule;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  dbMod = (await import("@workspace/db")) as unknown as FakeDbModule;
  dbMod.__reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function seed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return dbMod.__seedPaperTrade({
    sport: "baseball_mlb",
    gameId: `evt-${Math.random()}`,
    commenceTime: new Date("2026-07-10T18:00:00Z"),
    pitcher: "Blake Snell",
    selection: "Over",
    point: 6.5,
    book: "FanDuel",
    americanOdds: -110,
    modelProb: 0.6,
    status: "open",
    ...overrides,
  });
}

const HOUR = 60 * 60 * 1000;

describe("purgeExpiredPaperTradeTombstones", () => {
  it("hard-deletes tombstones past the grace window and reports the count", async () => {
    const { purgeExpiredPaperTradeTombstones } = await import("./tombstones");
    seed({ id: 1, deletedAt: new Date(Date.now() - 2 * HOUR) });
    seed({ id: 2, deletedAt: new Date(Date.now() - 3 * HOUR) });

    const purged = await purgeExpiredPaperTradeTombstones();

    expect(purged).toBe(2);
    expect(dbMod.__stores.pitcher_k_paper_trades).toHaveLength(0);
  });

  it("keeps live rows and tombstones still inside the grace window", async () => {
    const { purgeExpiredPaperTradeTombstones } = await import("./tombstones");
    seed({ id: 1 }); // live row, deletedAt null
    seed({ id: 2, deletedAt: new Date(Date.now() - 5 * 60 * 1000) }); // still undoable
    seed({ id: 3, deletedAt: new Date(Date.now() - 2 * HOUR) }); // expired

    const purged = await purgeExpiredPaperTradeTombstones();

    expect(purged).toBe(1);
    const remaining = dbMod.__stores.pitcher_k_paper_trades.map((r) => r.id);
    expect(remaining).toEqual([1, 2]);
  });

  it("is a no-op on an empty table", async () => {
    const { purgeExpiredPaperTradeTombstones } = await import("./tombstones");

    await expect(purgeExpiredPaperTradeTombstones()).resolves.toBe(0);
  });
});

describe("startTombstonePurge — the safety net when deletes stop", () => {
  it("purges expired tombstones on a timer without any delete traffic", async () => {
    vi.useFakeTimers();
    try {
      const { startTombstonePurge } = await import("./tombstones");
      seed({ id: 1, deletedAt: new Date(Date.now() - 2 * HOUR) });

      startTombstonePurge();
      // The startup pass (60s delay) is what cleans stragglers from before a restart.
      await vi.advanceTimersByTimeAsync(61 * 1000);

      expect(dbMod.__stores.pitcher_k_paper_trades).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans a tombstone that expires later, on a subsequent interval tick", async () => {
    vi.useFakeTimers();
    try {
      const { startTombstonePurge } = await import("./tombstones");
      // Fresh tombstone: inside the grace window at startup.
      seed({ id: 1, deletedAt: new Date() });

      startTombstonePurge();
      await vi.advanceTimersByTimeAsync(61 * 1000);
      // Still within grace — must survive the startup pass.
      expect(dbMod.__stores.pitcher_k_paper_trades).toHaveLength(1);

      // After the grace window passes, the next 15-minute tick removes it.
      await vi.advanceTimersByTimeAsync(2 * HOUR);
      expect(dbMod.__stores.pitcher_k_paper_trades).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
