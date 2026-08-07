import { Router, type IRouter } from "express";
import { ListTopPlaysQueryParams, ListTopPlaysResponse } from "@workspace/api-zod";
import { fetchOdds, fetchEvents } from "../lib/odds";
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

/**
 * Fallback window when the caller does not supply one. Twenty four hours from
 * now rather than "the rest of the UTC day", so a bare curl at 23:50 UTC does
 * not come back empty for want of a timezone it was never asked for.
 */
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

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

  const { sports, maxSports, limit, minEvPercent, maxPerGame, startTime, endTime } =
    parsed.data;

  // The window is supplied by the caller rather than derived here, because
  // "today" is a question about the viewer's calendar and this process runs in
  // UTC. For five hours every evening a Denver user and this server disagree
  // about what day it is, and the server is the one that is wrong.
  const windowStart = startTime != null ? new Date(startTime) : new Date();
  if (Number.isNaN(windowStart.getTime())) {
    res.status(400).json({ error: "startTime is not a valid ISO 8601 instant" });
    return;
  }
  const windowEnd =
    endTime != null ? new Date(endTime) : new Date(windowStart.getTime() + DEFAULT_WINDOW_MS);
  if (Number.isNaN(windowEnd.getTime())) {
    res.status(400).json({ error: "endTime is not a valid ISO 8601 instant" });
    return;
  }
  if (windowEnd.getTime() <= windowStart.getTime()) {
    res.status(400).json({ error: "endTime must be after startTime" });
    return;
  }

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

  // Free pre-pass. Listing a sport's events costs nothing; only the odds are
  // billed. Without this the fan-out pays six credits for NFL in August purely
  // to discover it has no game tonight, which on a summer slate is most of the
  // spend. A sport whose listing fails is kept rather than dropped: a failed
  // free call is not evidence of an empty board, and the paid scan reports its
  // own failure honestly.
  const candidates = requested.slice(0, ABSOLUTE_MAX_SPORTS);
  const listed = await Promise.allSettled(
    candidates.map(async (sport) => {
      const events = await fetchEvents(sport);
      return events.some((e) => {
        const t = Date.parse(e.commence_time);
        return Number.isFinite(t) && t >= windowStart.getTime() && t < windowEnd.getTime();
      });
    }),
  );

  const playable: string[] = [];
  const sportsSkipped: string[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const outcome = listed[i];
    if (outcome.status === "rejected" || outcome.value) playable.push(candidates[i]);
    else sportsSkipped.push(candidates[i]);
  }

  const toScan = playable.slice(0, cap);

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

  // Bound the pool by commence time before anything reads it. The feed returns
  // every upcoming event in a sport, so in August a December football game sits
  // in the same list as tonight's baseball and can outrank it. Filtering here
  // rather than inside selectTopPlays keeps summarizeSlate honest as well: the
  // summary should describe the day being asked about, not the rest of the
  // season.
  const inWindow = pooled.filter((edge) => {
    const t = Date.parse(edge.commenceTime);
    return Number.isFinite(t) && t >= windowStart.getTime() && t < windowEnd.getTime();
  });
  const edgesOutsideWindow = pooled.length - inWindow.length;

  const picks = selectTopPlays(inWindow, {
    limit: limit ?? DEFAULT_TOP_PLAYS_OPTIONS.limit,
    minEvPercent: minEvPercent ?? DEFAULT_TOP_PLAYS_OPTIONS.minEvPercent,
    maxPerGame: maxPerGame ?? DEFAULT_TOP_PLAYS_OPTIONS.maxPerGame,
  });

  const summary = summarizeSlate(inWindow, picks);

  res.json(
    ListTopPlaysResponse.parse({
      picks,
      summary,
      sportsScanned,
      sportsSkipped,
      sportsFailed,
      scannedAt: new Date().toISOString(),
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      edgesOutsideWindow,
    }),
  );
});

export default router;
