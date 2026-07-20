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
  /**
   * Percentage of bets (tickets) placed on this outcome by the public.
   * Null when no betting-percentage data is available.
   * Currently a deterministic placeholder — wire to a real data source (e.g. Action Network)
   * by replacing mockBettingPct with a real API call in computeEdges.
   */
  publicTicketPct: number | null;
  /**
   * Percentage of total dollar volume wagered on this outcome.
   * Diverges from publicTicketPct when sharp (private) money backs the other side.
   * Null when no betting-percentage data is available.
   */
  publicMoneyPct: number | null;
}

const MARKETS = ["h2h", "spreads", "totals"] as const;

/**
 * Generates deterministic placeholder betting-percentage figures.
 * Seeded by a stable key so the same bet shows the same numbers across refreshes.
 *
 * TODO: replace with a real data source (e.g. Action Network API) that returns
 * actual ticket-count % and dollar-volume % per outcome.
 */
export function mockBettingPct(seed: string): { publicTicketPct: number; publicMoneyPct: number } {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  }
  const h2 = (Math.imul(31, h) + 7919) | 0;
  // Ticket %: 35–75 (most public bets go 50-70% on the favourite)
  const publicTicketPct = 35 + (Math.abs(h) % 41);
  // Money % can diverge ±15 pp from ticket % (sharp money moves the number)
  const rawMoney = publicTicketPct + ((Math.abs(h2) % 31) - 15);
  const publicMoneyPct = Math.max(20, Math.min(80, rawMoney));
  return { publicTicketPct, publicMoneyPct };
}

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
          const { publicTicketPct, publicMoneyPct } = mockBettingPct(
            `${event.id}|${market}|${info.name}|${info.point ?? ""}`
          );
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
            publicTicketPct,
            publicMoneyPct,
          });
        }
      }
    }
  }

  return edges.sort((a, b) => b.evPercent - a.evPercent);
}
