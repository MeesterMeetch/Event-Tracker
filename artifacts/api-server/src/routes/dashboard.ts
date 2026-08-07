import { Router, type IRouter } from "express";
import { isNull } from "drizzle-orm";
import { db, betsTable, type Bet } from "@workspace/db";
import { GetDashboardSummaryQueryParams, GetDashboardSummaryResponse } from "@workspace/api-zod";

const router: IRouter = Router();

function roi(pnl: number, units: number): number {
  if (units <= 0) return 0;
  return Math.round((pnl / units) * 10000) / 100;
}

router.get("/dashboard/summary", async (req, res): Promise<void> => {
  const parsed = GetDashboardSummaryQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { from, to, basis } = parsed.data;

  const fromDate = from != null ? new Date(from) : null;
  if (fromDate != null && Number.isNaN(fromDate.getTime())) {
    res.status(400).json({ error: "from is not a valid ISO 8601 instant" });
    return;
  }
  const toDate = to != null ? new Date(to) : null;
  if (toDate != null && Number.isNaN(toDate.getTime())) {
    res.status(400).json({ error: "to is not a valid ISO 8601 instant" });
    return;
  }
  if (fromDate != null && toDate != null && toDate.getTime() <= fromDate.getTime()) {
    res.status(400).json({ error: "to must be after from" });
    return;
  }

  // "game" reads the date a bet was played, which is what "how did I do in
  // July" almost always means. "logged" reads when it was entered, which
  // answers a different question about your own activity: a game logged today
  // for next week lands in today under "logged" and in next week under "game".
  const useLogged = basis === "logged";

  // Excludes soft-deleted bets so a removed wager stops counting toward
  // profit/ROI immediately; an undo brings its numbers back with it.
  const allBets = await db.select().from(betsTable).where(isNull(betsTable.deletedAt));

  // Filtered here rather than in SQL. A personal bet log is small enough that
  // the round trip is identical either way, and the drizzle test fake only
  // understands eq and desc, so pushing this down would mean teaching it range
  // predicates to gain nothing measurable.
  const bets = allBets.filter((b) => {
    const raw = useLogged ? b.createdAt : b.commenceTime;
    const t = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
    if (!Number.isFinite(t)) return false;
    if (fromDate != null && t < fromDate.getTime()) return false;
    // Exclusive upper bound, so a caller passing the start of the next day gets
    // exactly one day without straddling midnight.
    if (toDate != null && t >= toDate.getTime()) return false;
    return true;
  });

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
      // Open exposure for this sport — mirrors top-level pendingUnits so
      // clients can show where unsettled stake is concentrated.
      pendingUnits: Math.round(sportBets.filter((b) => b.status === "pending").reduce((sum, b) => sum + b.units, 0) * 100) / 100,
      // Realized settled stake — mirrors top-level totalUnits so clients can
      // mute a sport's P&L/ROI until results are actually in.
      settledUnits: sportUnits,
      roiPercent: roi(sportPnl, sportUnits),
      pnl: sportPnl,
    };
  });
  bySport.sort((a, b) => b.bets - a.bets);

  const summary = {
    // Echoed back so the client can label what it is looking at rather than
    // assuming its own request was applied.
    filterFrom: fromDate?.toISOString() ?? null,
    filterTo: toDate?.toISOString() ?? null,
    filterBasis: useLogged ? "logged" : "game",
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
