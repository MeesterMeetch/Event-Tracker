import { Router, type IRouter } from "express";
import { ListEventsQueryParams, ListEventsResponse } from "@workspace/api-zod";
import { fetchEvents } from "../lib/odds";
import { isSupportedSport } from "../lib/sports";

const router: IRouter = Router();

router.get("/events", async (req, res): Promise<void> => {
  const parsed = ListEventsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { sport } = parsed.data;
  if (!(await isSupportedSport(sport))) {
    res.status(400).json({ error: `Unsupported sport: ${sport}` });
    return;
  }

  try {
    const events = await fetchEvents(sport);
    const payload = events
      .map((e) => ({
        id: e.id,
        sport,
        commenceTime: e.commence_time,
        homeTeam: e.home_team,
        awayTeam: e.away_team,
      }))
      .sort((a, b) => a.commenceTime.localeCompare(b.commenceTime));
    res.json(ListEventsResponse.parse(payload));
  } catch (err) {
    req.log.error({ err, sport }, "events: failed to fetch upcoming games");
    res.status(502).json({ error: "Failed to fetch upcoming games. Try again shortly." });
  }
});

export default router;
