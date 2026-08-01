import { Router, type IRouter } from "express";
import { fetchMlbGames } from "../lib/mlb";

const router: IRouter = Router();

/**
 * GET /mlb/games?date=YYYY-MM-DD
 *
 * Returns all MLB games scheduled for the given Eastern-calendar date from
 * the free MLB Stats API. Includes probable starters, current scores for live
 * games, and final scores for completed games. Results are sorted by start
 * time ascending.
 */
router.get("/mlb/games", async (req, res): Promise<void> => {
  const { date } = req.query;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "date must be a YYYY-MM-DD string" });
    return;
  }

  try {
    const games = await fetchMlbGames(date);
    res.json(games);
  } catch (err) {
    req.log.error({ err, date }, "mlb: failed to fetch schedule");
    res.status(502).json({ error: "Failed to fetch MLB schedule. Try again shortly." });
  }
});

export default router;
