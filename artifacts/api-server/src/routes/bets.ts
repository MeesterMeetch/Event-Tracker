import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, betsTable } from "@workspace/db";
import { calcPnl } from "../lib/grading-math";
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
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/bets", async (req, res): Promise<void> => {
  const parsed = ListBetsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const bets = parsed.data.status
    ? await db.select().from(betsTable).where(eq(betsTable.status, parsed.data.status))
    : await db.select().from(betsTable);

  bets.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  res.json(ListBetsResponse.parse(bets));
});

router.post("/bets", async (req, res): Promise<void> => {
  const parsed = CreateBetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (parsed.data.americanOdds === 0) {
    res.status(400).json({ error: "americanOdds cannot be 0" });
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

  const [bet] = await db.select().from(betsTable).where(eq(betsTable.id, params.data.id));
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
  if (parsed.data.americanOdds === 0) {
    res.status(400).json({ error: "americanOdds cannot be 0" });
    return;
  }

  const [existing] = await db.select().from(betsTable).where(eq(betsTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Bet not found" });
    return;
  }

  // Keep `status` and `pnl` in lockstep: settling a bet always needs a pnl,
  // and reopening it back to pending always clears any stale pnl. A pnl
  // explicitly provided alongside a settled status is treated as a manual
  // correction (e.g. fixing a graded amount) and takes precedence.
  const nextStatus = parsed.data.status ?? existing.status;
  const nextOdds = parsed.data.americanOdds ?? existing.americanOdds;
  const nextUnits = parsed.data.units ?? existing.units;
  let nextPnl = parsed.data.pnl;
  if (nextPnl === undefined) {
    nextPnl = nextStatus === "won" || nextStatus === "lost" || nextStatus === "push" ? calcPnl(nextStatus, nextOdds, nextUnits) : null;
  }

  const [bet] = await db
    .update(betsTable)
    .set({ ...parsed.data, pnl: nextPnl })
    .where(eq(betsTable.id, params.data.id))
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

  const [bet] = await db.delete(betsTable).where(eq(betsTable.id, params.data.id)).returning();
  if (!bet) {
    res.status(404).json({ error: "Bet not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
