import { and, eq, isNull, isNotNull, inArray } from "drizzle-orm";
import { calcPnl } from "./grading-math";
import { logger } from "./logger";

/**
 * The db package throws at import time when DATABASE_URL is unset, so it must
 * not be imported eagerly. Loading it lazily keeps the pure decision functions
 * below importable without provisioning a database, which is the difference
 * between them being tested and being hoped about.
 */
async function loadDb() {
  const mod = await import("@workspace/db");
  return {
    db: mod.db,
    betsTable: mod.betsTable,
    pitcherKPaperTradesTable: mod.pitcherKPaperTradesTable,
  };
}

/**
 * Settles pitcher-strikeout bets by inheriting the outcome of the paper trade
 * they were promoted from.
 *
 * The scores grader cannot touch these. `fetchScores` returns final team scores
 * and nothing else, so a player prop has never been auto-gradable and every one
 * of them has been settled by hand. That is 84% of this bet log.
 *
 * No new data source is needed. The paper trade is already settled every thirty
 * minutes by settleKOutcomes, which reads the real strikeout total from the MLB
 * boxscore and handles pushes and scratched starters. The bet is a promotion of
 * that exact trade, same side and same line, so the win or loss is identical by
 * construction. Only the money differs, since a bet carries its own price and
 * stake, so pnl is recomputed rather than copied.
 */

/**
 * A paper trade voided because the pitcher never took the mound becomes a push
 * on the bet. That is how books treat a non-start: stake returned, no action.
 * Mapping it to a loss would quietly invent losses that never happened.
 */
const OUTCOME_TO_STATUS: Record<string, "won" | "lost" | "push"> = {
  won: "won",
  lost: "lost",
  push: "push",
  void: "push",
};

/** Written by the promote button before `paperTradeId` existed as a column. */
const LEGACY_NOTE = /paper trade #(\d+)/i;

/**
 * Recovers the link from the note the promote button used to leave behind.
 * Exported so the migration path is covered by tests rather than by hope.
 */
export function parsePaperTradeId(notes: string | null | undefined): number | null {
  const match = notes?.match(LEGACY_NOTE);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export interface SettlementInput {
  americanOdds: number;
  units: number;
}

export interface Settlement {
  status: "won" | "lost" | "push";
  pnl: number;
}

/**
 * The whole decision, isolated from the database so it can be tested directly.
 *
 * Returns null to mean "not yet", which is the normal state for a game that has
 * not finished. Abstaining is always correct here: a wrong settlement is
 * silently wrong in the ledger, while a late one is merely late.
 */
export function resolveSettlement(
  bet: SettlementInput,
  tradeOutcome: string | null | undefined,
): Settlement | null {
  if (tradeOutcome == null) return null;
  const status = OUTCOME_TO_STATUS[tradeOutcome];
  if (status == null) return null;
  return { status, pnl: calcPnl(status, bet.americanOdds, bet.units) };
}

let running = false;

/**
 * Populates `paperTradeId` on rows created before the column existed, by
 * reading the note the promote button used to leave behind.
 *
 * Deliberately part of the normal run rather than a one-off script: a migration
 * that has to be remembered is a migration that gets forgotten, and this is
 * idempotent and stops finding work once the backlog is drained.
 */
async function backfillLinks(): Promise<number> {
  const { db, betsTable } = await loadDb();
  const unlinked = await db
    .select()
    .from(betsTable)
    .where(
      and(
        eq(betsTable.market, "pitcher_strikeouts"),
        isNull(betsTable.paperTradeId),
        isNull(betsTable.deletedAt),
        isNotNull(betsTable.notes),
      ),
    );

  let linked = 0;
  for (const bet of unlinked) {
    const id = parsePaperTradeId(bet.notes);
    if (id == null) continue;
    await db.update(betsTable).set({ paperTradeId: id }).where(eq(betsTable.id, bet.id));
    linked += 1;
  }
  if (linked > 0) logger.info({ linked }, "prop-grading: backfilled paper trade links");
  return linked;
}

export async function settlePropBets(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await backfillLinks();

    const { db, betsTable, pitcherKPaperTradesTable } = await loadDb();
    const pending = await db
      .select()
      .from(betsTable)
      .where(
        and(
          eq(betsTable.status, "pending"),
          eq(betsTable.market, "pitcher_strikeouts"),
          isNotNull(betsTable.paperTradeId),
          isNull(betsTable.deletedAt),
        ),
      );
    if (pending.length === 0) return;

    const ids = Array.from(
      new Set(pending.map((b) => b.paperTradeId).filter((id): id is number => id != null)),
    );
    const trades = await db
      .select()
      .from(pitcherKPaperTradesTable)
      .where(inArray(pitcherKPaperTradesTable.id, ids));
    const byId = new Map(trades.map((t) => [t.id, t]));

    for (const bet of pending) {
      const trade = bet.paperTradeId == null ? undefined : byId.get(bet.paperTradeId);
      // A missing trade means it was hard-deleted after promotion. Nothing can
      // be inferred, so leave the bet alone for manual settlement rather than
      // guessing.
      if (!trade) {
        logger.warn(
          { betId: bet.id, paperTradeId: bet.paperTradeId },
          "prop-grading: linked paper trade not found, leaving for manual settlement",
        );
        continue;
      }
      // Not yet graded. The outcome grader abstains on a game that is not final,
      // so this is the normal state for tonight's board and not worth a warning.
      if (trade.outcome == null) continue;

      // The bet's own price and stake, not the trade's: a promotion can be sized
      // differently, and the odds can be corrected after logging.
      const settled = resolveSettlement(bet, trade.outcome);
      if (settled == null) {
        logger.warn(
          { betId: bet.id, outcome: trade.outcome },
          "prop-grading: unrecognised paper trade outcome",
        );
        continue;
      }
      const { status, pnl } = settled;
      await db.update(betsTable).set({ status, pnl }).where(eq(betsTable.id, bet.id));
      logger.info(
        { betId: bet.id, paperTradeId: trade.id, selection: bet.selection, status, pnl },
        "prop-grading: bet settled from paper trade",
      );
    }
  } catch (err) {
    logger.error({ err }, "prop-grading: run failed");
  } finally {
    running = false;
  }
}

const INTERVAL_MS = 30 * 60 * 1000;

export function startPropGrading(): void {
  setInterval(() => void settlePropBets(), INTERVAL_MS);
  // Offset from the other graders so a boot does not fire three database sweeps
  // in the same second, and so the outcome grader has usually already run.
  setTimeout(() => void settlePropBets(), 90 * 1000);
  logger.info({ intervalMinutes: 30 }, "prop-grading: scheduler started");
}
