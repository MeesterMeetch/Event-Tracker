import type { OddsEvent, OddsOutcome } from "./odds";
import type { EdgeOpportunity } from "./ev";
import { avgProbPercent } from "./ev";
import { americanToDecimal, americanToImpliedProb, isSharpBook, probToAmerican } from "./odds-math";

/**
 * Over/Under player-prop markets scanned per sport. Only two-sided O/U
 * markets are listed — Yes-only markets (anytime TD, first goal scorer,
 * pitcher to record a win) can't be devigged without a quoted "No" side.
 * Each market listed here costs one API credit per region on every game
 * scan, so the lists stay focused on the liquid core props.
 *
 * Market keys come from the Odds API betting-markets reference; prop
 * coverage is mainly US sports + US books.
 */
const PROP_MARKETS: Record<string, string[]> = {
  baseball_mlb: ["batter_hits", "batter_total_bases", "batter_home_runs", "batter_rbis", "pitcher_strikeouts"],
  basketball_nba: ["player_points", "player_rebounds", "player_assists", "player_threes", "player_points_rebounds_assists"],
  basketball_wnba: ["player_points", "player_rebounds", "player_assists", "player_threes", "player_points_rebounds_assists"],
  basketball_ncaab: ["player_points", "player_rebounds", "player_assists"],
  americanfootball_nfl: [
    "player_pass_yds",
    "player_pass_tds",
    "player_pass_completions",
    "player_pass_attempts",
    "player_pass_interceptions",
    "player_rush_yds",
    "player_rush_attempts",
    "player_receptions",
    "player_reception_yds",
    "player_rush_reception_yds",
    "player_kicking_points",
  ],
  americanfootball_ncaaf: [
    "player_pass_yds",
    "player_pass_tds",
    "player_rush_yds",
    "player_receptions",
    "player_reception_yds",
  ],
  americanfootball_cfl: ["player_pass_yds", "player_rush_yds", "player_receptions"],
  icehockey_nhl: ["player_points", "player_goals", "player_assists", "player_shots_on_goal", "player_total_saves"],
};

export function getPropMarkets(sportKey: string): string[] | null {
  return PROP_MARKETS[sportKey] ?? null;
}

export function sportSupportsProps(sportKey: string): boolean {
  return sportKey in PROP_MARKETS;
}

/**
 * Player-prop counterpart of computeEdges. A game market quotes one two-sided
 * line per book, but a prop market response bundles every player at that
 * book, so outcomes are first grouped per (player, line) within each book —
 * that Over/Under pair is the market the vig lives inside. Each pair is
 * devigged multiplicatively into fair probabilities, samples are averaged
 * across books quoting the exact same player and line, and any side whose
 * best available price beats that consensus by at least `minEdgePercent` is
 * returned. As with game lines, at least 2 books must quote a line before it
 * counts as consensus, so one book's stale number can't fabricate an edge.
 */
export function computePropEdges(event: OddsEvent, sport: string, minEdgePercent: number): EdgeOpportunity[] {
  const fairProbSamples = new Map<string, number[]>();
  const sharpSamples = new Map<string, number[]>();
  const publicSamples = new Map<string, number[]>();
  const sampleBooks = new Map<string, Set<string>>();
  const best = new Map<string, { americanOdds: number; book: string }>();
  const dk = new Map<string, number>();
  const meta = new Map<string, { market: string; player: string; name: string; point: number | null }>();

  for (const bookmaker of event.bookmakers) {
    for (const market of bookmaker.markets) {
      const pairs = new Map<string, OddsOutcome[]>();
      for (const outcome of market.outcomes) {
        if (!outcome.description) continue; // props always carry the player in description
        const pairKey = `${outcome.description}|${outcome.point ?? ""}`;
        const list = pairs.get(pairKey) ?? [];
        list.push(outcome);
        pairs.set(pairKey, list);
      }

      for (const outcomes of pairs.values()) {
        // A prop pair must be exactly one Over + one Under. Anything else —
        // a one-sided quote, duplicate rows from a book, alternate-line
        // artifacts — can't be devigged and would poison the overround.
        if (outcomes.length !== 2 || outcomes[0].name === outcomes[1].name) continue;

        const impliedProbs = outcomes.map((o) => ({ outcome: o, prob: americanToImpliedProb(o.price) }));
        const overround = impliedProbs.reduce((sum, o) => sum + o.prob, 0);
        if (overround <= 0) continue;

        for (const { outcome, prob } of impliedProbs) {
          const player = outcome.description!;
          const point = outcome.point ?? null;
          const key = `${market.key}|${player}|${outcome.name}|${point ?? ""}`;
          const fairProb = prob / overround;

          if (!fairProbSamples.has(key)) fairProbSamples.set(key, []);
          fairProbSamples.get(key)!.push(fairProb);
          const splitSamples = isSharpBook(bookmaker.key) ? sharpSamples : publicSamples;
          if (!splitSamples.has(key)) splitSamples.set(key, []);
          splitSamples.get(key)!.push(fairProb);
          if (!sampleBooks.has(key)) sampleBooks.set(key, new Set());
          sampleBooks.get(key)!.add(bookmaker.key); // stable ID, not display title
          meta.set(key, { market: market.key, player, name: outcome.name, point });

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
    }
  }

  const edges: EdgeOpportunity[] = [];
  for (const [key, samples] of fairProbSamples) {
    // Consensus needs 2+ *distinct* books — duplicate rows from a single
    // book must never be able to fabricate a consensus on their own.
    if ((sampleBooks.get(key)?.size ?? 0) < 2) continue;
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
        market: info.market,
        selection: info.name,
        point: info.point,
        player: info.player,
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

  return edges.sort((a, b) => b.evPercent - a.evPercent);
}
