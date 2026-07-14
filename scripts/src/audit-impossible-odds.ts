/**
 * One-time audit: find bets and pitcher-K paper trades carrying impossible
 * ledger values that would silently skew profit/ROI:
 *
 *   1. American odds strictly inside (-100, 100), like +50 or -12, which no
 *      sportsbook quotes (both bets and pitcher-K paper trades).
 *   2. Bets with zero or negative units.
 *   3. Settled bets (won/lost/push) with a NULL pnl — they'd be invisible to
 *      profit totals despite being decided.
 *   4. Bets whose pnl sign contradicts their status: "won" with pnl <= 0 or
 *      "lost" with pnl >= 0.
 *   5. Push bets carrying a nonzero pnl — a push always returns the stake, so
 *      any profit or loss on it is impossible.
 *
 * (Phantom P&L on *pending* bets is handled by a separate cleanup and is
 * deliberately not flagged here.)
 *
 * New writes are rejected by the API/web/mobile forms, but rows logged before
 * those guards existed could still sit in the ledger.
 *
 * Usage:  pnpm --filter @workspace/scripts run audit-odds
 *
 * The script is read-only. It prints every offending row (including
 * soft-deleted ones, marked as such) with enough context — game, selection,
 * odds, units, pnl, status — to find and correct or delete it through the
 * existing edit flows (web Bet Log edit dialog, mobile Edit Bet sheet, or the
 * scorecard's delete for paper trades). Exit code 1 signals offending rows
 * were found, 0 means the ledger is clean.
 */
import { db, pool, betsTable, pitcherKPaperTradesTable } from "@workspace/db";
import type { Bet } from "@workspace/db";
// The what-counts-as-corrupt predicates are shared with the API server's
// automatic background audit so the two can never drift apart.
import {
  impossibleOddsWhere,
  zeroOrNegativeUnitsWhere,
  settledNullPnlWhere,
  contradictoryPnlWhere,
  pushNonzeroPnlWhere,
} from "@workspace/db/audit";

function fmtOdds(odds: number): string {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

function fmtBetRow(b: Bet): string {
  const del = b.deletedAt ? " [soft-deleted]" : "";
  return `  #${b.id}${del} ${b.sport} ${b.awayTeam} @ ${b.homeTeam} | ${b.market} ${b.selection}${b.point != null ? ` ${b.point}` : ""} | odds ${fmtOdds(b.americanOdds)} | ${b.units}u | status ${b.status} | pnl ${b.pnl ?? "—"}`;
}

/** Print one bet-audit category; returns the number of offending rows. */
function reportBetCategory(heading: string, rows: Bet[], guidance: string): number {
  if (rows.length === 0) {
    console.log(`bets — ${heading}: clean.`);
  } else {
    console.log(`bets — ${heading}: ${rows.length} offending row(s):`);
    for (const b of rows) console.log(fmtBetRow(b));
    console.log(`  → ${guidance}`);
  }
  console.log("");
  return rows.length;
}

async function main() {
  const badBets = await db
    .select()
    .from(betsTable)
    .where(impossibleOddsWhere(betsTable.americanOdds));

  const zeroUnitBets = await db
    .select()
    .from(betsTable)
    .where(zeroOrNegativeUnitsWhere(betsTable));

  const settledNullPnlBets = await db
    .select()
    .from(betsTable)
    .where(settledNullPnlWhere(betsTable));

  const contradictoryPnlBets = await db
    .select()
    .from(betsTable)
    .where(contradictoryPnlWhere(betsTable));

  const pushNonzeroPnlBets = await db
    .select()
    .from(betsTable)
    .where(pushNonzeroPnlWhere(betsTable));

  const badTrades = await db
    .select()
    .from(pitcherKPaperTradesTable)
    .where(impossibleOddsWhere(pitcherKPaperTradesTable.americanOdds));

  console.log("Audit: impossible ledger values\n");

  let betTotal = 0;
  betTotal += reportBetCategory(
    "American odds strictly inside (-100, 100)",
    badBets,
    "Fix each via the web Bet Log edit dialog (correct the odds) or delete the bet if it was a typo.",
  );
  betTotal += reportBetCategory(
    "zero or negative units",
    zeroUnitBets,
    "Fix the stake via the web Bet Log edit dialog, or delete the bet if it was never real.",
  );
  betTotal += reportBetCategory(
    "settled (won/lost/push) but pnl is NULL",
    settledNullPnlBets,
    "Re-grade the bet (set the result again via the edit dialog) so its pnl is recomputed and counted in profit/ROI.",
  );
  betTotal += reportBetCategory(
    "pnl sign contradicts status (won with pnl <= 0, lost with pnl >= 0)",
    contradictoryPnlBets,
    "Re-grade the bet via the edit dialog — either the status or the pnl is wrong, and totals are being skewed either way.",
  );
  betTotal += reportBetCategory(
    "push with nonzero pnl (a push must have pnl = 0)",
    pushNonzeroPnlBets,
    "Re-grade the bet via the edit dialog — either the status or the pnl is wrong, and totals are being skewed either way.",
  );

  if (badTrades.length === 0) {
    console.log("pitcher_k_paper_trades: clean — no rows with impossible odds.");
  } else {
    console.log(`pitcher_k_paper_trades: ${badTrades.length} offending row(s):`);
    for (const t of badTrades) {
      const del = t.deletedAt ? " [soft-deleted]" : "";
      console.log(
        `  #${t.id}${del} ${t.pitcher} ${t.selection} ${t.point} Ks (${t.awayTeam} @ ${t.homeTeam}) | odds ${fmtOdds(t.americanOdds)} @ ${t.book} | ${t.recommendedUnits}u rec | status ${t.status}`,
      );
    }
    console.log(
      "  → Correct the price via the scorecard's edit (pencil) button — this keeps the edge snapshot and any captured closing line, and recomputes CLV from the corrected price. Only delete if the pick itself was logged in error.",
    );
  }

  const total = betTotal + badTrades.length;
  console.log(
    `\n${total === 0 ? "Ledger is clean. Dashboard profit/ROI are unaffected by impossible values." : `${total} row(s) need attention before profit/ROI can be trusted.`}`,
  );
  await pool.end();
  process.exitCode = total > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error("Audit failed:", err);
  process.exitCode = 2;
});
