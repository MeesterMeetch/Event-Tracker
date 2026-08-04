import { Router, type IRouter } from "express";
import { ListModelSlateQueryParams, ListModelSlateResponse } from "@workspace/api-zod";
import { fetchEvents, fetchEventOdds, logRequestsRemaining } from "../lib/odds";
import { getMatchupKInputs } from "../lib/mlb";
import {
  computeModelEdges,
  MODEL_SPORT_KEY,
  PITCHER_K_MARKET,
  type ModelPitcherProjection,
} from "../lib/pitcher-k-scanner";
import { DEFAULT_KELLY_MULTIPLIER } from "../lib/pitcher-k-model";
import { recordModelPaperTradesInBackground } from "../lib/model-trade-recorder";

const router: IRouter = Router();

const DEFAULT_MIN_EDGE_PERCENT = 1;

/**
 * Events scanned in one call. Pitcher strikeouts is a single market, so this
 * bills one credit per event rather than the markets-times-regions arithmetic
 * that makes the game-line fan-out expensive. A full MLB slate is roughly
 * fifteen credits, which is why this can afford to be generous where
 * /top-plays cannot.
 */
const DEFAULT_MAX_EVENTS = 20;
const ABSOLUTE_MAX_EVENTS = 30;

/** Concurrency cap. Each event hits both the odds feed and the MLB Stats API. */
const BATCH_SIZE = 5;

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

interface SlatePlay {
  gameId: string;
  commenceTime: string;
  homeTeam: string;
  awayTeam: string;
  pitcher: string;
  team: string;
  opponent: string;
  expectedStrikeouts: number;
  sampleStarts: number;
  degradedInputs: boolean;
  point: number;
  selection: string;
  americanOdds: number;
  book: string;
  modelProb: number;
  marketProb: number;
  edgePercent: number;
  recommendedUnits: number;
  isFlagged: boolean;
  rank: number;
}

/**
 * Flattens per-pitcher projections into individual bettable lines.
 *
 * Lines with no de-vigged market probability are dropped: those are quoted by
 * fewer than two books, and a model edge measured against a single book's
 * price is measuring that book rather than the market.
 */
function toPlays(projections: ModelPitcherProjection[]): Omit<SlatePlay, "rank">[] {
  const out: Omit<SlatePlay, "rank">[] = [];
  for (const p of projections) {
    if (p.insufficientData) continue;
    for (const line of p.lines) {
      if (line.marketProb == null || line.edgePercent == null) continue;
      out.push({
        gameId: p.gameId,
        commenceTime: p.commenceTime,
        homeTeam: p.homeTeam,
        awayTeam: p.awayTeam,
        pitcher: p.pitcher,
        team: p.team,
        opponent: p.opponent,
        expectedStrikeouts: p.expectedStrikeouts,
        sampleStarts: p.sampleStarts,
        degradedInputs: !p.opponentDataAvailable,
        point: line.point,
        selection: line.selection,
        americanOdds: line.americanOdds,
        book: line.book,
        modelProb: line.modelProb,
        marketProb: line.marketProb,
        edgePercent: line.edgePercent,
        recommendedUnits: line.recommendedUnits,
        isFlagged: line.isFlagged,
      });
    }
  }
  return out;
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>) {
  const results: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += size) {
    results.push(...(await Promise.allSettled(items.slice(i, i + size).map(fn))));
  }
  return results;
}

router.get("/model-edges/slate", async (req, res): Promise<void> => {
  const parsed = ListModelSlateQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { startTime, endTime, limit, minEdgePercent, kellyMultiplier, maxEvents } = parsed.data;

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
    Math.min(ABSOLUTE_MAX_EVENTS, Math.floor(maxEvents ?? DEFAULT_MAX_EVENTS)),
  );

  let events;
  try {
    // Listing events is free; only the per-event odds calls are billed.
    events = await fetchEvents(MODEL_SPORT_KEY);
  } catch (err) {
    req.log.error({ err }, "model-slate: could not list events");
    res.status(502).json({ error: "Could not list today's games. Try again shortly." });
    return;
  }

  const inWindow = events
    .filter((e) => {
      const t = Date.parse(e.commence_time);
      return Number.isFinite(t) && t >= windowStart.getTime() && t < windowEnd.getTime();
    })
    .slice(0, cap);

  const settled = await inBatches(inWindow, BATCH_SIZE, async (event) => {
    const { data, requestsRemaining } = await fetchEventOdds(MODEL_SPORT_KEY, event.id, [
      PITCHER_K_MARKET,
    ]);
    logRequestsRemaining("model-slate", requestsRemaining);
    const inputs = await getMatchupKInputs(data.home_team, data.away_team, data.commence_time);
    return computeModelEdges(
      data,
      MODEL_SPORT_KEY,
      inputs,
      minEdgePercent ?? DEFAULT_MIN_EDGE_PERCENT,
      kellyMultiplier ?? DEFAULT_KELLY_MULTIPLIER,
    );
  });

  const projections: ModelPitcherProjection[] = [];
  const eventsFailed: Array<{ eventId: string; reason: string }> = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    if (outcome.status === "fulfilled") {
      projections.push(...outcome.value);
    } else {
      const reason =
        outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      req.log.warn({ eventId: inWindow[i].id, err: outcome.reason }, "model-slate: event failed");
      eventsFailed.push({ eventId: inWindow[i].id, reason });
    }
  }

  // Every event failing is an upstream problem, not a quiet board, and must not
  // be dressed up as "the model likes nothing today".
  if (inWindow.length > 0 && eventsFailed.length === inWindow.length) {
    res.status(502).json({
      error: `Every game failed to scan. First error: ${eventsFailed[0].reason}`,
    });
    return;
  }

  // Record every measured line before ranking. Fire-and-forget, deduplicated by
  // the existing unique index, and the reason this route exists at all: the
  // model has never been calibrated because nothing was ever logged to
  // calibrate it against.
  recordModelPaperTradesInBackground(
    projections,
    MODEL_SPORT_KEY,
    kellyMultiplier ?? DEFAULT_KELLY_MULTIPLIER,
  );

  const all = toPlays(projections);

  // Ranked on raw model edge, deliberately. A cleverer score is tempting here,
  // but every weighting worth having is an empirical question the calibration
  // history can answer and guesswork cannot. Until that is measured, the honest
  // ranking is the model's own number, with the inputs that produced it shown
  // alongside so a thin sample is visible rather than buried in a score.
  const plays: SlatePlay[] = all
    .sort((a, b) => b.edgePercent - a.edgePercent)
    .slice(0, limit ?? 15)
    .map((p, i) => ({ ...p, rank: i + 1 }));

  const flagged = all.filter((p) => p.isFlagged).length;
  const pitchers = new Set(all.map((p) => `${p.gameId}:${p.pitcher}`)).size;
  const degraded = projections.filter((p) => p.insufficientData).length;

  let interpretation: string;
  if (inWindow.length === 0) {
    interpretation =
      "No games in this window. Either the slate is finished or it has not been posted yet.";
  } else if (all.length === 0) {
    interpretation =
      "No pitcher-strikeout lines were quoted by enough books to measure. That is a data gap rather than a read on the day.";
  } else if (flagged === 0) {
    interpretation = `The model disagrees with the market on nothing today. ${all.length} lines measured across ${pitchers} starters, none clearing the edge threshold. The list below is ranked anyway so the shape of the disagreement is visible.`;
  } else {
    interpretation = `${flagged} of ${all.length} lines clear the edge threshold, across ${pitchers} starters. Model edges are disagreements, not certainties: check the sample size behind each before sizing.`;
  }

  res.json(
    ListModelSlateResponse.parse({
      plays,
      summary: {
        eventsScanned: inWindow.length - eventsFailed.length,
        linesMeasured: all.length,
        pitchersProjected: pitchers,
        flagged,
        insufficientData: degraded,
        interpretation,
      },
      eventsFailed,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      scannedAt: new Date().toISOString(),
    }),
  );
});

export default router;
