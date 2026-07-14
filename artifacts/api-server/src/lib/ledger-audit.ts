import { db, betsTable, pitcherKPaperTradesTable } from "@workspace/db";
// Predicates are shared with scripts/src/audit-impossible-odds.ts so the
// automatic audit and the manual script can never drift apart.
import {
  impossibleOddsWhere,
  zeroOrNegativeUnitsWhere,
  settledNullPnlWhere,
  contradictoryPnlWhere,
  pushNonzeroPnlWhere,
} from "@workspace/db/audit";
import { logger } from "./logger";

export interface LedgerAuditCounts {
  impossibleOddsBets: number;
  zeroOrNegativeUnitBets: number;
  settledNullPnlBets: number;
  contradictoryPnlBets: number;
  pushNonzeroPnlBets: number;
  impossibleOddsPaperTrades: number;
  total: number;
}

/**
 * Runs the corrupt-row checks (same predicates as the audit script) and
 * returns per-category counts. Read-only; includes soft-deleted rows just
 * like the script, since a corrupt tombstone becomes a corrupt live row the
 * moment it's restored.
 */
export async function runLedgerAudit(): Promise<LedgerAuditCounts> {
  const [badOddsBets, zeroUnitBets, settledNullPnl, contradictoryPnl, pushNonzeroPnl, badOddsTrades] =
    await Promise.all([
      db.select().from(betsTable).where(impossibleOddsWhere(betsTable.americanOdds)),
      db.select().from(betsTable).where(zeroOrNegativeUnitsWhere(betsTable)),
      db.select().from(betsTable).where(settledNullPnlWhere(betsTable)),
      db.select().from(betsTable).where(contradictoryPnlWhere(betsTable)),
      db.select().from(betsTable).where(pushNonzeroPnlWhere(betsTable)),
      db
        .select()
        .from(pitcherKPaperTradesTable)
        .where(impossibleOddsWhere(pitcherKPaperTradesTable.americanOdds)),
    ]);

  const counts = {
    impossibleOddsBets: badOddsBets.length,
    zeroOrNegativeUnitBets: zeroUnitBets.length,
    settledNullPnlBets: settledNullPnl.length,
    contradictoryPnlBets: contradictoryPnl.length,
    pushNonzeroPnlBets: pushNonzeroPnl.length,
    impossibleOddsPaperTrades: badOddsTrades.length,
  };
  return {
    ...counts,
    total:
      counts.impossibleOddsBets +
      counts.zeroOrNegativeUnitBets +
      counts.settledNullPnlBets +
      counts.contradictoryPnlBets +
      counts.pushNonzeroPnlBets +
      counts.impossibleOddsPaperTrades,
  };
}

let auditRunning = false;

/**
 * One scheduled audit pass: warn (with per-category counts) when corrupt rows
 * exist, stay silent when the ledger is clean — so a clean ledger produces no
 * behavior change and no log noise.
 */
export async function runScheduledLedgerAudit(): Promise<void> {
  if (auditRunning) return;
  auditRunning = true;
  try {
    const counts = await runLedgerAudit();
    if (counts.total > 0) {
      logger.warn(
        { ...counts },
        `ledger-audit: ${counts.total} corrupt row(s) are skewing profit/ROI — fix them via the web Bet Log edit dialog or the scorecard edit (run \`pnpm --filter @workspace/scripts run audit-odds\` for row-level detail)`,
      );
    }
  } catch (err) {
    logger.error({ err }, "ledger-audit: run failed");
  } finally {
    auditRunning = false;
  }
}

const AUDIT_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Periodic corrupt-ledger watchdog. Deliberately its own scheduler (like the
 * tombstone purge) rather than piggybacking on a CLV job: those never start
 * when ODDS_API_KEY is missing, and ledger integrity must not depend on odds
 * access. Runs shortly after boot so corruption is flagged within a minute of
 * startup, then hourly — the checks are cheap read-only queries.
 */
export function startLedgerAudit(): void {
  setInterval(() => void runScheduledLedgerAudit(), AUDIT_INTERVAL_MS);
  setTimeout(() => void runScheduledLedgerAudit(), 30 * 1000);
  logger.info({ intervalMinutes: AUDIT_INTERVAL_MS / 60000 }, "ledger-audit: scheduler started");
}
