import { Router, type IRouter } from "express";
import { ListTopPlaysQueryParams, ListTopPlaysResponse } from "@workspace/api-zod";
import { fetchOdds } from "../lib/odds";
import { computeEdges, type EdgeOpportunity } from "../lib/ev";
import { selectTopPlays, summarizeSlate, DEFAULT_TOP_PLAYS_OPTIONS } from "../lib/top-plays";
import { getSupportedSports } from "../lib/sports";
import { recordOddsSnapshotInBackground } from "../lib/odds-recorder";

const router: IRouter = Router();

/**
 * Sports worth pointing the scanner at, in the order we would spend credits on
 * them. The picker's in-season list is the source of truth for what is actually
 * live; this only decides priority when the caller does not name sports itself.
 *
 * Ordered by market depth rather than popularity. A deeper market has more
 * books quoting each outcome, and best-of-N is the mechanism that recovers vig,
 * so depth is what makes a scan worth its credits.
 */
const SPORT_PRIORITY = [
  "americanfootball_nfl",
  "basketball_nba",
  "baseball_mlb",
  "icehockey_nhl",
  "americanfootball_ncaaf",
  "basketball_ncaab",
  "soccer_epl",
  "mma_mixed_martial_arts",
];

/**
 * Default breadth. Each sport is a separate billed scan, so this is a spend
 * decision rather than a display one. Six covers the major boards on any given
 * day without turning one button press into a large bill.
 */
const DEFAULT_MAX_SPORTS = 6;

/**
 * Hard ceiling regardless of what the caller asks for. Protects against a
 * client bug or an over-eager query string turning into thirty scans.
 */
const ABSOLUTE_MAX_SPORTS = 12;

/**
 * Threshold used when pulling each sport's slate.
 *
 * Deliberately below zero: selectTopPlays and summarizeSlate both expect every
 * priced outcome, not a pre-filtered list, because the filtering rules live in
 * that module and the summary needs the whole board to say anything true about
 * the shape of the day. Filtering here would quietly break the summary while
 * leaving the picks looking correct.
 */
const SCAN_FLOOR_PERCENT = -100;

interface ScanResult {
  sport: string;
  edges: EdgeOpportunity[];
}

async function scanSport(sport: string): Promise<ScanResult> {
  const { data } = await fetchOdds(sport);
  // Same fire-and-forget history capture the single-sport scan does. Every
  // price dropped here is a row a future backtest cannot have.
  recordOddsSnapshotInBackground(data, sport);
  return { sport, edges: computeEdges(data, sport, SCAN_FLOOR_PERCENT) };
}

router.get("/top-plays", async (req, res): Promise<void> => {
  const parsed = ListTopPlaysQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { sports, maxSports, limit, minEvPercent, maxPerGame } = parsed.data;

  const cap = Math.max(
    1,
    Math.min(ABSOLUTE_MAX_SPORTS, Math.floor(maxSports ?? DEFAULT_MAX_SPORTS)),
  );

  let requested: string[];
  if (sports != null && sports.trim().length > 0) {
    requested = [...new Set(sports.split(",").map((s) => s.trim()).filter(Boolean))];
    if (requested.length === 0) {
      res.status(400).json({ error: "sports was provided but contained no sport keys" });
      return;
    }
  } else {
    // No explicit list: take what is in season, ordered by the priority above,
    // with anything unranked appended so a newly added sport is reachable.
    const inSeason = await getSupportedSports();
    const keys = new Set(inSeason.map((s) => s.key));
    const ranked = SPORT_PRIORITY.filter((k) => keys.has(k));
    const rest = inSeason.map((s) => s.key).filter((k) => !SPORT_PRIORITY.includes(k));
    requested = [...ranked, ...rest];
  }

  const toScan = requested.slice(0, cap);

  // Fan out concurrently. These are independent reads against an upstream that
  // tolerates parallel requests, and the caller is waiting on a button press,
  // so serialising them would cost seconds for no benefit.
  const settled = await Promise.allSettled(toScan.map((s) => scanSport(s)));

  const pooled: EdgeOpportunity[] = [];
  const sportsScanned: string[] = [];
  const sportsFailed: Array<{ sport: string; reason: string }> = [];

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    if (outcome.status === "fulfilled") {
      sportsScanned.push(outcome.value.sport);
      pooled.push(...outcome.value.edges);
    } else {
      const reason =
        outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      req.log.warn({ sport: toScan[i], err: outcome.reason }, "top-plays: sport scan failed");
      sportsFailed.push({ sport: toScan[i], reason });
    }
  }

  // Every sport failing is an upstream problem, not an efficient market, and
  // must not be dressed up as a quiet day with an empty pick list.
  if (sportsScanned.length === 0) {
    res.status(502).json({
      error:
        sportsFailed.length > 0
          ? `Every sport failed to scan. First error: ${sportsFailed[0].reason}`
          : "No sports were available to scan.",
    });
    return;
  }

  const picks = selectTopPlays(pooled, {
    limit: limit ?? DEFAULT_TOP_PLAYS_OPTIONS.limit,
    minEvPercent: minEvPercent ?? DEFAULT_TOP_PLAYS_OPTIONS.minEvPercent,
    maxPerGame: maxPerGame ?? DEFAULT_TOP_PLAYS_OPTIONS.maxPerGame,
  });

  const summary = summarizeSlate(pooled, picks);

  res.json(
    ListTopPlaysResponse.parse({
      picks,
      summary,
      sportsScanned,
      sportsFailed,
      scannedAt: new Date().toISOString(),
    }),
  );
});

export default router;
