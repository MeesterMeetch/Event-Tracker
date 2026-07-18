import type { OddsEvent } from "./odds";
import { americanToDecimal, americanToImpliedProb, probToAmerican } from "./odds-math";

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
}

const MARKETS = ["h2h", "spreads", "totals"] as const;

/**
 * Scans a sport's live odds for positive-EV opportunities. For each event and
 * market, every bookmaker's own line (2-way, or 3-way like soccer h2h) is used
 * to remove the vig (multiplicative devig) and produce a fair probability per
 * outcome; fair
 * probabilities for the same outcome are then averaged across bookmakers to
 * get a consensus "true" price. Any outcome where the best available price
 * beats that consensus by at least `minEdgePercent` is returned.
 *
 * Outcomes are only considered when at least 2 bookmakers quote them, so a
 * single outlier line can't masquerade as a market consensus.
 */
export function computeEdges(events: OddsEvent[], sport: string, minEdgePercent: number): EdgeOpportunity[] {
  const edges: EdgeOpportunity[] = [];

  for (const event of events) {
    for (const market of MARKETS) {
      const fairProbSamples = new Map<string, number[]>();
      const best = new Map<string, { americanOdds: number; book: string }>();
      const dk = new Map<string, number>();
      const meta = new Map<string, { name: string; point: number | null }>();

      for (const bookmaker of event.bookmakers) {
        const m = bookmaker.markets.find((mk) => mk.key === market);
        if (!m || m.outcomes.length < 2) continue;

        const impliedProbs = m.outcomes.map((o) => ({ outcome: o, prob: americanToImpliedProb(o.price) }));
        const overround = impliedProbs.reduce((sum, o) => sum + o.prob, 0);
        if (overround <= 0) continue;

        for (const { outcome, prob } of impliedProbs) {
          const point = outcome.point ?? null;
          const key = `${outcome.name}|${point ?? ""}`;
          const fairProb = prob / overround;

          if (!fairProbSamples.has(key)) fairProbSamples.set(key, []);
          fairProbSamples.get(key)!.push(fairProb);
          meta.set(key, { name: outcome.name, point });

          const currentBest = best.get(key);
          const currentBestDecimal = currentBest ? americanToDecimal(currentBest.americanOdds) : -Infinity;
          if (americanToDecimal(outcome.price) > currentBestDecimal) {
            best.set(key, { americanOdds: outcome.price, book: bookmaker.title });
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
            fairOdds: probToAmerican(avgFairProb),
            evPercent: Math.round(evPercent * 100) / 100,
          });
        }
      }
    }
  }

  return edges.sort((a, b) => b.evPercent - a.evPercent);
}
