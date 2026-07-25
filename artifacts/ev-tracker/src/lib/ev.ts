import type { OddsEvent } from "./odds";
import {
  americanToDecimal,
  americanToImpliedProb,
  consensusProb,
  devig,
  isSharpBook,
  probToAmerican,
  type ProbSample,
} from "./odds-math";

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
  sharpProb: number | null;
  /** Same consensus probability (percent) averaged across public (recreational) books; null when none quote it. */
  publicProb: number | null;
}

/** Averages devigged fair-probability samples into a percent rounded to 0.1; null when no book contributed. */
export function avgProbPercent(samples: number[] | undefined): number | null {
  if (!samples || samples.length === 0) return null;
  const avg = samples.reduce((sum, p) => sum + p, 0) / samples.length;
  return Math.round(avg * 1000) / 10;
}

const MARKETS = ["h2h", "spreads", "totals"] as const;

/**
 * Scans a sport's live odds for positive-EV opportunities. For each event and
 * market, every bookmaker's own line (2-way, or 3-way like soccer h2h) is
 * devigged into fair probabilities per outcome (see `devig` in odds-math —
 * power method by default, which corrects the favourite-longshot bias the
 * older proportional devig left in place).
 *
 * Fair probabilities for the same outcome are then combined across bookmakers
 * into a consensus "true" price. That combination is weighted, not a plain
 * average: sharp books (Pinnacle, LowVig, BetOnline) count more than
 * recreational books, because their prices are closer to the true line. Any
 * outcome where the best available price beats that consensus by at least
 * `minEdgePercent` is returned.
 *
 * Outcomes are only considered when at least 2 bookmakers quote them, so a
 * single outlier line can't masquerade as a market consensus.
 */
export function computeEdges(events: OddsEvent[], sport: string, minEdgePercent: number): EdgeOpportunity[] {
  const edges: EdgeOpportunity[] = [];

  for (const event of events) {
    for (const market of MARKETS) {
      // Weighted samples drive the consensus fair price; the plain sharp/public
      // arrays stay unweighted because they are a display split, not an estimate.
      const fairProbSamples = new Map<string, ProbSample[]>();
      const sharpSamples = new Map<string, number[]>();
      const publicSamples = new Map<string, number[]>();
      const best = new Map<string, { americanOdds: number; book: string }>();
      const dk = new Map<string, number>();
      const meta = new Map<string, { name: string; point: number | null }>();

      for (const bookmaker of event.bookmakers) {
        const m = bookmaker.markets.find((mk) => mk.key === market);
        if (!m || m.outcomes.length < 2) continue;

        const rawProbs = m.outcomes.map((o) => americanToImpliedProb(o.price));
        const overround = rawProbs.reduce((sum, p) => sum + p, 0);
        if (overround <= 0) continue;

        const fairProbs = devig(rawProbs);
        const sharp = isSharpBook(bookmaker.key);

        m.outcomes.forEach((outcome, index) => {
          const point = outcome.point ?? null;
          const key = `${outcome.name}|${point ?? ""}`;
          const fairProb = fairProbs[index];
          if (!Number.isFinite(fairProb) || fairProb <= 0) return;

          if (!fairProbSamples.has(key)) fairProbSamples.set(key, []);
          fairProbSamples.get(key)!.push({ prob: fairProb, sharp });

          const splitSamples = sharp ? sharpSamples : publicSamples;
          if (!splitSamples.has(key)) splitSamples.set(key, []);
          splitSamples.get(key)!.push(fairProb);
          meta.set(key, { name: outcome.name, point });

          const currentBest = best.get(key);
          const currentBestDecimal = currentBest ? americanToDecimal(currentBest.americanOdds) : -Infinity;
          if (americanToDecimal(outcome.price) > currentBestDecimal) {
            best.set(key, { americanOdds: outcome.price, book: bookmaker.title });
          }

          if (bookmaker.key === "draftkings") {
            dk.set(key, outcome.price);
          }
        });
      }

      for (const [key, samples] of fairProbSamples) {
        if (samples.length < 2) continue;
        const bestForKey = best.get(key);
        const info = meta.get(key);
        if (!bestForKey || !info) continue;

        const avgFairProb = consensusProb(samples);
        if (avgFairProb == null || avgFairProb <= 0) continue;

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
            sharpProb: avgProbPercent(sharpSamples.get(key)),
            publicProb: avgProbPercent(publicSamples.get(key)),
            fairOdds: probToAmerican(avgFairProb),
            evPercent: Math.round(evPercent * 100) / 100,
          });
        }
      }
    }
  }

  return edges.sort((a, b) => b.evPercent - a.evPercent);
}
