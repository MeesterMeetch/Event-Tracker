/**
 * Shared ledger-audit predicates.
 *
 * Single source of truth for what counts as a "corrupt" ledger row, used by
 * BOTH the one-off audit script (scripts/src/audit-impossible-odds.ts) and the
 * API server's automatic background audit — so the two can never drift apart
 * when a rule is added or tuned.
 *
 * Kept free of any runtime import of the db handle (./index) so consumers can
 * use these predicates without connecting to Postgres, and so tests that fake
 * the db module can still exercise the real predicates.
 *
 * The categories:
 *   1. American odds strictly inside (-100, 100) — no sportsbook quotes +50
 *      or -12 (applies to both bets and pitcher-K paper trades).
 *   2. Bets with zero or negative units.
 *   3. Settled bets (won/lost/push) with a NULL pnl — decided but invisible
 *      to profit totals.
 *   4. Bets whose pnl sign contradicts their status: "won" with pnl <= 0 or
 *      "lost" with pnl >= 0.
 *
 * (Phantom P&L on *pending* bets is handled by a separate cleanup and is
 * deliberately not flagged here.)
 */
import { and, eq, gt, gte, inArray, isNull, lt, lte, or, type SQL } from "drizzle-orm";
import type { betsTable, pitcherKPaperTradesTable } from "./schema";

type BetsTable = typeof betsTable;
type PaperTradesTable = typeof pitcherKPaperTradesTable;

/** American odds strictly inside (-100, 100), like +50 or -12. */
export function impossibleOddsWhere(
  col: BetsTable["americanOdds"] | PaperTradesTable["americanOdds"],
): SQL | undefined {
  return and(gt(col, -100), lt(col, 100));
}

/** Bets staked with zero or negative units. */
export function zeroOrNegativeUnitsWhere(bets: BetsTable): SQL | undefined {
  return lte(bets.units, 0);
}

/** Settled (won/lost/push) bets whose pnl is NULL — invisible to profit totals. */
export function settledNullPnlWhere(bets: BetsTable): SQL | undefined {
  return and(inArray(bets.status, ["won", "lost", "push"]), isNull(bets.pnl));
}

/** Bets whose pnl sign contradicts their status (won with pnl <= 0, lost with pnl >= 0). */
export function contradictoryPnlWhere(bets: BetsTable): SQL | undefined {
  return or(
    and(eq(bets.status, "won"), lte(bets.pnl, 0)),
    and(eq(bets.status, "lost"), gte(bets.pnl, 0)),
  );
}
