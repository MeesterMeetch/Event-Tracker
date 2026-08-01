import { baseSelection } from "./odds-math";
import type { ScoresGame } from "./odds";

export type GradeResult = "won" | "lost" | "push";

export interface BetForGrading {
  market: string;
  selection: string;
  point: number | null;
  homeTeam: string;
  awayTeam: string;
}

/**
 * Grades a settled game against a bet. Returns null when the bet can't be
 * graded from the available data (unknown market, team name mismatch,
 * missing point) so the caller can leave it for manual settlement rather
 * than guess.
 */
export function gradeBet(bet: BetForGrading, game: ScoresGame): GradeResult | null {
  if (!game.completed || !game.scores) return null;

  const scoreFor = (team: string): number | null => {
    const entry = game.scores!.find((s) => s.name === team);
    if (!entry) return null;
    const n = parseInt(entry.score, 10);
    return Number.isNaN(n) ? null : n;
  };

  const homeScore = scoreFor(game.home_team);
  const awayScore = scoreFor(game.away_team);
  if (homeScore == null || awayScore == null) return null;

  if (bet.market === "h2h") {
    const myScore = bet.selection === game.home_team ? homeScore : bet.selection === game.away_team ? awayScore : null;
    if (myScore == null) return null;
    const oppScore = bet.selection === game.home_team ? awayScore : homeScore;
    if (myScore > oppScore) return "won";
    if (myScore < oppScore) return "lost";
    return "push";
  }

  if (bet.market === "spreads") {
    if (bet.point == null) return null;
    const myScore = bet.selection === game.home_team ? homeScore : bet.selection === game.away_team ? awayScore : null;
    if (myScore == null) return null;
    const oppScore = bet.selection === game.home_team ? awayScore : homeScore;
    const adjusted = myScore + bet.point;
    if (adjusted > oppScore) return "won";
    if (adjusted < oppScore) return "lost";
    return "push";
  }

  if (bet.market === "totals") {
    if (bet.point == null) return null;
    const side = baseSelection("totals", bet.selection);
    const total = homeScore + awayScore;
    if (total === bet.point) return "push";
    if (side === "Over") return total > bet.point ? "won" : "lost";
    if (side === "Under") return total < bet.point ? "won" : "lost";
    return null;
  }

  return null;
}

/**
 * Profit/loss in units for a graded bet at American odds.
 * Won at +150 for 1u returns +1.5; won at -120 for 1.2u returns +1.0;
 * lost returns -units; push returns 0.
 */
export function calcPnl(result: GradeResult, americanOdds: number, units: number): number {
  if (result === "push") return 0;
  if (result === "lost") return -Math.round(units * 100) / 100;
  const profit = americanOdds > 0 ? units * (americanOdds / 100) : units * (100 / Math.abs(americanOdds));
  return Math.round(profit * 100) / 100;
}
