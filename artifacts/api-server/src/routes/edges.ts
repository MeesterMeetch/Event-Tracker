import { Router, type IRouter } from "express";
import { ListEdgesQueryParams, ListEdgesResponse } from "@workspace/api-zod";
import { fetchOdds } from "../lib/odds";
import { computeEdges } from "../lib/ev";
import { isSupportedSport } from "../lib/sports";
import { recordOddsSnapshotInBackground } from "../lib/odds-recorder";

const router: IRouter = Router();

const DEFAULT_MIN_EDGE_PERCENT = 1;

router.get("/edges", async (req, res): Promise<void> => {
  const parsed = ListEdgesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { sport, minEdgePercent } = parsed.data;
  if (!(await isSupportedSport(sport))) {
    res.status(400).json({ error: `Unsupported sport: ${sport}` });
    return;
  }

  try {
    const { data } = await fetchOdds(sport);
    // Persist the full payload, not just the edges. Every price we discard here
    // is a row a future backtest cannot have. Fire-and-forget so history
    // collection can never slow down or fail this request.
    recordOddsSnapshotInBackground(data, sport);
    const edges = computeEdges(data, sport, minEdgePercent ?? DEFAULT_MIN_EDGE_PERCENT);
    res.json(ListEdgesResponse.parse(edges));
  } catch (err) {
    req.log.error({ err, sport }, "edges: failed to fetch/compute odds");
    res.status(502).json({ error: "Failed to fetch live odds. Try again shortly." });
  }
});

export default router;
