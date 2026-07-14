import { Router, type IRouter } from "express";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { db, pitcherKPaperTradesTable } from "@workspace/db";
import { purgeExpiredPaperTradeTombstones } from "../lib/tombstones";
import {
  ListPaperTradesQueryParams,
  ListPaperTradesResponse,
  CreatePaperTradeBody,
  CreatePaperTradeResponse,
  GetPaperTradeSummaryResponse,
  RestorePaperTradeResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const round2 = (n: number | null): number | null => (n == null ? null : Math.round(n * 100) / 100);

router.get("/paper-trades", async (req, res): Promise<void> => {
  const parsed = ListPaperTradesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Soft-deleted rows are pending-undo tombstones, never listed.
  const notDeleted = isNull(pitcherKPaperTradesTable.deletedAt);
  const rows = await db
    .select()
    .from(pitcherKPaperTradesTable)
    .where(
      parsed.data.status ? and(eq(pitcherKPaperTradesTable.status, parsed.data.status), notDeleted) : notDeleted,
    )
    .orderBy(desc(pitcherKPaperTradesTable.createdAt));

  res.json(ListPaperTradesResponse.parse(rows));
});

// Registered before "/paper-trades/:id" so "summary" isn't swallowed as an id.
router.get("/paper-trades/summary", async (_req, res): Promise<void> => {
  // Excludes soft-deleted rows so a removed pick stops counting immediately;
  // an undo brings its numbers back with it.
  const rows = await db
    .select()
    .from(pitcherKPaperTradesTable)
    .where(isNull(pitcherKPaperTradesTable.deletedAt));

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

  // Re-logging a pick whose earlier row was soft-deleted (sitting in the undo
  // grace window) must succeed: the tombstone still holds the pick's unique
  // slot, so clear it first. This forfeits the pending undo for that pick —
  // the freshly logged row supersedes it.
  await db
    .delete(pitcherKPaperTradesTable)
    .where(
      and(
        eq(pitcherKPaperTradesTable.gameId, d.gameId),
        eq(pitcherKPaperTradesTable.pitcher, d.pitcher),
        eq(pitcherKPaperTradesTable.selection, d.selection),
        eq(pitcherKPaperTradesTable.point, d.point),
        eq(pitcherKPaperTradesTable.book, d.book),
        isNotNull(pitcherKPaperTradesTable.deletedAt),
      ),
    );

  // One scorecard row per pick. The insert defers to the DB's unique index on
  // (gameId, pitcher, selection, point, book) rather than a check-then-insert,
  // so two concurrent requests can't both slip through — the loser gets no row
  // back and is told the pick already exists.
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
    .onConflictDoNothing({
      target: [
        pitcherKPaperTradesTable.gameId,
        pitcherKPaperTradesTable.pitcher,
        pitcherKPaperTradesTable.selection,
        pitcherKPaperTradesTable.point,
        pitcherKPaperTradesTable.book,
      ],
    })
    .returning();

  if (!row) {
    res.status(409).json({
      error: `Already logged: ${d.pitcher} ${d.selection} ${d.point} K @ ${d.book}. Each pick counts once in the scorecard.`,
    });
    return;
  }

  res.status(201).json(CreatePaperTradeResponse.parse(row));
});

router.delete("/paper-trades/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid paper trade id" });
    return;
  }

  // Opportunistically purge tombstones past the grace window so a re-log of
  // the same pick isn't blocked; the periodic scheduler (lib/tombstones) is
  // the guarantee that stragglers get cleaned even if deletes stop.
  await purgeExpiredPaperTradeTombstones();

  // Soft delete: stamp deletedAt instead of dropping the row, so an immediate
  // undo can restore the exact record — logged odds, edge snapshot, and any
  // captured closing-line data — which a re-create could not reproduce.
  const [deleted] = await db
    .update(pitcherKPaperTradesTable)
    .set({ deletedAt: new Date() })
    .where(and(eq(pitcherKPaperTradesTable.id, id), isNull(pitcherKPaperTradesTable.deletedAt)))
    .returning();
  if (!deleted) {
    res.status(404).json({ error: "Paper trade not found" });
    return;
  }

  res.sendStatus(204);
});

router.post("/paper-trades/:id/restore", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid paper trade id" });
    return;
  }

  // Only a soft-deleted row can be restored; the guard doubles as protection
  // against double-tapping Undo (the second tap 404s instead of doing harm).
  const [restored] = await db
    .update(pitcherKPaperTradesTable)
    .set({ deletedAt: null })
    .where(and(eq(pitcherKPaperTradesTable.id, id), isNotNull(pitcherKPaperTradesTable.deletedAt)))
    .returning();
  if (!restored) {
    res.status(404).json({ error: "This pick can no longer be restored." });
    return;
  }

  res.json(RestorePaperTradeResponse.parse(restored));
});

export default router;
