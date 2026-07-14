import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb, stubDrizzleOrm, type FakeDbModule } from "./__fixtures__/fake-db";

/**
 * Guards the scheduled ledger-audit pass: it must WARN (with per-category
 * counts) when corrupt rows exist and stay completely silent when the ledger
 * is clean — the "no behavior change on a clean ledger" contract. The warning
 * is the whole point of the feature: without it, corruption only surfaces if
 * the user remembers to run the manual audit script.
 */

vi.mock("drizzle-orm", async () => stubDrizzleOrm());
vi.mock("@workspace/db", () => makeFakeDb());
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let dbMod: FakeDbModule;

beforeEach(async () => {
  vi.clearAllMocks();
  dbMod = (await import("@workspace/db")) as unknown as FakeDbModule;
  dbMod.__reset();
});

describe("runScheduledLedgerAudit", () => {
  it("logs nothing when the ledger is clean", async () => {
    dbMod.__seedBet({ americanOdds: -110, units: 1, status: "won", pnl: 0.91 });
    const { runScheduledLedgerAudit } = await import("./ledger-audit");
    const { logger } = await import("./logger");

    await runScheduledLedgerAudit();

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("does not flag a push with pnl exactly 0 or NULL pnl already caught elsewhere", async () => {
    dbMod.__seedBet({ americanOdds: -110, units: 1, status: "push", pnl: 0 });
    const { runScheduledLedgerAudit } = await import("./ledger-audit");
    const { logger } = await import("./logger");

    await runScheduledLedgerAudit();

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns with per-category counts when corrupt rows exist", async () => {
    dbMod.__seedBet({ americanOdds: 50, units: 1, status: "pending", pnl: null });
    dbMod.__seedBet({ americanOdds: -110, units: 0, status: "pending", pnl: null });
    dbMod.__seedBet({ americanOdds: -110, units: 1, status: "push", pnl: 0.5 });
    const { runScheduledLedgerAudit } = await import("./ledger-audit");
    const { logger } = await import("./logger");

    await runScheduledLedgerAudit();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [payload, message] = vi.mocked(logger.warn).mock.calls[0] as [
      Record<string, number>,
      string,
    ];
    expect(payload).toMatchObject({
      impossibleOddsBets: 1,
      zeroOrNegativeUnitBets: 1,
      pushNonzeroPnlBets: 1,
      total: 3,
    });
    expect(message).toContain("3 corrupt row(s)");
  });

  it("logs an error (not a crash) when the audit query fails", async () => {
    const { runScheduledLedgerAudit } = await import("./ledger-audit");
    const { logger } = await import("./logger");
    const dbHandle = dbMod.db as { select: () => unknown };
    const originalSelect = dbHandle.select;
    dbHandle.select = () => {
      throw new Error("db down");
    };
    try {
      await expect(runScheduledLedgerAudit()).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();
    } finally {
      dbHandle.select = originalSelect;
    }
  });
});
