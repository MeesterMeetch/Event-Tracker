/**
 * Market softness survey. Pure math, no I/O.
 *
 * The strategic question this answers: given limited attention, which sports
 * and markets is this scanner actually worth pointing at?
 *
 * Two different things get confused under the word "soft", and they are
 * measured separately here because they mean opposite things for a bettor:
 *
 *   Overround is the bookmaker's margin. It is a cost. A fat overround makes a
 *     market expensive to play, not easy to beat. A high-vig market where every
 *     book agrees is simply a bad deal.
 *   Dispersion is how much the books disagree with each other once their vig is
 *     stripped out. That is the opportunity. Books only disagree when they are
 *     uncertain, and uncertainty is where a price shopper makes money.
 *
 * The metric that actually matters is neither on its own: it is how much edge
 * you capture by always taking the best available price against the consensus
 * fair probability. That is `meanBestPriceEdgePercent`, and it is the closest
 * thing to "what this market is worth to me" that a single scan can produce.
 *
 * One honest caveat, stated here because it is easy to be fooled by: taking the
 * best of N prices beats the average of N prices mechanically, and more books
 * means a higher maximum. So best-price edge rises with book count even when
 * nothing is genuinely soft. Always read it next to `medianBookCount`, and
 * compare markets with similar coverage rather than across wildly different
 * ones.
 */

import type { OddsEvent } from "./odds";
import { americanToDecimal, americanToImpliedProb } from "./odds-math";
import { devig, configuredDevigMethod, type DevigMethod } from "./devig";

/** One outcome's prices across every book quoting it. */
interface OutcomeObservation {
  /** De-vigged fair probability from each book that quoted it. */
  fairProbs: number[];
  /** Best (most favourable to the bettor) American price offered. */
  bestAmerican: number;
  /** Raw overround of each book's market instance containing this outcome. */
  overrounds: number[];
}

export interface MarketStats {
  sport: string;
  market: string;
  /** Distinct events contributing to this row. */
  events: number;
  /** Distinct priced outcomes (a side of one line for one player, say). */
  outcomes: number;
  /** Median number of books quoting an outcome. Liquidity proxy. */
  medianBookCount: number;
  /** Mean bookmaker margin, as a percentage above a fair book. */
  meanOverroundPercent: number;
  /**
   * Mean standard deviation of de-vigged fair probability across books, in
   * percentage points. This is the disagreement signal.
   */
  meanDispersionPercent: number;
  /**
   * Mean EV, in percent, of taking the best available price against the
   * consensus fair probability. The headline number.
   */
  meanBestPriceEdgePercent: number;
  /** Share of outcomes where that edge clears two percent. */
  shareAboveTwoPercent: number;
}

export interface SurveyOptions {
  /** Ignore outcomes quoted by fewer books than this. */
  minBooks?: number;
  devigMethod?: DevigMethod;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((a, v) => a + (v - m) * (v - m), 0) / (values.length - 1));
}

/**
 * Groups a book's outcomes into the sets that share a vig.
 *
 * This is the subtlety that makes or breaks the numbers. A book's
 * `player_pass_yds` market contains every quarterback on the slate, but the vig
 * lives inside each individual Over/Under pair, not across the whole market. So
 * outcomes are keyed by player and line before de-vigging. Get this wrong and
 * every overround reads as wildly inflated.
 */
function groupByPricedUnit(
  outcomes: { name: string; price: number; point?: number; description?: string }[],
): Map<string, typeof outcomes> {
  const groups = new Map<string, typeof outcomes>();
  for (const o of outcomes) {
    if (typeof o.price !== "number" || !Number.isFinite(o.price)) continue;
    const key = `${o.description ?? ""}|${o.point ?? ""}`;
    const list = groups.get(key) ?? [];
    list.push(o);
    groups.set(key, list);
  }
  return groups;
}

/** Best price from the bettor's perspective is the highest decimal payout. */
function betterPrice(a: number, b: number): number {
  return americanToDecimal(a) >= americanToDecimal(b) ? a : b;
}

/**
 * Computes per-market statistics across a set of events for one sport.
 */
export function surveyMarkets(
  events: OddsEvent[],
  sport: string,
  options: SurveyOptions = {},
): MarketStats[] {
  const minBooks = options.minBooks ?? 2;
  const method = options.devigMethod ?? configuredDevigMethod();

  // market -> outcomeKey -> observation
  const byMarket = new Map<string, Map<string, OutcomeObservation>>();
  const eventsByMarket = new Map<string, Set<string>>();

  for (const event of events) {
    for (const bookmaker of event.bookmakers) {
      for (const market of bookmaker.markets) {
        const marketMap = byMarket.get(market.key) ?? new Map<string, OutcomeObservation>();
        byMarket.set(market.key, marketMap);
        const eventSet = eventsByMarket.get(market.key) ?? new Set<string>();
        eventSet.add(event.id);
        eventsByMarket.set(market.key, eventSet);

        for (const [unitKey, unit] of groupByPricedUnit(market.outcomes)) {
          // A single unpriced side cannot be de-vigged and would otherwise
          // report a nonsense overround, so it is skipped entirely.
          if (unit.length < 2) continue;

          const implied = unit.map((o) => americanToImpliedProb(o.price));
          const overround = implied.reduce((a, b) => a + b, 0);
          if (!(overround > 0)) continue;
          const fair = devig(implied, method);

          unit.forEach((o, i) => {
            const outcomeKey = `${event.id}|${unitKey}|${o.name}`;
            const existing = marketMap.get(outcomeKey);
            if (existing) {
              existing.fairProbs.push(fair[i]);
              existing.overrounds.push(overround);
              existing.bestAmerican = betterPrice(existing.bestAmerican, o.price);
            } else {
              marketMap.set(outcomeKey, {
                fairProbs: [fair[i]],
                overrounds: [overround],
                bestAmerican: o.price,
              });
            }
          });
        }
      }
    }
  }

  const rows: MarketStats[] = [];

  for (const [market, outcomeMap] of byMarket) {
    const usable = Array.from(outcomeMap.values()).filter((o) => o.fairProbs.length >= minBooks);
    if (usable.length === 0) continue;

    const bookCounts = usable.map((o) => o.fairProbs.length);
    const overroundPcts = usable.map((o) => (mean(o.overrounds) - 1) * 100);
    const dispersionPcts = usable.map((o) => stdev(o.fairProbs) * 100);

    const bestEdges = usable.map((o) => {
      const consensus = mean(o.fairProbs);
      return (americanToDecimal(o.bestAmerican) * consensus - 1) * 100;
    });

    rows.push({
      sport,
      market,
      events: eventsByMarket.get(market)?.size ?? 0,
      outcomes: usable.length,
      medianBookCount: median(bookCounts),
      meanOverroundPercent: mean(overroundPcts),
      meanDispersionPercent: mean(dispersionPcts),
      meanBestPriceEdgePercent: mean(bestEdges),
      shareAboveTwoPercent: bestEdges.filter((e) => e >= 2).length / bestEdges.length,
    });
  }

  return rows.sort((a, b) => b.meanBestPriceEdgePercent - a.meanBestPriceEdgePercent);
}

/**
 * Plain-language read on a set of survey rows, aimed at the decision the survey
 * exists to inform: where should the scanner be pointed.
 */
export function interpretSurvey(rows: MarketStats[]): string[] {
  if (rows.length === 0) {
    return [
      "No markets had enough books quoting them to measure. Out of season, or the feed carries no depth here yet.",
    ];
  }

  const notes: string[] = [];
  const ranked = [...rows].sort((a, b) => b.meanBestPriceEdgePercent - a.meanBestPriceEdgePercent);
  const best = ranked[0];
  const worst = ranked[ranked.length - 1];

  notes.push(
    `Most exploitable on this scan: ${best.sport} ${best.market}, where always taking the best price is worth about ${best.meanBestPriceEdgePercent.toFixed(2)} percent against consensus, across a median of ${best.medianBookCount} books.`,
  );

  if (ranked.length > 1) {
    notes.push(
      `Least exploitable: ${worst.sport} ${worst.market} at about ${worst.meanBestPriceEdgePercent.toFixed(2)} percent. If that gap is large, attention is better spent at the top of this list than on refining a model at the bottom.`,
    );
  }

  const thin = ranked.filter((r) => r.medianBookCount <= 3);
  if (thin.length > 0) {
    notes.push(
      `Read these with care: ${thin.map((r) => `${r.sport} ${r.market}`).join(", ")} had three or fewer books quoting. Thin coverage makes a consensus fragile and one stale quote can dominate it.`,
    );
  }

  const expensive = ranked.filter((r) => r.meanOverroundPercent >= 6);
  if (expensive.length > 0) {
    notes.push(
      `High margin, which is a cost rather than an opportunity: ${expensive.map((r) => `${r.sport} ${r.market} at ${r.meanOverroundPercent.toFixed(1)} percent`).join(", ")}. A fat overround only helps if the books also disagree; check the dispersion column before reading it as softness.`,
    );
  }

  notes.push(
    "Remember that best-price edge rises with book count for purely mechanical reasons, since the maximum of many quotes beats the maximum of few. Compare markets with similar coverage, not across very different ones.",
  );

  return notes;
}
