import { Router, type IRouter } from "express";
import {
  ListLeadersQueryParams,
  ListLeadersResponse,
  ListRankingsSportsResponse,
  ListStandingsQueryParams,
  ListStandingsResponse,
} from "@workspace/api-zod";
import { getLeaders, getStandings, listRankingsSports, rankingsSupported } from "../lib/rankings";

const router: IRouter = Router();

router.get("/rankings-sports", (_req, res): void => {
  res.json(ListRankingsSportsResponse.parse(listRankingsSports()));
});

router.get("/standings", async (req, res): Promise<void> => {
  const parsed = ListStandingsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { sport } = parsed.data;
  if (!rankingsSupported(sport)) {
    res.status(400).json({ error: "Standings aren't available for this sport." });
    return;
  }

  try {
    res.json(ListStandingsResponse.parse(await getStandings(sport)));
  } catch (err) {
    req.log.error({ err, sport }, "rankings: standings fetch failed");
    res.status(502).json({ error: "Failed to fetch standings. Try again shortly." });
  }
});

router.get("/leaders", async (req, res): Promise<void> => {
  const parsed = ListLeadersQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { sport } = parsed.data;
  if (!rankingsSupported(sport)) {
    res.status(400).json({ error: "Standings aren't available for this sport." });
    return;
  }

  try {
    res.json(ListLeadersResponse.parse(await getLeaders(sport)));
  } catch (err) {
    req.log.error({ err, sport }, "rankings: leaders fetch failed");
    res.status(502).json({ error: "Failed to fetch stat leaders. Try again shortly." });
  }
});

export default router;
