import { Router, type IRouter } from "express";
import { GenerateGameAnalysisBody, GenerateGameAnalysisResponse } from "@workspace/api-zod";
import { getMatchupPitchers } from "../lib/mlb";
import { generateAnalysis, ANALYSIS_MODEL, type AnalysisEdge } from "../lib/analysis";

const router: IRouter = Router();

const MLB_SPORT_KEY = "baseball_mlb";
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_EDGES = 50; // guard against oversized / abusive payloads
const MAX_CACHE_ENTRIES = 500; // bound memory for the in-memory cache

type AnalysisResponse = ReturnType<typeof GenerateGameAnalysisResponse.parse>;

// In-memory cache keyed by game identity (sport:gameId:home:away). Analyses are
// expensive (LLM + external fetches) and change slowly, so a short TTL avoids
// regenerating on re-open. Best-effort only: not shared across instances.
const cache = new Map<string, { data: AnalysisResponse; expires: number }>();

// Drop expired entries once the cache grows past its bound.
function pruneCache(): void {
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expires <= now) cache.delete(key);
  }
}

router.post("/analysis", async (req, res): Promise<void> => {
  const parsed = GenerateGameAnalysisBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { sport, gameId, homeTeam, awayTeam, commenceTime, edges } = parsed.data;

  if (edges.length > MAX_EDGES) {
    res.status(400).json({ error: `Too many edges in request (max ${MAX_EDGES}).` });
    return;
  }

  // Integrity: every edge must belong to the posted game, so a mixed or
  // mismatched payload can't populate the cache with the wrong game's analysis.
  const inconsistent = edges.some(
    (e) =>
      e.gameId !== gameId ||
      e.sport !== sport ||
      e.homeTeam !== homeTeam ||
      e.awayTeam !== awayTeam,
  );
  if (inconsistent) {
    res.status(400).json({ error: "All edges must match the requested game." });
    return;
  }

  // Game-line and player-prop analyses cache separately: same game, but the
  // edge sets (and therefore the useful analysis) differ per tab.
  const kind = edges.some((e) => e.player != null) ? "props" : "lines";
  const cacheKey = `${sport}:${gameId}:${homeTeam}:${awayTeam}:${kind}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    res.json(cached.data);
    return;
  }

  try {
    const commenceIso = commenceTime.toISOString();

    // Probable starters are only available for MLB via the Stats API.
    const pitchers =
      sport === MLB_SPORT_KEY
        ? await getMatchupPitchers(homeTeam, awayTeam, commenceIso)
        : { home: null, away: null };

    const analysisEdges: AnalysisEdge[] = edges.map((e) => ({
      market: e.market,
      selection: e.selection,
      point: e.point,
      player: e.player,
      book: e.book,
      americanOdds: e.americanOdds,
      fairOdds: e.fairOdds,
      evPercent: e.evPercent,
    }));

    const content = await generateAnalysis({
      sport,
      homeTeam,
      awayTeam,
      commenceTime: commenceIso,
      edges: analysisEdges,
      homePitcher: pitchers.home,
      awayPitcher: pitchers.away,
    });

    const data = GenerateGameAnalysisResponse.parse({
      gameId,
      generatedAt: new Date(),
      model: ANALYSIS_MODEL,
      summary: content.summary,
      matchupAnalysis: content.matchupAnalysis,
      bettingAngle: content.bettingAngle,
      keyFactors: content.keyFactors,
      homePitcher: pitchers.home,
      awayPitcher: pitchers.away,
    });

    // Only complete analyses reach this point: generateAnalysis throws on a
    // non-JSON or partial model response, so a half-empty report is never
    // cached — it takes the catch below and surfaces as a 502.
    pruneCache();
    cache.set(cacheKey, { data, expires: Date.now() + CACHE_TTL_MS });
    res.json(data);
  } catch (err) {
    req.log.error({ err, gameId, sport }, "analysis: failed to generate game analysis");
    res.status(502).json({ error: "Failed to generate analysis. Try again shortly." });
  }
});

export default router;
