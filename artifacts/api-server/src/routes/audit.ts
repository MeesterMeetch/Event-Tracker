import { Router, type IRouter } from "express";
import { GetLedgerAuditResponse } from "@workspace/api-zod";
import { runLedgerAudit } from "../lib/ledger-audit";

const router: IRouter = Router();

/**
 * Live corrupt-ledger counts for the dashboard banner. Runs the same checks
 * as the background audit job (and the manual audit script) on demand — the
 * queries are cheap indexed counts over the user's own ledger, so no caching
 * is needed and the banner can never show stale "all clear".
 */
router.get("/ledger-audit", async (_req, res): Promise<void> => {
  const counts = await runLedgerAudit();
  res.json(GetLedgerAuditResponse.parse(counts));
});

export default router;
