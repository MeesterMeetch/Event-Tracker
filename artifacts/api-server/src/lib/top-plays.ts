import type { EdgeOpportunity } from "./ev";
import { TIER_ORDER, type ConfidenceTier } from "./edge-confidence";
import { correlationTier, CORRELATION_BY_TIER, type Position } from "./exposure";

/**
 * Picking the day's best plays across every sport on the board.
 *
 * The naive version of this feature sorts the whole slate by EV and takes the
 * top five. That fails in two specific ways, and both are worth designing
 * against rather than discovering later.
 *
 * First, EV alone promotes the least trustworthy edges. A twelve percent number
 * on a three-book market is usually a stale price, not an opportunity, so
 * ranking has to weigh confidence alongside size. See edge-confidence.ts.
 *
 * Second, and less obvious: the five highest-EV edges are frequently the same
 * bet wearing different hats. A total, a moneyline, and three player props on
 * one game all resolve off the same script. Betting all five is not
 * diversification, it is one large position with extra steps, and it is exactly
 * how a bankroll gets hurt on a night the model happens to be wrong about one
 * game. So selection enforces spacing: a game can only contribute so much, and
 * each additional pick from the same game has to clear a rising bar.
 *
 * The result is deliberately not "the five biggest numbers". It is the five
 * plays that are most worth making together.
 */

export interface TopPlay {
  edge: EdgeOpportunity;
  /** 1-based position in the final list. */
  rank: number;
  /** Combined score used for ordering. Not a probability. */
  score: number;
  /** Why this made the list, in plain language. */
  rationale: string;
  /** Other selections already taken from this same game, if any. */
  sameGameCount: number;
}

export interface TopPlaysOptions {
  limit?: number;
  /** Most selections allowed from any single game. */
  maxPerGame?: number;
  /** Edges below this EV are never considered, whatever their confidence. */
  minEvPercent?: number;
  /** Tiers eligible for selection. */
  allowedTiers?: ConfidenceTier[];
}

export const DEFAULT_TOP_PLAYS_OPTIONS: Required<TopPlaysOptions> = {
  limit: 5,
  // Two is a deliberate compromise. One would discard genuinely independent
  // opportunities in a game with several markets; three or more starts stacking
  // correlated exposure faster than it adds diversification.
  maxPerGame: 2,
  minEvPercent: 1,
  // "suspect" is excluded outright: those are edges the sharp books contradict
  // or that are too large to be credible, and a "play of the day" list is the
  // last place they belong.
  allowedTiers: ["solid", "playable", "fragile"],
};

/**
 * Ranking score. Confidence dominates and EV breaks ties within a tier, which
 * is the opposite of sorting by EV alone.
 *
 * The tier weighting is intentionally coarse. A solid edge starts 30 points
 * ahead of a playable one, so a 2% solid play outranks a 6% fragile one. That
 * reflects how these actually perform: the small, well-supported edges are the
 * ones that survive a re-scan.
 */
export function playScore(edge: EdgeOpportunity): number {
  const tierBase = [90, 60, 30, 0][TIER_ORDER[edge.confidenceTier as ConfidenceTier]] ?? 0;
  // EV contributes on a compressed scale so a huge number cannot leapfrog a
  // whole tier. Capped because beyond ~10% the size is evidence against the
  // edge rather than for it.
  const evComponent = Math.min(edge.evPercent, 10) * 2;
  return tierBase + evComponent;
}

/** Turns an edge into the position shape the correlation math expects. */
function toPosition(edge: EdgeOpportunity, units = 1): Position {
  return {
    gameId: edge.gameId,
    player: edge.player,
    // Team markets carry the side in `selection`; it is the best available
    // proxy for which team the position is on.
    team: edge.player == null ? edge.selection : null,
    units,
  };
}

function rationaleFor(edge: EdgeOpportunity, sameGameCount: number): string {
  const parts: string[] = [];
  parts.push(`${edge.evPercent.toFixed(1)}% EV at ${edge.book}`);
  parts.push(`${edge.confidenceTier}`);
  if (edge.bookCount >= 8) parts.push(`${edge.bookCount} books`);
  if (edge.sharpProb != null) parts.push(`sharp ${edge.sharpProb.toFixed(1)}%`);
  if (sameGameCount > 0) {
    parts.push(`second look at this game, so size it smaller`);
  }
  return parts.join(" · ");
}

/**
 * Selects the day's plays from a pooled set of edges across every sport.
 *
 * Input is expected to be every priced outcome, not a pre-filtered list, since
 * the filtering rules live here.
 */
export function selectTopPlays(
  edges: EdgeOpportunity[],
  options: TopPlaysOptions = {},
): TopPlay[] {
  const opts = { ...DEFAULT_TOP_PLAYS_OPTIONS, ...options };
  const allowed = new Set(opts.allowedTiers);

  const eligible = edges
    .filter((e) => e.evPercent >= opts.minEvPercent)
    .filter((e) => allowed.has(e.confidenceTier as ConfidenceTier))
    .sort((a, b) => playScore(b) - playScore(a));

  const picked: TopPlay[] = [];
  const perGame = new Map<string, number>();

  for (const edge of eligible) {
    if (picked.length >= opts.limit) break;

    const taken = perGame.get(edge.gameId) ?? 0;
    if (taken >= opts.maxPerGame) continue;

    // Each additional pick from a game already represented must clear a rising
    // bar, scaled by how correlated it is with what is already in the list.
    // A second prop on the same player is held to a much higher standard than
    // an unrelated market in the same game.
    if (taken > 0) {
      const worstCorrelation = Math.max(
        ...picked
          .filter((p) => p.edge.gameId === edge.gameId)
          .map((p) => CORRELATION_BY_TIER[correlationTier(toPosition(edge), toPosition(p.edge))]),
        0,
      );
      // A 0.6-correlated addition needs a 60% higher score than the running
      // minimum; an uncorrelated one needs nothing extra.
      const bar = Math.min(...picked.map((p) => p.score)) * (1 + worstCorrelation);
      if (playScore(edge) < bar) continue;
    }

    picked.push({
      edge,
      rank: picked.length + 1,
      score: Math.round(playScore(edge) * 10) / 10,
      rationale: rationaleFor(edge, taken),
      sameGameCount: taken,
    });
    perGame.set(edge.gameId, taken + 1);
  }

  return picked;
}

export interface SlateSummary {
  totalEdges: number;
  eligibleEdges: number;
  byTier: Record<ConfidenceTier, number>;
  gamesRepresented: number;
  sportsRepresented: number;
  /** Plain-language read on the day, independent of the individual picks. */
  interpretation: string;
}

/**
 * A read on the whole slate rather than the picks. This matters because the
 * shape of a day is information: a board with no solid edges anywhere is a day
 * to sit out, and a top-five list on its own would never tell you that.
 */
export function summarizeSlate(edges: EdgeOpportunity[], picks: TopPlay[]): SlateSummary {
  const byTier: Record<ConfidenceTier, number> = { solid: 0, playable: 0, fragile: 0, suspect: 0 };
  for (const e of edges) {
    const tier = e.confidenceTier as ConfidenceTier;
    if (tier in byTier) byTier[tier] += 1;
  }

  const positive = edges.filter((e) => e.evPercent >= 1);
  const games = new Set(edges.map((e) => e.gameId));
  const sports = new Set(edges.map((e) => e.sport));

  let interpretation: string;
  if (picks.length === 0) {
    interpretation =
      "Nothing on the board clears the bar today. That is a normal outcome and a real answer: the market is efficient more often than not, and a day with no plays is cheaper than a day with forced ones.";
  } else if (byTier.solid === 0) {
    interpretation =
      "No solid edges on the board, so today's list is built from playable and fragile ones. Worth smaller stakes than usual, and worth checking whether these survive a re-scan before committing.";
  } else if (picks.length < 3) {
    interpretation = `Only ${picks.length} play${picks.length === 1 ? "" : "s"} cleared the bar. A short list is a good sign that the filter is working rather than a sign of a bad day.`;
  } else {
    interpretation = `${byTier.solid} solid and ${byTier.playable} playable edges across ${games.size} games. The list below is spaced across games deliberately: five correlated bets on one script is one position, not five.`;
  }

  return {
    totalEdges: edges.length,
    eligibleEdges: positive.length,
    byTier,
    gamesRepresented: games.size,
    sportsRepresented: sports.size,
    interpretation,
  };
}
