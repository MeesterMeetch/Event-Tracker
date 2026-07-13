import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, pitcherKPaperTradesTable } from "@workspace/db";
import {
  ListPaperTradesQueryParams,
  ListPaperTradesResponse,
  CreatePaperTradeBody,
  CreatePaperTradeResponse,
  GetPaperTradeSummaryResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const round2 = (n: number | null): number | null => (n == null ? null : Math.round(n * 100) / 100);

router.get("/paper-trades", async (req, res): Promise<void> => {
  const parsed = ListPaperTradesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const rows = parsed.data.status
    ? await db
        .select()
        .from(pitcherKPaperTradesTable)
        .where(eq(pitcherKPaperTradesTable.status, parsed.data.status))
        .orderBy(desc(pitcherKPaperTradesTable.createdAt))
    : await db.select().from(pitcherKPaperTradesTable).orderBy(desc(pitcherKPaperTradesTable.createdAt));

  res.json(ListPaperTradesResponse.parse(rows));
});

// Registered before "/paper-trades/:id" so "summary" isn't swallowed as an id.
router.get("/paper-trades/summary", async (_req, res): Promise<void> => {
  const rows = await db.select().from(pitcherKPaperTradesTable);

  const total = rows.length;
  const open = rows.filter((r) => r.status === "open").length;
  const closed = rows.filter((r) => r.status === "closed").length;
  const expired = rows.filter((r) => r.status === "expired").length;

  const graded = rows.filter((r) => r.clvPercent != null);
  const gradedCount = graded.length;
  const beatCloseCount = graded.filter((r) => r.beatClose === true).length;
  const beatCloseRate = gradedCount > 0 ? beatCloseCount / gradedCount : null;
  const avgClvPercent = gradedCount > 0 ? graded.reduce((s, r) => s + (r.clvPercent ?? 0), 0) / gradedCount : null;

  const withEdge = rows.filter((r) => r.edgePercent != null);
  const avgEdgePercent = withEdge.length > 0 ? withEdge.reduce((s, r) => s + (r.edgePercent ?? 0), 0) / withEdge.length : null;

  res.json(
    GetPaperTradeSummaryResponse.parse({
      total,
      open,
      closed,
      expired,
      gradedCount,
      beatCloseCount,
      beatCloseRate: round2(beatCloseRate),
      avgClvPercent: round2(avgClvPercent),
      avgEdgePercent: round2(avgEdgePercent),
    }),
  );
});

router.post("/paper-trades", async (req, res): Promise<void> => {
  const parsed = CreatePaperTradeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const d = parsed.data;
  if (d.americanOdds === 0) {
    res.status(400).json({ error: "americanOdds cannot be 0" });
    return;
  }
  // Probabilities feed the beat-the-close/CLV math directly, so reject anything
  // outside (0,1) rather than let it silently corrupt the validation stats.
  const inUnitInterval = (p: number) => p > 0 && p < 1;
  if (!inUnitInterval(d.modelProb) || (d.marketProb != null && !inUnitInterval(d.marketProb))) {
    res.status(400).json({ error: "Probabilities must be between 0 and 1 (exclusive)." });
    return;
  }

  const [row] = await db
    .insert(pitcherKPaperTradesTable)
    .values({
      ...d,
      commenceTime: new Date(d.commenceTime),
      pitcherId: d.pitcherId ?? null,
      marketProb: d.marketProb ?? null,
      edgePercent: d.edgePercent ?? null,
      isFlagged: d.isFlagged ?? null,
      status: "open",
    })
    .returning();

  res.status(201).json(CreatePaperTradeResponse.parse(row));
});

router.delete("/paper-trades/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid paper trade id" });
    return;
  }

  const [deleted] = await db.delete(pitcherKPaperTradesTable).where(eq(pitcherKPaperTradesTable.id, id)).returning();
  if (!deleted) {
    res.status(404).json({ error: "Paper trade not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
