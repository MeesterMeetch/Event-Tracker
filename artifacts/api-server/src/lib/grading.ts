import { eq } from "drizzle-orm";
import { db, betsTable } from "@workspace/db";
import { fetchScores, type ScoresGame } from "./odds";
import { gradeBet, calcPnl } from "./grading-math";
import { logger } from "./logger";

/**
 * A game becomes eligible for grading this long after its scheduled start.
 * Most slates finish inside 3.5 hours; the completed flag from the scores
 * API is the real gate, this just avoids pointless fetches mid-game.
 */
const GRADE_AFTER_MS = 2.5 * 60 * 60 * 1000;

/** Scores API lookback. Bets older than this need manual settlement. */
const SCORES_DAYS_FROM = 3;

let gradingRunning = false;

export async function settlePendingBets(): Promise<void> {
  if (gradingRunning) return;
  gradingRunning = true;
  try {
    const pending = await db.select().from(betsTable).where(eq(betsTable.status, "pending"));

    const now = Date.now();
    const due = pending.filter((b) => now - new Date(b.commenceTime).getTime() >= GRADE_AFTER_MS);
    if (due.length === 0) return;

    const sports = Array.from(new Set(due.map((b) => b.sport)));
    const scoresBySport = new Map<string, Map<string, ScoresGame>>();

    for (const sport of sports) {
      try {
        const { data } = await fetchScores(sport, SCORES_DAYS_FROM);
        scoresBySport.set(sport, new Map(data.map((g) => [g.id, g])));
      } catch (err) {
        logger.warn({ err, sport }, "grading: failed to fetch scores");
      }
    }

    for (const bet of due) {
      const game = scoresBySport.get(bet.sport)?.get(bet.gameId);
      if (!game) continue;
      if (!game.completed) continue;

      const result = gradeBet(
        {
          market: bet.market,
          selection: bet.selection,
          point: bet.point,
          homeTeam: bet.homeTeam,
          awayTeam: bet.awayTeam,
        },
        game,
      );
      if (result == null) {
        logger.warn(
          { betId: bet.id, market: bet.market, selection: bet.selection, gameId: bet.gameId },
          "grading: could not grade bet from scores data, leaving for manual settlement",
        );
        continue;
      }

      const pnl = calcPnl(result, bet.americanOdds, bet.units);
      await db.update(betsTable).set({ status: result, pnl }).where(eq(betsTable.id, bet.id));
      logger.info({ betId: bet.id, selection: bet.selection, result, pnl }, "grading: bet settled");
    }
  } catch (err) {
    logger.error({ err }, "grading: run failed");
  } finally {
    gradingRunning = false;
  }
}

const GRADING_INTERVAL_MS = 30 * 60 * 1000;

export function startGrading(): void {
  if (!process.env.ODDS_API_KEY) {
    logger.warn("grading: ODDS_API_KEY not set, auto grading disabled");
    return;
  }
  setInterval(() => void settlePendingBets(), GRADING_INTERVAL_MS);
  setTimeout(() => void settlePendingBets(), 30 * 1000);
  logger.info({ intervalMinutes: 30 }, "grading: scheduler started");
}
