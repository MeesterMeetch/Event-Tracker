import { Router, type IRouter } from "express";
import { and, eq, isNull, isNotNull } from "drizzle-orm";
import { db, betsTable } from "@workspace/db";
import { calcPnl } from "../lib/grading-math";
import { purgeExpiredBetTombstones } from "../lib/tombstones";
import {
  ListBetsQueryParams,
  ListBetsResponse,
  CreateBetBody,
  CreateBetResponse,
  GetBetParams,
  GetBetResponse,
  UpdateBetParams,
  UpdateBetBody,
  UpdateBetResponse,
  DeleteBetParams,
  RestoreBetResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/bets", async (req, res): Promise<void> => {
  const parsed = ListBetsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Soft-deleted rows are pending-undo tombstones, never listed.
  const notDeleted = isNull(betsTable.deletedAt);
  const bets = await db
    .select()
    .from(betsTable)
    .where(parsed.data.status ? and(eq(betsTable.status, parsed.data.status), notDeleted) : notDeleted);

  bets.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  res.json(ListBetsResponse.parse(bets));
});

router.post("/bets", async (req, res): Promise<void> => {
  const parsed = CreateBetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // Impossible American odds (the open interval (-100, 100), incl. 0) are
  // rejected by CreateBetBody itself — the shared zod schema generated from
  // the OpenAPI spec — so bad prices never reach calcPnl here or in grading.

  // The bet log is a staking record: logging the same open wager twice would
  // double-count its units in profit and ROI. A bet is "the same" when it
  // targets the identical priced outcome — game, market, selection, point,
  // and book. Only *pending* bets block a re-log: once the earlier bet
  // settles, backing the same market again is a legitimate new wager, so no
  // DB unique index fits here (unlike paper trades, where a pick counts once
  // forever). A check-then-insert race is acceptable for this single-user
  // log — the failure mode is one duplicate, not corrupted stats.
  const d = parsed.data;
  const point = d.point ?? null;
  const book = d.book ?? null;

  // Re-logging a wager whose earlier row was soft-deleted (sitting in the
  // undo grace window) must succeed without tripping the duplicate guard:
  // purge any matching pending tombstone first. This forfeits the pending
  // undo for that wager — the freshly logged bet supersedes it, so a stale
  // Undo tap can't resurrect the old row into a double-counted duplicate.
  await db
    .delete(betsTable)
    .where(
      and(
        eq(betsTable.gameId, d.gameId),
        eq(betsTable.market, d.market),
        eq(betsTable.selection, d.selection),
        point == null ? isNull(betsTable.point) : eq(betsTable.point, point),
        book == null ? isNull(betsTable.book) : eq(betsTable.book, book),
        eq(betsTable.status, "pending"),
        isNotNull(betsTable.deletedAt),
      ),
    );

  const [duplicate] = await db
    .select()
    .from(betsTable)
    .where(
      and(
        eq(betsTable.gameId, d.gameId),
        eq(betsTable.market, d.market),
        eq(betsTable.selection, d.selection),
        point == null ? isNull(betsTable.point) : eq(betsTable.point, point),
        book == null ? isNull(betsTable.book) : eq(betsTable.book, book),
        eq(betsTable.status, "pending"),
        isNull(betsTable.deletedAt),
      ),
    );
  if (duplicate) {
    const label = `${d.selection}${point != null ? ` ${point}` : ""}${book ? ` @ ${book}` : ""}`;
    res.status(409).json({
      error: `Already in your bet log: ${label}. That bet is still open — settle or delete it before logging it again.`,
    });
    return;
  }

  const [bet] = await db
    .insert(betsTable)
    .values({
      ...parsed.data,
      commenceTime: new Date(parsed.data.commenceTime),
      status: "pending",
      pnl: null,
    })
    .returning();

  res.status(201).json(CreateBetResponse.parse(bet));
});

router.get("/bets/:id", async (req, res): Promise<void> => {
  const params = GetBetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  // A soft-deleted bet is invisible everywhere except the restore endpoint.
  const [bet] = await db
    .select()
    .from(betsTable)
    .where(and(eq(betsTable.id, params.data.id), isNull(betsTable.deletedAt)));
  if (!bet) {
    res.status(404).json({ error: "Bet not found" });
    return;
  }

  res.json(GetBetResponse.parse(bet));
});

router.patch("/bets/:id", async (req, res): Promise<void> => {
  const params = UpdateBetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateBetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // Impossible American odds (the open interval (-100, 100), incl. 0) are
  // rejected by UpdateBetBody itself — the shared zod schema generated from
  // the OpenAPI spec — so a bad price can never re-freeze or skew P&L math.

  // A soft-deleted bet can't be edited or settled — it must be restored first.
  const [existing] = await db
    .select()
    .from(betsTable)
    .where(and(eq(betsTable.id, params.data.id), isNull(betsTable.deletedAt)));
  if (!existing) {
    res.status(404).json({ error: "Bet not found" });
    return;
  }

  // Keep `status` and `pnl` in lockstep: settling a bet always needs a pnl,
  // and reopening it back to pending always clears any stale pnl. A pnl
  // explicitly provided alongside a settled status is treated as a manual
  // correction (e.g. fixing a graded amount) and takes precedence.
  const nextStatus = parsed.data.status ?? existing.status;

  // A pending bet must never carry a realized P&L — dashboard math treats
  // settled ⟺ pnl as an invariant. An explicit non-null pnl combined with a
  // (resulting) pending status is a contradiction, so reject it outright
  // rather than silently nulling the caller's value.
  if (nextStatus === "pending" && parsed.data.pnl != null) {
    res.status(400).json({
      error: "A pending bet cannot have a P&L. Settle the bet (won/lost/push) to record a result.",
    });
    return;
  }

  const nextOdds = parsed.data.americanOdds ?? existing.americanOdds;
  const nextUnits = parsed.data.units ?? existing.units;
  let nextPnl = parsed.data.pnl;
  if (nextPnl === undefined) {
    nextPnl = nextStatus === "won" || nextStatus === "lost" || nextStatus === "push" ? calcPnl(nextStatus, nextOdds, nextUnits) : null;
  }

  const [bet] = await db
    .update(betsTable)
    .set({ ...parsed.data, pnl: nextPnl })
    .where(and(eq(betsTable.id, params.data.id), isNull(betsTable.deletedAt)))
    .returning();
  if (!bet) {
    res.status(404).json({ error: "Bet not found" });
    return;
  }

  res.json(UpdateBetResponse.parse(bet));
});

router.delete("/bets/:id", async (req, res): Promise<void> => {
  const params = DeleteBetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  // Opportunistically purge tombstones past the grace window so soft-deleted
  // rows can't accumulate invisibly. (The periodic scheduler in
  // lib/tombstones.ts is the safety net when delete traffic stops.)
  await purgeExpiredBetTombstones();

  // Soft delete: stamp deletedAt instead of dropping the row, so an immediate
  // undo can restore the exact record — logged odds, units, settled P&L, and
  // any captured closing-line/CLV data — which a re-create could not
  // reproduce.
  const [deleted] = await db
    .update(betsTable)
    .set({ deletedAt: new Date() })
    .where(and(eq(betsTable.id, params.data.id), isNull(betsTable.deletedAt)))
    .returning();
  if (!deleted) {
    res.status(404).json({ error: "Bet not found" });
    return;
  }

  res.sendStatus(204);
});

router.post("/bets/:id/restore", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid bet id" });
    return;
  }

  // Enforce the grace window at the restore boundary itself: purge any
  // tombstones past it first, so an old deleted bet can't be resurrected
  // long after the user believed it gone — even if no intervening delete
  // ever triggered the opportunistic purge.
  await purgeExpiredBetTombstones();

  // Only a soft-deleted row still inside the grace window can be restored;
  // the guard doubles as protection against double-tapping Undo (the second
  // tap 404s instead of doing harm).
  const [restored] = await db
    .update(betsTable)
    .set({ deletedAt: null })
    .where(and(eq(betsTable.id, id), isNotNull(betsTable.deletedAt)))
    .returning();
  if (!restored) {
    res.status(404).json({ error: "This bet can no longer be restored." });
    return;
  }

  res.json(RestoreBetResponse.parse(restored));
});

export default router;
