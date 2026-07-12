import { Router, type IRouter } from "express";
import { ListModelEdgesQueryParams, ListModelEdgesResponse } from "@workspace/api-zod";
import { fetchEventOdds, logRequestsRemaining } from "../lib/odds";
import { getMatchupKInputs } from "../lib/mlb";
import { computeModelEdges, MODEL_SPORT_KEY, PITCHER_K_MARKET } from "../lib/pitcher-k-scanner";
import { DEFAULT_KELLY_MULTIPLIER } from "../lib/pitcher-k-model";

const router: IRouter = Router();

const DEFAULT_MIN_EDGE_PERCENT = 1;

router.get("/model-edges", async (req, res): Promise<void> => {
  const parsed = ListModelEdgesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { sport, eventId, minEdgePercent, kellyMultiplier } = parsed.data;
  if (sport !== MODEL_SPORT_KEY) {
    res.status(400).json({ error: "The strikeout projection model currently supports MLB only." });
    return;
  }

  try {
    const { data, requestsRemaining } = await fetchEventOdds(sport, eventId, [PITCHER_K_MARKET]);
    logRequestsRemaining("model-edges", requestsRemaining);

    const inputs = await getMatchupKInputs(data.home_team, data.away_team, data.commence_time);
    const projections = computeModelEdges(
      data,
      sport,
      inputs,
      minEdgePercent ?? DEFAULT_MIN_EDGE_PERCENT,
      kellyMultiplier ?? DEFAULT_KELLY_MULTIPLIER,
    );

    res.json(ListModelEdgesResponse.parse(projections));
  } catch (err) {
    req.log.error({ err, sport, eventId }, "model-edges: failed to project strikeouts");
    res.status(502).json({ error: "Failed to project strikeouts. Try again shortly." });
  }
});

export default router;
