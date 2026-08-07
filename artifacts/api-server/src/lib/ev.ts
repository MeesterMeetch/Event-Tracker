import type { OddsEvent } from "./odds";
import { americanToDecimal, americanToImpliedProb, isSharpBook, probToAmerican } from "./odds-math";
import { devig, configuredDevigMethod } from "./devig";
import { isBettableBook } from "./bettable-books";
import { assessConfidence, type ConfidenceTier } from "./edge-confidence";

export interface EdgeOpportunity {
  gameId: string;
  sport: string;
  commenceTime: string;
  homeTeam: string;
  awayTeam: string;
  market: string;
  selection: string;
  point: number | null;
  /** Player name for player-prop edges; null for team markets. */
  player: string | null;
  americanOdds: number;
  book: string;
  /** DraftKings price for this outcome at scan time; null if DK doesn't quote it. */
  dkOdds: number | null;
  fairOdds: number;
  evPercent: number;
  /**
   * Devigged consensus probability (percent) that this selection hits,
   * averaged across sharp books only (see SHARP_BOOK_KEYS); null when no
   * sharp book quotes the outcome. A proxy for where sharp money leans —
   * The Odds API does not publish real bet/handle splits.
   */
  /**
   * The de-vigged consensus this edge was measured against, as a percent. Same
   * number the EV is computed from, exposed directly rather than left to be
   * recovered from `fairOdds`: that field is a rounded American price, and
   * round-tripping it back to a probability would disagree with `sharpProb` and
   * `publicProb` by a few tenths for no reason.
   */
  marketProb: number;
  sharpProb: number | null;
  /** Same consensus probability (percent) averaged across public (recreational) books; null when none quote it. */
  publicProb: number | null;
  /** Distinct books quoting this outcome. Depth is the first ingredient of trust. */
  bookCount: number;
  /**
   * Spread of de-vigged fair probabilities across books, in percentage points.
   * Low means the market agrees; high means somebody is wrong.
   */
  dispersionPercent: number | null;
  /**
   * How much to trust this edge, as distinct from how large it is. See
   * edge-confidence.ts: the biggest EV numbers are usually the least real.
   */
  confidenceTier: ConfidenceTier;
  confidenceScore: number;
  confidenceReasons: string[];
}

/** Averages devigged fair-probability samples into a percent rounded to 0.1; null when no book contributed. */
export function avgProbPercent(samples: number[] | undefined): number | null {
  if (!samples || samples.length === 0) return null;
  const avg = samples.reduce((sum, p) => sum + p, 0) / samples.length;
  return Math.round(avg * 1000) / 10;
}

/** Sample standard deviation of fair-probability samples, in percentage points. */
export function dispersionPercent(samples: number[] | undefined): number | null {
  if (!samples || samples.length < 2) return null;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const variance = samples.reduce((a, p) => a + (p - mean) * (p - mean), 0) / (samples.length - 1);
  return Math.round(Math.sqrt(variance) * 1000) / 10;
}

const MARKETS = ["h2h", "spreads", "totals"] as const;

/**
 * Scans a sport's live odds for positive-EV opportunities. For each event and
 * market, every bookmaker's own line (2-way, or 3-way like soccer h2h) is used
 * to remove the vig and produce a fair probability per outcome. The de-vig
 * method is NOT proportional: see devig.ts for why proportional removal
 * systematically overstates the longshot side and manufactures phantom edges on
 * lopsided markets. Fair
 * probabilities for the same outcome are then averaged across bookmakers to
 * get a consensus "true" price. Any outcome where the best available price
 * beats that consensus by at least `minEdgePercent` is returned.
 *
 * Outcomes are only considered when at least 2 bookmakers quote them, so a
 * single outlier line can't masquerade as a market consensus.
 */
export function computeEdges(events: OddsEvent[], sport: string, minEdgePercent: number): EdgeOpportunity[] {
  const edges: EdgeOpportunity[] = [];
  const devigMethod = configuredDevigMethod();

  for (const event of events) {
    for (const market of MARKETS) {
      const fairProbSamples = new Map<string, number[]>();
      const sharpSamples = new Map<string, number[]>();
      const publicSamples = new Map<string, number[]>();
      const best = new Map<string, { americanOdds: number; book: string }>();
      const dk = new Map<string, number>();
      const meta = new Map<string, { name: string; point: number | null }>();
      const sampleBooks = new Map<string, Set<string>>();

      for (const bookmaker of event.bookmakers) {
        const m = bookmaker.markets.find((mk) => mk.key === market);
        if (!m || m.outcomes.length < 2) continue;

        const impliedProbs = m.outcomes.map((o) => ({ outcome: o, prob: americanToImpliedProb(o.price) }));
        const overround = impliedProbs.reduce((sum, o) => sum + o.prob, 0);
        if (overround <= 0) continue;

        const fairProbs = devig(impliedProbs.map((o) => o.prob), devigMethod);

        for (let i = 0; i < impliedProbs.length; i++) {
          const { outcome } = impliedProbs[i];
          const point = outcome.point ?? null;
          const key = `${outcome.name}|${point ?? ""}`;
          const fairProb = fairProbs[i];

          if (!fairProbSamples.has(key)) fairProbSamples.set(key, []);
          fairProbSamples.get(key)!.push(fairProb);
          const splitSamples = isSharpBook(bookmaker.key) ? sharpSamples : publicSamples;
          if (!splitSamples.has(key)) splitSamples.set(key, []);
          splitSamples.get(key)!.push(fairProb);
          if (!sampleBooks.has(key)) sampleBooks.set(key, new Set());
          sampleBooks.get(key)!.add(bookmaker.key);
          meta.set(key, { name: outcome.name, point });

          // Every book feeds the consensus above, but only books you can
          // actually bet at are eligible to set the price EV is measured
          // against. Otherwise the EU books that come with Pinnacle would
          // fill the top of the list with unactionable edges.
          if (isBettableBook(bookmaker.key)) {
            const currentBest = best.get(key);
            const currentBestDecimal = currentBest ? americanToDecimal(currentBest.americanOdds) : -Infinity;
            if (americanToDecimal(outcome.price) > currentBestDecimal) {
              best.set(key, { americanOdds: outcome.price, book: bookmaker.title });
            }
          }

          if (bookmaker.key === "draftkings") {
            dk.set(key, outcome.price);
          }
        }
      }

      for (const [key, samples] of fairProbSamples) {
        if (samples.length < 2) continue;
        const bestForKey = best.get(key);
        const info = meta.get(key);
        if (!bestForKey || !info) continue;

        const avgFairProb = samples.reduce((sum, p) => sum + p, 0) / samples.length;
        const decimalBest = americanToDecimal(bestForKey.americanOdds);
        const evPercent = (decimalBest * avgFairProb - 1) * 100;

        if (evPercent >= minEdgePercent) {
          const bookCount = sampleBooks.get(key)?.size ?? samples.length;
          const sharpProb = avgProbPercent(sharpSamples.get(key));
          const confidence = assessConfidence({
            bookCount,
            evPercent,
            dispersionPercent: dispersionPercent(samples),
            sharpProb,
            publicProb: avgProbPercent(publicSamples.get(key)),
            impliedProbPercent: (1 / decimalBest) * 100,
          });
          edges.push({
            gameId: event.id,
            sport,
            commenceTime: event.commence_time,
            homeTeam: event.home_team,
            awayTeam: event.away_team,
            market,
            selection: info.name,
            point: info.point,
            player: null,
            americanOdds: bestForKey.americanOdds,
            book: bestForKey.book,
            dkOdds: dk.get(key) ?? null,
            marketProb: Math.round(avgFairProb * 1000) / 10,
            sharpProb,
            publicProb: avgProbPercent(publicSamples.get(key)),
            fairOdds: probToAmerican(avgFairProb),
            evPercent: Math.round(evPercent * 100) / 100,
            bookCount,
            dispersionPercent: dispersionPercent(samples),
            confidenceTier: confidence.tier,
            confidenceScore: confidence.score,
            confidenceReasons: confidence.reasons,
          });
        }
      }
    }
  }

  return edges.sort((a, b) => b.evPercent - a.evPercent);
}
