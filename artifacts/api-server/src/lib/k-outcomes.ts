import { and, eq, isNull, isNotNull } from "drizzle-orm";
import { db, pitcherKPaperTradesTable } from "@workspace/db";
import { fetchPitcherGameStrikeouts, type PitcherGameResult } from "./mlb";
import { gradeKOutcome } from "./k-outcome-math";
import { logger } from "./logger";

/**
 * Settles pitcher-strikeout paper trades against actual results so the model
 * can be judged on calibration (did the probabilities come true), not just
 * closing-line value. Deliberately independent of the CLV lifecycle: a trade
 * whose closing line was never captured (status "expired") still gets an
 * outcome, and a "closed" trade with CLV still needs one.
 *
 * Outcome semantics ("outcome" column, null until settled):
 *   "won" / "lost" / "push"  — graded from the boxscore strikeout total
 *   "void"                    — pitcher never appeared (scratched), matching
 *                               how books void K props on a non-start
 *
 * Abstain rules: a missing schedule match or a not-yet-final game leaves the
 * outcome null for the next run — never a partial or guessed grade. Only a
 * final game with the pitcher absent, or the hard give-up window, ends a
 * trade as void.
 */

/** A game becomes eligible for outcome grading this long after first pitch. */
const GRADE_AFTER_MS = 2.5 * 60 * 60 * 1000;
/** Give up (mark void) if no result can be resolved this long after first pitch. */
const GIVE_UP_AFTER_MS = 72 * 60 * 60 * 1000;

let running = false;

export async function settleKOutcomes(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Soft-deleted trades are pending-undo tombstones — never settle them.
    // Trades logged before pitcherId was captured can't be resolved against a
    // boxscore, so they're excluded up front rather than warning every run.
    const unsettled = await db
      .select()
      .from(pitcherKPaperTradesTable)
      .where(
        and(
          isNull(pitcherKPaperTradesTable.outcome),
          isNull(pitcherKPaperTradesTable.deletedAt),
          isNotNull(pitcherKPaperTradesTable.pitcherId),
        ),
      );

    const now = Date.now();
    const due = unsettled.filter((t) => now - new Date(t.commenceTime).getTime() >= GRADE_AFTER_MS);
    if (due.length === 0) return;

    // Group by (gameId, pitcherId) so each boxscore lookup is made at most
    // once even when both the Over and Under of a line were paper-traded.
    const byPitcherGame = new Map<string, typeof due>();
    for (const t of due) {
      const key = `${t.gameId}|${t.pitcherId}`;
      const list = byPitcherGame.get(key) ?? [];
      list.push(t);
      byPitcherGame.set(key, list);
    }

    for (const trades of byPitcherGame.values()) {
      const first = trades[0];
      let result: PitcherGameResult | null = null;
      try {
        result = await fetchPitcherGameStrikeouts(
          first.pitcherId!,
          first.homeTeam,
          first.awayTeam,
          first.commenceTime.toISOString(),
        );
      } catch (err) {
        logger.warn(
          { err, gameId: first.gameId, pitcher: first.pitcher },
          "k-outcomes: failed to fetch pitcher game result",
        );
      }

      for (const trade of trades) {
        const pastGiveUp = now > new Date(trade.commenceTime).getTime() + GIVE_UP_AFTER_MS;

        if (result?.kind === "final") {
          const outcome = gradeKOutcome(trade.selection as "Over" | "Under", trade.point, result.strikeouts);
          await db
            .update(pitcherKPaperTradesTable)
            .set({ actualStrikeouts: result.strikeouts, outcome })
            .where(and(eq(pitcherKPaperTradesTable.id, trade.id), isNull(pitcherKPaperTradesTable.outcome)));
          logger.info(
            { tradeId: trade.id, pitcher: trade.pitcher, actual: result.strikeouts, outcome },
            "k-outcomes: trade settled",
          );
        } else if (result?.kind === "didNotPitch" || ((result == null || result.kind === "gameNotFound" || result.kind === "notFinal") && pastGiveUp)) {
          await db
            .update(pitcherKPaperTradesTable)
            .set({ outcome: "void" })
            .where(and(eq(pitcherKPaperTradesTable.id, trade.id), isNull(pitcherKPaperTradesTable.outcome)));
          logger.info({ tradeId: trade.id, pitcher: trade.pitcher }, "k-outcomes: no result, marked void");
        }
        // Otherwise abstain: outcome stays null and the next run retries.
      }
    }
  } catch (err) {
    logger.error({ err }, "k-outcomes: run failed");
  } finally {
    running = false;
  }
}

const INTERVAL_MS = 30 * 60 * 1000;

export function startKOutcomeGrading(): void {
  setInterval(() => void settleKOutcomes(), INTERVAL_MS);
  setTimeout(() => void settleKOutcomes(), 45 * 1000);
  logger.info({ intervalMinutes: 30 }, "k-outcomes: scheduler started");
}
