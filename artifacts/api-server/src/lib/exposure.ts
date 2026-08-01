/**
 * Correlation-aware position sizing and exposure limits. Pure math, no I/O.
 *
 * Kelly sizing assumes the wager is the only thing at risk. It is derived for a
 * single independent bet, and quarter Kelly is a haircut on that single bet's
 * optimum. Neither assumption survives contact with a real slate.
 *
 * If five positions all resolve off one game script, they are not five bets.
 * A quarterback's passing yards over, his receiver's receiving yards over, and
 * the game total over are close to one directional wager on that game being
 * high-scoring, expressed three times. Sizing each at quarter Kelly puts
 * something much closer to full Kelly on a single outcome, which is precisely
 * the regime where Kelly stops being growth-optimal and starts being a
 * drawdown machine.
 *
 * The correction has a clean closed form. For n positions each sized f, with
 * average pairwise correlation rho and comparable variance, the variance of the
 * combined position is
 *
 *   Var = f^2 * sigma^2 * ( n + n(n-1) * rho )
 *
 * To carry the same risk as a single position of size f, scale every position
 * by 1 / sqrt( n + n(n-1) * rho ). That behaves correctly at both ends: with
 * rho = 0 it reduces to the familiar 1/sqrt(n) diversification benefit, and
 * with rho = 1 it collapses to 1/n, so the whole correlated cluster totals one
 * position. No special cases required.
 *
 * The correlation values below are assumptions, not measurements. They are
 * deliberately conservative and they are the first thing to revisit once there
 * is enough graded history to estimate real correlations from outcomes.
 */

export type CorrelationTier = "samePlayer" | "sameTeam" | "sameGame" | "unrelated";

/**
 * Assumed average pairwise correlation within each tier. Erring high is the
 * safe direction: overstating correlation shrinks positions, and the cost of
 * being too small is slower growth, while the cost of being too large is ruin.
 */
export const CORRELATION_BY_TIER: Record<CorrelationTier, number> = {
  /** Two props on the same player in the same game. Strongly linked. */
  samePlayer: 0.6,
  /** Different players on the same team, or a player and their team's side. */
  sameTeam: 0.35,
  /** Same game, opposite teams or a game-level market. Still game-script linked. */
  sameGame: 0.2,
  /** Different games. Treated as independent. */
  unrelated: 0,
};

/** A position being considered or already open. */
export interface Position {
  gameId: string;
  /** Null for team markets. */
  player: string | null;
  /** Team the position is on, when identifiable. */
  team: string | null;
  units: number;
}

export interface ExposureLimits {
  /** Total units allowed across all positions in one game. */
  maxUnitsPerGame: number;
  /** Total units allowed across all positions on one player. */
  maxUnitsPerPlayer: number;
  /** Total units allowed across everything resolving on one day. */
  maxUnitsPerDay: number;
  /** Ceiling on any individual position, regardless of what Kelly says. */
  maxUnitsPerPosition: number;
}

/**
 * Defaults assume a unit is one percent of bankroll. Ten units in a single game
 * is already an aggressive day; the point of these is to make the ceiling an
 * explicit decision rather than an emergent property of how many edges the
 * scanner happened to find.
 */
export const DEFAULT_EXPOSURE_LIMITS: ExposureLimits = {
  maxUnitsPerGame: 5,
  maxUnitsPerPlayer: 2.5,
  maxUnitsPerDay: 15,
  maxUnitsPerPosition: 2.5,
};

export interface SizingResult {
  /** Units to actually stake after every adjustment. */
  units: number;
  /** What Kelly asked for before any adjustment. */
  requestedUnits: number;
  /** Multiplier applied for correlation with existing positions. */
  correlationScale: number;
  /** Correlation tier that drove the scaling. */
  tier: CorrelationTier;
  /** Number of already-open positions in the correlated cluster. */
  clusterSize: number;
  /** Which limit, if any, bound the final number. */
  boundBy: "kelly" | "correlation" | "position" | "game" | "player" | "day" | "drawdown";
  /** Human-readable explanation, suitable for showing next to the stake. */
  reason: string;
}

/** Highest-correlation relationship between a candidate and an existing position. */
export function correlationTier(a: Position, b: Position): CorrelationTier {
  if (a.gameId !== b.gameId) return "unrelated";
  if (a.player != null && b.player != null && a.player === b.player) return "samePlayer";
  if (a.team != null && b.team != null && a.team === b.team) return "sameTeam";
  return "sameGame";
}

/**
 * Variance-matched scaling factor for a cluster of n comparable positions with
 * average pairwise correlation rho. Returns 1 for a lone position.
 */
export function correlationScale(clusterSize: number, rho: number): number {
  const n = Math.max(1, clusterSize);
  if (n === 1) return 1;
  const clamped = Math.min(Math.max(rho, 0), 1);
  const varianceRatio = n + n * (n - 1) * clamped;
  if (!(varianceRatio > 0)) return 1;
  return 1 / Math.sqrt(varianceRatio);
}

function sum(positions: Position[]): number {
  return positions.reduce((a, p) => a + p.units, 0);
}

/**
 * Sizes a candidate position against everything already open.
 *
 * Order of operations matters: correlation scaling first (it reflects how much
 * risk the position really adds), then the hard caps (which are a statement
 * about how much risk is tolerable at all). The binding constraint is reported
 * so the number is explainable rather than mysterious.
 */
export function sizePosition(
  candidate: Position,
  openPositions: Position[],
  limits: ExposureLimits = DEFAULT_EXPOSURE_LIMITS,
  /** Multiplier from the drawdown throttle; 1 means no throttle. */
  drawdownScale = 1,
): SizingResult {
  const requestedUnits = candidate.units;

  // Cluster = open positions correlated with this candidate, at the tightest
  // tier present. Using the tightest tier is deliberate: one same-player
  // position should govern, not be diluted by loosely related ones.
  const tiers = openPositions.map((p) => correlationTier(candidate, p));
  const related = openPositions.filter((_, i) => tiers[i] !== "unrelated");

  let tier: CorrelationTier = "unrelated";
  if (tiers.includes("samePlayer")) tier = "samePlayer";
  else if (tiers.includes("sameTeam")) tier = "sameTeam";
  else if (tiers.includes("sameGame")) tier = "sameGame";

  // +1 to count the candidate itself as part of the cluster.
  const clusterSize = related.length + 1;
  const scale = correlationScale(clusterSize, CORRELATION_BY_TIER[tier]);

  let units = requestedUnits * scale;
  let boundBy: SizingResult["boundBy"] = clusterSize > 1 ? "correlation" : "kelly";

  if (drawdownScale < 1) {
    const throttled = units * drawdownScale;
    if (throttled < units) {
      units = throttled;
      boundBy = "drawdown";
    }
  }

  if (units > limits.maxUnitsPerPosition) {
    units = limits.maxUnitsPerPosition;
    boundBy = "position";
  }

  // Remaining headroom under each cap.
  const sameGame = openPositions.filter((p) => p.gameId === candidate.gameId);
  const gameHeadroom = limits.maxUnitsPerGame - sum(sameGame);
  if (units > gameHeadroom) {
    units = Math.max(0, gameHeadroom);
    boundBy = "game";
  }

  if (candidate.player != null) {
    const samePlayer = openPositions.filter(
      (p) => p.player === candidate.player && p.gameId === candidate.gameId,
    );
    const playerHeadroom = limits.maxUnitsPerPlayer - sum(samePlayer);
    if (units > playerHeadroom) {
      units = Math.max(0, playerHeadroom);
      boundBy = "player";
    }
  }

  const dayHeadroom = limits.maxUnitsPerDay - sum(openPositions);
  if (units > dayHeadroom) {
    units = Math.max(0, dayHeadroom);
    boundBy = "day";
  }

  units = Math.max(0, Math.round(units * 100) / 100);

  return {
    units,
    requestedUnits,
    correlationScale: scale,
    tier,
    clusterSize,
    boundBy,
    reason: explain(boundBy, requestedUnits, units, clusterSize, tier),
  };
}

function explain(
  boundBy: SizingResult["boundBy"],
  requested: number,
  final: number,
  clusterSize: number,
  tier: CorrelationTier,
): string {
  if (final === 0) {
    return "No headroom left under your exposure limits. Skip this one or close something first.";
  }
  switch (boundBy) {
    case "kelly":
      return `Full requested size: no correlated positions open.`;
    case "correlation":
      return `Cut from ${requested.toFixed(2)} to ${final.toFixed(2)} units: ${clusterSize} correlated positions (${tier}), so the cluster carries the risk of roughly one.`;
    case "drawdown":
      return `Cut from ${requested.toFixed(2)} to ${final.toFixed(2)} units by the drawdown throttle. Size comes back as the bankroll recovers.`;
    case "position":
      return `Capped at the per-position ceiling of ${final.toFixed(2)} units.`;
    case "game":
      return `Capped by remaining exposure in this game: ${final.toFixed(2)} units left.`;
    case "player":
      return `Capped by remaining exposure on this player: ${final.toFixed(2)} units left.`;
    case "day":
      return `Capped by remaining exposure for the day: ${final.toFixed(2)} units left.`;
  }
}

export interface ExposureSummary {
  totalUnits: number;
  byGame: { gameId: string; units: number; limit: number; utilization: number }[];
  byPlayer: { player: string; gameId: string; units: number; limit: number; utilization: number }[];
  dayUtilization: number;
  /** Groups already at or above their cap. */
  breaches: string[];
}

/** Current exposure across open positions, for display and for guardrails. */
export function exposureSummary(
  openPositions: Position[],
  limits: ExposureLimits = DEFAULT_EXPOSURE_LIMITS,
): ExposureSummary {
  const gameMap = new Map<string, number>();
  const playerMap = new Map<string, { player: string; gameId: string; units: number }>();

  for (const p of openPositions) {
    gameMap.set(p.gameId, (gameMap.get(p.gameId) ?? 0) + p.units);
    if (p.player != null) {
      const key = `${p.gameId}|${p.player}`;
      const current = playerMap.get(key) ?? { player: p.player, gameId: p.gameId, units: 0 };
      current.units += p.units;
      playerMap.set(key, current);
    }
  }

  const breaches: string[] = [];
  const byGame = Array.from(gameMap.entries())
    .map(([gameId, units]) => {
      const utilization = units / limits.maxUnitsPerGame;
      if (utilization >= 1) breaches.push(`Game ${gameId} at ${units.toFixed(2)} of ${limits.maxUnitsPerGame} units`);
      return { gameId, units, limit: limits.maxUnitsPerGame, utilization };
    })
    .sort((a, b) => b.units - a.units);

  const byPlayer = Array.from(playerMap.values())
    .map(({ player, gameId, units }) => {
      const utilization = units / limits.maxUnitsPerPlayer;
      if (utilization >= 1) breaches.push(`${player} at ${units.toFixed(2)} of ${limits.maxUnitsPerPlayer} units`);
      return { player, gameId, units, limit: limits.maxUnitsPerPlayer, utilization };
    })
    .sort((a, b) => b.units - a.units);

  const totalUnits = sum(openPositions);
  const dayUtilization = totalUnits / limits.maxUnitsPerDay;
  if (dayUtilization >= 1) {
    breaches.push(`Day at ${totalUnits.toFixed(2)} of ${limits.maxUnitsPerDay} units`);
  }

  return { totalUnits, byGame, byPlayer, dayUtilization, breaches };
}
