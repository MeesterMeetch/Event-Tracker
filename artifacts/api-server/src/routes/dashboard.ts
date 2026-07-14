import { Router, type IRouter } from "express";
import { isNull } from "drizzle-orm";
import { db, betsTable, type Bet } from "@workspace/db";
import { GetDashboardSummaryResponse } from "@workspace/api-zod";

const router: IRouter = Router();

function roi(pnl: number, units: number): number {
  if (units <= 0) return 0;
  return Math.round((pnl / units) * 10000) / 100;
}

router.get("/dashboard/summary", async (_req, res): Promise<void> => {
  // Excludes soft-deleted bets so a removed wager stops counting toward
  // profit/ROI immediately; an undo brings its numbers back with it.
  const bets = await db.select().from(betsTable).where(isNull(betsTable.deletedAt));

  const settled = bets.filter((b): b is Bet & { pnl: number } => b.status !== "pending" && b.pnl != null);
  const totalPnl = Math.round(settled.reduce((sum, b) => sum + b.pnl, 0) * 100) / 100;
  const totalUnits = Math.round(settled.reduce((sum, b) => sum + b.units, 0) * 100) / 100;
  // Open exposure: units currently riding on unsettled bets.
  const pendingUnits = Math.round(bets.filter((b) => b.status === "pending").reduce((sum, b) => sum + b.units, 0) * 100) / 100;

  const clvValues = bets.map((b) => b.clvPercent).filter((v): v is number => v != null);
  const avgClvPercent = clvValues.length > 0 ? Math.round((clvValues.reduce((sum, v) => sum + v, 0) / clvValues.length) * 100) / 100 : null;

  const bySportMap = new Map<string, Bet[]>();
  for (const bet of bets) {
    if (!bySportMap.has(bet.sport)) bySportMap.set(bet.sport, []);
    bySportMap.get(bet.sport)!.push(bet);
  }

  const bySport = Array.from(bySportMap.entries()).map(([sport, sportBets]) => {
    const sportSettled = sportBets.filter((b): b is Bet & { pnl: number } => b.status !== "pending" && b.pnl != null);
    const sportPnl = Math.round(sportSettled.reduce((sum, b) => sum + b.pnl, 0) * 100) / 100;
    const sportUnits = Math.round(sportSettled.reduce((sum, b) => sum + b.units, 0) * 100) / 100;
    return {
      sport,
      bets: sportBets.length,
      won: sportBets.filter((b) => b.status === "won").length,
      lost: sportBets.filter((b) => b.status === "lost").length,
      push: sportBets.filter((b) => b.status === "push").length,
      pending: sportBets.filter((b) => b.status === "pending").length,
      roiPercent: roi(sportPnl, sportUnits),
      pnl: sportPnl,
    };
  });
  bySport.sort((a, b) => b.bets - a.bets);

  const summary = {
    totalBets: bets.length,
    won: bets.filter((b) => b.status === "won").length,
    lost: bets.filter((b) => b.status === "lost").length,
    push: bets.filter((b) => b.status === "push").length,
    pending: bets.filter((b) => b.status === "pending").length,
    totalUnits,
    pendingUnits,
    totalPnl,
    roiPercent: roi(totalPnl, totalUnits),
    avgClvPercent,
    clvSampleSize: clvValues.length,
    bySport,
  };

  res.json(GetDashboardSummaryResponse.parse(summary));
});

export default router;
