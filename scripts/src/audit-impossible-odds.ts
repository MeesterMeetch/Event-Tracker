/**
 * One-time audit: find bets and pitcher-K paper trades logged with impossible
 * American odds — values strictly inside (-100, 100), like +50 or -12, which
 * no sportsbook quotes. New writes are rejected by the API/web/mobile forms,
 * but rows logged before that guard existed could still sit in the ledger and
 * skew profit/ROI forever.
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
import { and, gt, lt } from "drizzle-orm";

const impossible = (col: typeof betsTable.americanOdds | typeof pitcherKPaperTradesTable.americanOdds) =>
  and(gt(col, -100), lt(col, 100));

function fmtOdds(odds: number): string {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

async function main() {
  const badBets = await db
    .select()
    .from(betsTable)
    .where(impossible(betsTable.americanOdds));

  const badTrades = await db
    .select()
    .from(pitcherKPaperTradesTable)
    .where(impossible(pitcherKPaperTradesTable.americanOdds));

  console.log("Audit: American odds strictly inside (-100, 100)\n");

  if (badBets.length === 0) {
    console.log("bets: clean — no rows with impossible odds.");
  } else {
    console.log(`bets: ${badBets.length} offending row(s):`);
    for (const b of badBets) {
      const del = b.deletedAt ? " [soft-deleted]" : "";
      console.log(
        `  #${b.id}${del} ${b.sport} ${b.awayTeam} @ ${b.homeTeam} | ${b.market} ${b.selection}${b.point != null ? ` ${b.point}` : ""} | odds ${fmtOdds(b.americanOdds)} | ${b.units}u | status ${b.status} | pnl ${b.pnl ?? "—"}`,
      );
    }
    console.log(
      "  → Fix each via the web Bet Log edit dialog (correct the odds) or delete the bet if it was a typo.",
    );
  }

  console.log("");

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
      "  → Paper trades have no odds-edit flow; delete the offending pick from the scorecard and re-log it at the real price if it's still open.",
    );
  }

  const total = badBets.length + badTrades.length;
  console.log(
    `\n${total === 0 ? "Ledger is clean. Dashboard profit/ROI are unaffected by impossible odds." : `${total} row(s) need attention before profit/ROI can be trusted.`}`,
  );
  await pool.end();
  process.exitCode = total > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error("Audit failed:", err);
  process.exitCode = 2;
});
