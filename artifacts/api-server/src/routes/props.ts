import { Router, type IRouter } from "express";
import { ListPropEdgesQueryParams, ListPropEdgesResponse } from "@workspace/api-zod";
import { fetchEventOdds, logRequestsRemaining } from "../lib/odds";
import { computePropEdges, getPropMarkets } from "../lib/props";
import { isSupportedSport } from "../lib/sports";

const router: IRouter = Router();

const DEFAULT_MIN_EDGE_PERCENT = 1;

router.get("/prop-edges", async (req, res): Promise<void> => {
  const parsed = ListPropEdgesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { sport, eventId, minEdgePercent } = parsed.data;
  if (!(await isSupportedSport(sport))) {
    res.status(400).json({ error: `Unsupported sport: ${sport}` });
    return;
  }

  const markets = getPropMarkets(sport);
  if (!markets) {
    res.status(400).json({ error: "Player props are not available for this sport yet." });
    return;
  }

  try {
    const { data, requestsRemaining } = await fetchEventOdds(sport, eventId, markets);
    logRequestsRemaining("prop-edges", requestsRemaining);
    const edges = computePropEdges(data, sport, minEdgePercent ?? DEFAULT_MIN_EDGE_PERCENT);
    res.json(ListPropEdgesResponse.parse(edges));
  } catch (err) {
    req.log.error({ err, sport, eventId }, "prop-edges: failed to fetch/compute player props");
    res.status(502).json({ error: "Failed to fetch player props. Try again shortly." });
  }
});

export default router;
