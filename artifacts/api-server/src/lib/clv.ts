import { and, eq, isNull } from "drizzle-orm";
import { db, betsTable } from "@workspace/db";
import { fetchOdds, type OddsEvent } from "./odds";
import { computeClvPercent, baseSelection, trimmedMeanClosingAmerican } from "./odds-math";
import { logger } from "./logger";

/** Start looking for a closing line this long before kickoff. */
const CLV_WINDOW_BEFORE_MS = 30 * 60 * 1000;

/** Stop trying to capture a closing line this long after kickoff (odds are usually pulled once the game goes live). */
const CLV_GIVE_UP_AFTER_MS = 3 * 60 * 60 * 1000;

/**
 * Closing lines come from the bulk odds feed, which only carries team
 * markets. Player-prop closers would need a per-event call every capture
 * cycle — not worth the credits — so prop bets are skipped and their CLV
 * stays null.
 */
const CLV_MARKETS = new Set(["h2h", "spreads", "totals"]);

function findClosingOdds(event: OddsEvent, market: string, selection: string, point: number | null): number | null {
  const prices: number[] = [];
  for (const bookmaker of event.bookmakers) {
    const m = bookmaker.markets.find((mk) => mk.key === market);
    if (!m) continue;
    for (const outcome of m.outcomes) {
      const outcomePoint = outcome.point ?? null;
      const sameSide = market === "totals" ? baseSelection(market, outcome.name) === baseSelection(market, selection) : outcome.name === selection;
      const samePoint = point == null ? outcomePoint == null : outcomePoint != null && Math.abs(outcomePoint - point) < 1e-9;
      if (sameSide && samePoint) prices.push(outcome.price);
    }
  }
  // The trimmed-mean-in-decimal-space consensus (and the minimum-book abstention)
  // is shared with the pitcher-strikeout closer so the two beat-the-close numbers
  // can't drift apart when the robustness rule is tuned.
  return trimmedMeanClosingAmerican(prices);
}

let clvRunning = false;

export async function captureClosingLines(): Promise<void> {
  if (clvRunning) return;
  clvRunning = true;
  try {
    const candidates = await db.select().from(betsTable).where(isNull(betsTable.closingOdds));

    const now = Date.now();
    const due = candidates.filter((b) => {
      if (!CLV_MARKETS.has(b.market)) return false;
      const startsAt = new Date(b.commenceTime).getTime();
      return now >= startsAt - CLV_WINDOW_BEFORE_MS && now <= startsAt + CLV_GIVE_UP_AFTER_MS;
    });
    if (due.length === 0) return;

    const sports = Array.from(new Set(due.map((b) => b.sport)));
    const eventsBySport = new Map<string, Map<string, OddsEvent>>();

    for (const sport of sports) {
      try {
        const { data } = await fetchOdds(sport);
        eventsBySport.set(sport, new Map(data.map((e) => [e.id, e])));
      } catch (err) {
        logger.warn({ err, sport }, "clv: failed to fetch odds");
      }
    }

    for (const bet of due) {
      const event = eventsBySport.get(bet.sport)?.get(bet.gameId);
      if (!event) continue;

      const closingOdds = findClosingOdds(event, bet.market, bet.selection, bet.point);
      if (closingOdds == null) continue;

      const clvPercent = computeClvPercent(bet.americanOdds, closingOdds);
      await db.update(betsTable).set({ closingOdds, clvPercent }).where(and(eq(betsTable.id, bet.id), isNull(betsTable.closingOdds)));
      logger.info({ betId: bet.id, closingOdds, clvPercent }, "clv: closing line captured");
    }
  } catch (err) {
    logger.error({ err }, "clv: run failed");
  } finally {
    clvRunning = false;
  }
}

const CLV_INTERVAL_MS = 10 * 60 * 1000;

export function startClvCapture(): void {
  if (!process.env.ODDS_API_KEY) {
    logger.warn("clv: ODDS_API_KEY not set, CLV capture disabled");
    return;
  }
  setInterval(() => void captureClosingLines(), CLV_INTERVAL_MS);
  setTimeout(() => void captureClosingLines(), 20 * 1000);
  logger.info({ intervalMinutes: 10 }, "clv: scheduler started");
}
