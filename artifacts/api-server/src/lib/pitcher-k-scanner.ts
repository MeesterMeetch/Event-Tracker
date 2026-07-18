import type { OddsEvent } from "./odds";
import type { MatchupKInputs, PitcherKMatchupSide, PitcherKStats } from "./mlb";
import { americanToDecimal, americanToImpliedProb, trimmedMeanClosingAmerican } from "./odds-math";
import { projectPitcherK, lineProbabilities, kellyFraction, recommendedKellyUnits, DEFAULT_KELLY_MULTIPLIER } from "./pitcher-k-model";

export const PITCHER_K_MARKET = "pitcher_strikeouts";
/** The projection model is MLB-only. */
export const MODEL_SPORT_KEY = "baseball_mlb";

export interface ModelKLine {
  point: number;
  selection: "Over" | "Under";
  americanOdds: number;
  book: string;
  /** De-vigged market consensus for this side; null when fewer than 2 books quote it. */
  marketProb: number | null;
  /** Model's push-adjusted win probability for this side. */
  modelProb: number;
  /** EV of betting this side at the best price, using the model probability; null with no market. */
  edgePercent: number | null;
  fullKellyFraction: number;
  recommendedUnits: number;
  /** True when the edge clears the threshold and 2+ books quote the line. */
  isFlagged: boolean;
  /** DraftKings price for this line at scan time; null if DK doesn't quote it. */
  dkOdds: number | null;
}

export interface ModelPitcherProjection {
  gameId: string;
  sport: string;
  commenceTime: string;
  homeTeam: string;
  awayTeam: string;
  pitcher: string;
  team: string;
  opponent: string;
  throws: "L" | "R" | null;
  projectedBattersFaced: number;
  expectedStrikeouts: number;
  ratePerBF: number;
  opponentFactor: number;
  sampleStarts: number;
  sampleBattersFaced: number;
  /** Raw K/9 from the rolling sample window. Null when IP data was unavailable. */
  kPer9: number | null;
  /** Whether opponent handedness K% data was available for the adjustment. */
  opponentDataAvailable: boolean;
  /**
   * True when the pitcher's strikeout-rate inputs were missing or degraded (no
   * rolling starts and no season/career sample). The model abstains from
   * projecting rather than emit a confident number off zeroed inputs, so the
   * numeric fields are placeholders and `lines` is empty.
   */
  insufficientData: boolean;
  lines: ModelKLine[];
}

/**
 * A pitcher has a usable strikeout-rate signal when at least one of the model's
 * rate sources — the rolling window, the season aggregate, or the career
 * aggregate — carries real batters-faced data. When all three are empty (which
 * is what `getMatchupKInputs` returns after an MLB feed failure or an
 * unannounced starter), `projectPitcherK` would silently fall back to the league
 * average and emit a confident-looking projection off nothing. Detect that here
 * so the model can abstain instead.
 */
function hasUsableKRate(p: PitcherKStats): boolean {
  const rolling = p.rollingBattersFaced > 0;
  const season = (p.seasonBattersFaced ?? 0) > 0 && p.seasonStrikeouts != null;
  const career = (p.careerBattersFaced ?? 0) > 0 && p.careerStrikeouts != null;
  return rolling || season || career;
}

function normName(name: string): string {
  return name.trim().toLowerCase();
}

interface SideAgg {
  fairSamples: number[];
  books: Set<string>;
  bestAmerican: number | null;
  bestBook: string;
  dkAmerican: number | null;
}

/**
 * De-vigs each book's pitcher-strikeout over/under pairs (multiplicatively, as
 * the rest of the app does), keyed by normalized player, point, and side. Yields
 * the consensus fair probability, the best available American price, and the
 * distinct-book count per side.
 */
function buildMarketConsensus(event: OddsEvent): Map<string, SideAgg> {
  const agg = new Map<string, SideAgg>();
  const ensure = (key: string): SideAgg => {
    let a = agg.get(key);
    if (!a) {
      a = { fairSamples: [], books: new Set(), bestAmerican: null, bestBook: "", dkAmerican: null };
      agg.set(key, a);
    }
    return a;
  };

  for (const bookmaker of event.bookmakers) {
    for (const market of bookmaker.markets) {
      if (market.key !== PITCHER_K_MARKET) continue;

      const pairs = new Map<string, typeof market.outcomes>();
      for (const outcome of market.outcomes) {
        if (!outcome.description || outcome.point == null) continue;
        const pairKey = `${normName(outcome.description)}|${outcome.point}`;
        const list = pairs.get(pairKey) ?? [];
        list.push(outcome);
        pairs.set(pairKey, list);
      }

      for (const outcomes of pairs.values()) {
        // Must be exactly one Over + one Under to devig cleanly.
        if (outcomes.length !== 2 || outcomes[0].name === outcomes[1].name) continue;
        const implied = outcomes.map((o) => ({ o, prob: americanToImpliedProb(o.price) }));
        const overround = implied.reduce((sum, x) => sum + x.prob, 0);
        if (overround <= 0) continue;

        for (const { o, prob } of implied) {
          const player = normName(o.description!);
          const key = `${player}|${o.point}|${o.name}`;
          const side = ensure(key);
          side.fairSamples.push(prob / overround);
          side.books.add(bookmaker.key);
          const decimal = americanToDecimal(o.price);
          if (side.bestAmerican == null || decimal > americanToDecimal(side.bestAmerican)) {
            side.bestAmerican = o.price;
            side.bestBook = bookmaker.title;
          }
          if (bookmaker.key === "draftkings") {
            side.dkAmerican = o.price;
          }
        }
      }
    }
  }

  return agg;
}

function projectSide(
  event: OddsEvent,
  sport: string,
  side: PitcherKMatchupSide,
  agg: Map<string, SideAgg>,
  minEdgePercent: number,
  kellyMultiplier: number,
): ModelPitcherProjection | null {
  const pitcher = side.pitcher;
  if (!pitcher) return null;

  // Abstain when the K-rate inputs are missing/degraded: a projection off zeroed
  // rolling stats and null season/career would just be the league average
  // dressed up as a precise number. Surface it as insufficient data instead.
  if (!hasUsableKRate(pitcher)) {
    return {
      gameId: event.id,
      sport,
      commenceTime: event.commence_time,
      homeTeam: event.home_team,
      awayTeam: event.away_team,
      pitcher: pitcher.name,
      team: pitcher.team,
      opponent: side.opponent?.team ?? "",
      throws: pitcher.throws,
      projectedBattersFaced: 0,
      expectedStrikeouts: 0,
      ratePerBF: 0,
      opponentFactor: 1,
      sampleStarts: pitcher.rollingStarts,
      sampleBattersFaced: pitcher.rollingBattersFaced,
      kPer9: null,
      opponentDataAvailable: false,
      insufficientData: true,
      lines: [],
    };
  }

  const projection = projectPitcherK(
    {
      throws: pitcher.throws,
      rollingStrikeouts: pitcher.rollingStrikeouts,
      rollingBattersFaced: pitcher.rollingBattersFaced,
      rollingStarts: pitcher.rollingStarts,
      rollingBfPerStart: pitcher.rollingBfPerStart,
      rollingInningsPitched: pitcher.rollingInningsPitched,
      seasonStrikeouts: pitcher.seasonStrikeouts,
      seasonBattersFaced: pitcher.seasonBattersFaced,
      seasonGamesStarted: pitcher.seasonGamesStarted,
      careerStrikeouts: pitcher.careerStrikeouts,
      careerBattersFaced: pitcher.careerBattersFaced,
    },
    side.opponent,
  );

  const nameKey = normName(pitcher.name);
  // Collect the distinct points quoted for this pitcher.
  const points = new Set<number>();
  for (const key of agg.keys()) {
    const [player, pointStr] = key.split("|");
    if (player === nameKey) points.add(Number(pointStr));
  }

  const lines: ModelKLine[] = [];
  for (const point of points) {
    const probs = lineProbabilities(projection.trials, projection.perTrialProb, point);
    for (const selection of ["Over", "Under"] as const) {
      const side2 = agg.get(`${nameKey}|${point}|${selection}`);
      if (!side2 || side2.bestAmerican == null) continue;

      const modelProb = selection === "Over" ? probs.condOver : probs.condUnder;
      const hasConsensus = side2.books.size >= 2;
      const marketProb = hasConsensus
        ? side2.fairSamples.reduce((s, p) => s + p, 0) / side2.fairSamples.length
        : null;
      const decimalBest = americanToDecimal(side2.bestAmerican);
      const edgePercent = Math.round((decimalBest * modelProb - 1) * 100 * 100) / 100;
      const isFlagged = hasConsensus && edgePercent >= minEdgePercent;

      lines.push({
        point,
        selection,
        americanOdds: side2.bestAmerican,
        book: side2.bestBook,
        dkOdds: side2.dkAmerican,
        marketProb,
        modelProb: Math.round(modelProb * 1e4) / 1e4,
        edgePercent,
        fullKellyFraction: Math.round(kellyFraction(modelProb, decimalBest) * 1e4) / 1e4,
        recommendedUnits: recommendedKellyUnits(modelProb, decimalBest, kellyMultiplier),
        isFlagged,
      });
    }
  }

  lines.sort((a, b) => a.point - b.point || a.selection.localeCompare(b.selection));

  return {
    gameId: event.id,
    sport,
    commenceTime: event.commence_time,
    homeTeam: event.home_team,
    awayTeam: event.away_team,
    pitcher: pitcher.name,
    team: pitcher.team,
    opponent: side.opponent?.team ?? "",
    throws: pitcher.throws,
    projectedBattersFaced: Math.round(projection.projectedBattersFaced * 10) / 10,
    expectedStrikeouts: Math.round(projection.expectedStrikeouts * 100) / 100,
    ratePerBF: Math.round(projection.ratePerBF * 1e4) / 1e4,
    opponentFactor: Math.round(projection.opponentFactor * 1e3) / 1e3,
    sampleStarts: projection.sampleStarts,
    sampleBattersFaced: projection.sampleBattersFaced,
    kPer9: projection.kPer9 != null ? Math.round(projection.kPer9 * 10) / 10 : null,
    opponentDataAvailable:
      side.opponent != null && (pitcher.throws === "L" ? side.opponent.kPctVsLhp : side.opponent.kPctVsRhp) != null,
    insufficientData: false,
    lines,
  };
}

/**
 * Runs the projection model against a game's pitcher-strikeout market and returns
 * one projection per resolved probable starter, each with model vs market lines.
 */
export function computeModelEdges(
  event: OddsEvent,
  sport: string,
  inputs: MatchupKInputs,
  minEdgePercent: number,
  kellyMultiplier: number = DEFAULT_KELLY_MULTIPLIER,
): ModelPitcherProjection[] {
  const agg = buildMarketConsensus(event);
  const projections: ModelPitcherProjection[] = [];
  for (const side of [inputs.home, inputs.away]) {
    const projection = projectSide(event, sport, side, agg, minEdgePercent, kellyMultiplier);
    if (!projection) continue;
    // Surface insufficient-data sides so the UI can say so; otherwise only keep
    // sides that actually produced market lines to compare against.
    if (projection.insufficientData || projection.lines.length > 0) projections.push(projection);
  }
  // Pitchers with a flagged edge first, then by their best edge.
  projections.sort((a, b) => {
    const aBest = Math.max(...a.lines.map((l) => l.edgePercent ?? -Infinity), -Infinity);
    const bBest = Math.max(...b.lines.map((l) => l.edgePercent ?? -Infinity), -Infinity);
    return bBest - aBest;
  });
  return projections;
}

/**
 * Closing-line helper for the CLV job: for one player/point/side, returns the
 * trimmed-mean closing American price across books and the de-vigged consensus
 * probability. Returns null when the exact line isn't quoted by 2+ books at close.
 */
export function closingConsensusForLine(
  event: OddsEvent,
  pitcher: string,
  point: number,
  selection: "Over" | "Under",
): { closingAmerican: number; closingProb: number } | null {
  const agg = buildMarketConsensus(event);
  const side = agg.get(`${normName(pitcher)}|${point}|${selection}`);
  if (!side || side.books.size < 2 || side.fairSamples.length === 0) return null;

  const closingProb = side.fairSamples.reduce((s, p) => s + p, 0) / side.fairSamples.length;

  // Trimmed-mean-in-decimal-space consensus of the per-book prices, shared with
  // the game-line closer so the two beat-the-close numbers can't drift apart.
  const closingAmerican = trimmedMeanClosingAmerican(collectSidePrices(event, pitcher, point, selection));
  if (closingAmerican == null) return null;

  return { closingAmerican, closingProb };
}

function collectSidePrices(event: OddsEvent, pitcher: string, point: number, selection: "Over" | "Under"): number[] {
  const prices: number[] = [];
  const target = normName(pitcher);
  for (const bookmaker of event.bookmakers) {
    for (const market of bookmaker.markets) {
      if (market.key !== PITCHER_K_MARKET) continue;
      for (const o of market.outcomes) {
        if (!o.description || o.point == null) continue;
        if (normName(o.description) === target && o.point === point && o.name === selection) {
          prices.push(o.price);
        }
      }
    }
  }
  return prices;
}
