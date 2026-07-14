import { and, eq, isNull } from "drizzle-orm";
import { db, pitcherKPaperTradesTable } from "@workspace/db";
import { fetchEventOdds, type OddsEvent } from "./odds";
import { computeClvPercent } from "./odds-math";
import { closingConsensusForLine, PITCHER_K_MARKET } from "./pitcher-k-scanner";
import { logger } from "./logger";

/** Start looking for the closing line this long before first pitch. */
const CLV_WINDOW_BEFORE_MS = 30 * 60 * 1000;
/** Give up (mark expired) this long after first pitch; prop odds get pulled once games go live. */
const CLV_GIVE_UP_AFTER_MS = 3 * 60 * 60 * 1000;

let running = false;

/**
 * Captures closing-line value for open paper trades. Unlike the game-line CLV
 * job (which reads the free bulk feed), pitcher-strikeout closers require a
 * per-event call, so this is deliberately bounded to games that have at least
 * one open paper trade — never a blanket scan.
 */
export async function captureModelClosingLines(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const open = await db
      .select()
      .from(pitcherKPaperTradesTable)
      .where(
        and(
          eq(pitcherKPaperTradesTable.status, "open"),
          isNull(pitcherKPaperTradesTable.closingOdds),
          // Skip soft-deleted (pending-undo) trades: don't spend per-event API
          // calls grading a pick the user just removed. If it's restored, the
          // next run picks it up while it's still in the capture window.
          isNull(pitcherKPaperTradesTable.deletedAt),
        ),
      );

    const now = Date.now();
    const due = open.filter((t) => {
      const startsAt = new Date(t.commenceTime).getTime();
      return now >= startsAt - CLV_WINDOW_BEFORE_MS;
    });
    if (due.length === 0) return;

    // Group by (sport, gameId) so each event is fetched at most once.
    const byGame = new Map<string, typeof due>();
    for (const t of due) {
      const key = `${t.sport}|${t.gameId}`;
      const list = byGame.get(key) ?? [];
      list.push(t);
      byGame.set(key, list);
    }

    for (const [key, trades] of byGame) {
      const [sport, gameId] = key.split("|");
      let event: OddsEvent | null = null;
      try {
        const { data, requestsRemaining } = await fetchEventOdds(sport, gameId, [PITCHER_K_MARKET]);
        event = data;
        if (requestsRemaining != null) logger.info({ requestsRemaining }, "model-clv: requests remaining");
      } catch (err) {
        logger.warn({ err, sport, gameId }, "model-clv: failed to fetch event odds");
      }

      for (const trade of trades) {
        const startsAt = new Date(trade.commenceTime).getTime();
        const expired = now > startsAt + CLV_GIVE_UP_AFTER_MS;

        const consensus = event
          ? closingConsensusForLine(event, trade.pitcher, trade.point, trade.selection as "Over" | "Under")
          : null;

        if (consensus) {
          const clvPercent = computeClvPercent(trade.americanOdds, consensus.closingAmerican);
          await db
            .update(pitcherKPaperTradesTable)
            .set({
              closingOdds: consensus.closingAmerican,
              closingProb: consensus.closingProb,
              clvPercent,
              beatClose: clvPercent > 0,
              status: "closed",
            })
            .where(and(eq(pitcherKPaperTradesTable.id, trade.id), isNull(pitcherKPaperTradesTable.closingOdds)));
          logger.info({ tradeId: trade.id, clvPercent }, "model-clv: closing line captured");
        } else if (expired) {
          await db
            .update(pitcherKPaperTradesTable)
            .set({ status: "expired" })
            .where(and(eq(pitcherKPaperTradesTable.id, trade.id), eq(pitcherKPaperTradesTable.status, "open")));
          logger.info({ tradeId: trade.id }, "model-clv: closing line unavailable, marked expired");
        }
      }
    }
  } catch (err) {
    logger.error({ err }, "model-clv: run failed");
  } finally {
    running = false;
  }
}

const INTERVAL_MS = 10 * 60 * 1000;

export function startModelClvCapture(): void {
  if (!process.env.ODDS_API_KEY) {
    logger.warn("model-clv: ODDS_API_KEY not set, paper-trade CLV capture disabled");
    return;
  }
  setInterval(() => void captureModelClosingLines(), INTERVAL_MS);
  setTimeout(() => void captureModelClosingLines(), 30 * 1000);
  logger.info({ intervalMinutes: 10 }, "model-clv: scheduler started");
}
