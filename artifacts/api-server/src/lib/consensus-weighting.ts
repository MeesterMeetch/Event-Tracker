/**
 * Comparing definitions of "fair". Pure math, no I/O.
 *
 * computeEdges builds its fair probability by averaging de-vigged prices across
 * every book that quotes an outcome, one equally weighted vote each. That was a
 * reasonable design when the feed was US-only and roughly ten books deep.
 *
 * Adding the EU region changed the composition of that average rather than just
 * adding to it. The stated reason to want EU is Pinnacle, but Pinnacle arrives
 * with roughly twenty European recreational books alongside it, so under a flat
 * average Pinnacle becomes one vote in about twenty five. The bettable-books
 * allowlist meanwhile still draws the best price from three US books. EV is
 * therefore a comparison between a number computed over three books and a
 * number computed over twenty five, and the twenty five just moved underneath
 * it.
 *
 * Whether that matters is an empirical question, so this module recomputes the
 * same slate under several definitions of fair and lets the numbers answer.
 * Nothing here changes production behaviour; it exists to decide whether
 * production behaviour should change.
 *
 * The honest caveat, stated up front: none of these constructions is known to
 * be correct. Pinnacle is the best available public estimate of a true price,
 * not the true price. A scheme looking better on one slate is weak evidence,
 * and the right use of this is to run it a few times across different sports
 * and times of day before concluding anything.
 */

import type { OddsEvent } from "./odds";
import { americanToDecimal, americanToImpliedProb, isSharpBook } from "./odds-math";
import { isBettableBook } from "./bettable-books";
import { devig, configuredDevigMethod, type DevigMethod } from "./devig";

const MARKETS = ["h2h", "spreads", "totals"] as const;

/**
 * The constructions under test.
 *
 *   all         every book, flat average. What production does today.
 *   sharp       SHARP_BOOK_KEYS only.
 *   non-sharp   everything except those, isolating what the crowd alone says.
 *   bettable    the allowlist only. Self-referential, since the best price is
 *                 drawn from this same set, so it should look flattering.
 *                 Included precisely so that bias is visible rather than hidden.
 *   blend       half sharp, half everyone. Keeps crowd breadth while letting a
 *                 sharp book actually carry weight.
 */
export const CONSENSUS_SCHEMES = ["all", "sharp", "non-sharp", "bettable", "blend"] as const;
export type ConsensusScheme = (typeof CONSENSUS_SCHEMES)[number];

/** One priced outcome, with each book's de-vigged opinion kept separately. */
export interface PricedOutcome {
  gameId: string;
  market: string;
  selection: string;
  point: number | null;
  /** De-vigged fair probability from each book, keyed by bookmaker key. */
  fairByBook: Map<string, number>;
  /**
   * Every book's raw quoted price, keyed by bookmaker key. Kept alongside the
   * de-vigged view so an allowlist other than the production one can be scored
   * without re-fetching. That is what makes "what would Caesars be worth" a
   * question answerable from a scan you already paid for.
   */
  priceByBook: Map<string, { americanOdds: number; title: string }>;
  /** Best price at a book on the production allowlist, or null when none quote it. */
  bestBettable: { americanOdds: number; book: string } | null;
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/**
 * Collects every priced outcome from a slate, de-vigging each book's market
 * instance the same way computeEdges does so the comparison stays honest. Any
 * divergence here would show up as a difference between schemes that is really
 * a difference in methodology.
 */
export function collectOutcomes(events: OddsEvent[], method?: DevigMethod): PricedOutcome[] {
  const devigMethod = method ?? configuredDevigMethod();
  const out: PricedOutcome[] = [];

  for (const event of events) {
    for (const market of MARKETS) {
      const byKey = new Map<string, PricedOutcome>();

      for (const bookmaker of event.bookmakers) {
        const m = bookmaker.markets.find((mk) => mk.key === market);
        if (!m || m.outcomes.length < 2) continue;

        const implied = m.outcomes.map((o) => americanToImpliedProb(o.price));
        if (implied.reduce((a, b) => a + b, 0) <= 0) continue;
        const fair = devig(implied, devigMethod);

        for (let i = 0; i < m.outcomes.length; i++) {
          const o = m.outcomes[i];
          const point = o.point ?? null;
          const key = `${o.name}|${point ?? ""}`;

          let rec = byKey.get(key);
          if (!rec) {
            rec = {
              gameId: event.id,
              market,
              selection: o.name,
              point,
              fairByBook: new Map(),
              priceByBook: new Map(),
              bestBettable: null,
            };
            byKey.set(key, rec);
          }

          rec.fairByBook.set(bookmaker.key, fair[i]);
          rec.priceByBook.set(bookmaker.key, {
            americanOdds: o.price,
            title: bookmaker.title,
          });

          // Mirrors computeEdges: only allowlisted books may set the price EV is
          // measured against, however good an unreachable quote looks.
          if (isBettableBook(bookmaker.key)) {
            const current = rec.bestBettable;
            const currentDecimal = current ? americanToDecimal(current.americanOdds) : -Infinity;
            if (americanToDecimal(o.price) > currentDecimal) {
              rec.bestBettable = { americanOdds: o.price, book: bookmaker.title };
            }
          }
        }
      }

      out.push(...byKey.values());
    }
  }

  return out;
}

/**
 * Fair probability for one outcome under one construction, or null when that
 * construction has nothing to say about it.
 *
 * The two-book minimum matches computeEdges, with one deliberate exception: the
 * sharp scheme accepts a single book. Pinnacle on its own is more information
 * than two recreational books agreeing with each other, and requiring two would
 * discard most of the slate given only three sharp keys exist.
 */
export function fairUnder(outcome: PricedOutcome, scheme: ConsensusScheme): number | null {
  const entries = [...outcome.fairByBook.entries()];
  const sharp = entries.filter(([k]) => isSharpBook(k)).map(([, v]) => v);
  const nonSharp = entries.filter(([k]) => !isSharpBook(k)).map(([, v]) => v);
  const bettable = entries.filter(([k]) => isBettableBook(k)).map(([, v]) => v);
  const all = entries.map(([, v]) => v);

  switch (scheme) {
    case "all":
      return all.length >= 2 ? mean(all) : null;
    case "sharp":
      return sharp.length >= 1 ? mean(sharp) : null;
    case "non-sharp":
      return nonSharp.length >= 2 ? mean(nonSharp) : null;
    case "bettable":
      return bettable.length >= 2 ? mean(bettable) : null;
    case "blend": {
      const s = sharp.length >= 1 ? mean(sharp) : null;
      const a = all.length >= 2 ? mean(all) : null;
      if (s == null) return a;
      if (a == null) return s;
      return 0.5 * s + 0.5 * a;
    }
  }
}

/** EV of the best bettable price against a given construction, in percent. */
export function evUnder(outcome: PricedOutcome, scheme: ConsensusScheme): number | null {
  const fair = fairUnder(outcome, scheme);
  if (fair == null || outcome.bestBettable == null) return null;
  return (americanToDecimal(outcome.bestBettable.americanOdds) * fair - 1) * 100;
}

export interface SchemeStats {
  scheme: ConsensusScheme;
  /** Outcomes this construction could actually score. */
  scored: number;
  meanEvPercent: number | null;
  medianEvPercent: number | null;
  /** Count clearing the caller's floor, which should be selectTopPlays' 1%. */
  clearingFloor: number;
  clearingTwoPercent: number;
  bestEvPercent: number | null;
}

export function compareConstructions(
  outcomes: PricedOutcome[],
  floorPercent: number,
): SchemeStats[] {
  return CONSENSUS_SCHEMES.map((scheme) => {
    const evs = outcomes
      .map((o) => evUnder(o, scheme))
      .filter((e): e is number => e != null);

    return {
      scheme,
      scored: evs.length,
      meanEvPercent: mean(evs),
      medianEvPercent: evs.length ? median(evs) : null,
      clearingFloor: evs.filter((e) => e >= floorPercent).length,
      clearingTwoPercent: evs.filter((e) => e >= 2).length,
      bestEvPercent: evs.length ? Math.max(...evs) : null,
    };
  });
}

export interface FeedComposition {
  events: number;
  pricedOutcomes: number;
  distinctBooks: number;
  sharpBooks: string[];
  bettableBooks: string[];
  /** Books that neither anchor the price nor can be bet. The dilution term. */
  neitherCount: number;
  outcomesQuotedBySharp: number;
  medianBooksPerOutcome: number;
}

export function describeFeed(events: OddsEvent[], outcomes: PricedOutcome[]): FeedComposition {
  const seen = new Set<string>();
  for (const o of outcomes) for (const k of o.fairByBook.keys()) seen.add(k);

  const sharpBooks = [...seen].filter(isSharpBook).sort();
  const bettableBooks = [...seen].filter(isBettableBook).sort();

  return {
    events: events.length,
    pricedOutcomes: outcomes.length,
    distinctBooks: seen.size,
    sharpBooks,
    bettableBooks,
    neitherCount: seen.size - sharpBooks.length - bettableBooks.length,
    outcomesQuotedBySharp: outcomes.filter((o) => [...o.fairByBook.keys()].some(isSharpBook))
      .length,
    medianBooksPerOutcome: median(outcomes.map((o) => o.fairByBook.size)),
  };
}

/**
 * Plain-language read on the comparison. Deliberately hedged: one slate is one
 * observation, and the difference between schemes has to be large enough to
 * survive that before it justifies changing how EV is computed.
 */
export function interpretComparison(stats: SchemeStats[], floorPercent: number): string {
  const all = stats.find((s) => s.scheme === "all");
  const sharp = stats.find((s) => s.scheme === "sharp");

  if (!all || !sharp || all.meanEvPercent == null || sharp.meanEvPercent == null) {
    return "Not enough of the slate could be scored under both constructions to compare them.";
  }

  const gap = sharp.meanEvPercent - all.meanEvPercent;
  const counts =
    `Clearing ${floorPercent}%: ${all.clearingFloor} under today's flat average, ` +
    `${sharp.clearingFloor} under a sharp anchor.`;

  if (Math.abs(gap) < 0.25) {
    return (
      `Mean EV moves ${gap >= 0 ? "+" : ""}${gap.toFixed(2)} points under a sharp anchor, which is ` +
      `small. That argues the extra books are not distorting the consensus much and the flat ` +
      `average is defensible. A thin slate would then be a fact about the market rather than an ` +
      `artifact of how fair price is computed. ${counts}`
    );
  }

  if (gap > 0) {
    return (
      `Mean EV is ${gap.toFixed(2)} points higher under a sharp anchor. The sharp book rates your ` +
      `bettable prices better than the crowd does, so under a flat average those edges are being ` +
      `averaged away by books you cannot bet at that carry no less weight than Pinnacle. That is ` +
      `an argument for weighting. ${counts}`
    );
  }

  return (
    `Mean EV is ${Math.abs(gap).toFixed(2)} points lower under a sharp anchor. The sharp book rates ` +
    `your bettable prices worse than the crowd does, so the flat average is flattering you and ` +
    `edges clearing the bar today would not clear it against Pinnacle alone. That is the more ` +
    `uncomfortable result and the more useful one. ${counts}`
  );
}

/**
 * What each book in the feed would be worth if you could bet it.
 *
 * The motivating observation: EV here is overwhelmingly a function of how good
 * the best available price is, and the best of N prices improves with N. On a
 * typical scan the feed carries thirty-odd books while the allowlist carries
 * three, so the largest available lever is not the consensus math at all. It is
 * that twenty-something books already in a payload you have paid for are barred
 * from setting the price, most of them correctly (you cannot open an account at
 * Winamax) but some of them only because nobody has revisited the list.
 *
 * This scores that directly. For each book not currently on the allowlist, it
 * recomputes the whole slate as if that one book had been added, and reports
 * how far mean EV moves and how many outcomes cross the floor. A book that
 * quotes a lot but never improves the best price is worth nothing, and the
 * report will say so rather than leaving you to guess from its name.
 *
 * Nothing here decides whether you can actually bet somewhere. That is a fact
 * about your accounts, not about the data, and it stays your call.
 */

/** Best price among a given set of books, or null when none of them quote it. */
export function bestPriceAmong(
  outcome: PricedOutcome,
  allow: ReadonlySet<string>,
): { americanOdds: number; book: string } | null {
  let best: { americanOdds: number; book: string } | null = null;
  let bestDecimal = -Infinity;
  for (const [key, quote] of outcome.priceByBook) {
    if (!allow.has(key)) continue;
    const decimal = americanToDecimal(quote.americanOdds);
    if (decimal > bestDecimal) {
      bestDecimal = decimal;
      best = { americanOdds: quote.americanOdds, book: quote.title };
    }
  }
  return best;
}

/** Mean EV and floor-clearing count for one hypothetical allowlist. */
function scoreAllowlist(
  outcomes: PricedOutcome[],
  allow: ReadonlySet<string>,
  scheme: ConsensusScheme,
  floorPercent: number,
): { meanEvPercent: number | null; clearingFloor: number; scored: number } {
  const evs: number[] = [];
  for (const o of outcomes) {
    const fair = fairUnder(o, scheme);
    const best = bestPriceAmong(o, allow);
    if (fair == null || best == null) continue;
    evs.push((americanToDecimal(best.americanOdds) * fair - 1) * 100);
  }
  return {
    meanEvPercent: mean(evs),
    clearingFloor: evs.filter((e) => e >= floorPercent).length,
    scored: evs.length,
  };
}

export interface BookValue {
  book: string;
  title: string;
  /** Outcomes on this slate the book quotes at all. */
  outcomesQuoted: number;
  /** Outcomes where adding it would actually improve the best price. */
  timesImproves: number;
  /** Mean EV with this book added to the current allowlist. */
  meanEvPercent: number | null;
  /** Movement in mean EV versus the current allowlist, in percentage points. */
  deltaPoints: number | null;
  /** Outcomes clearing the floor once this book is added. */
  clearingFloor: number;
}

export interface BookValueReport {
  /** Mean EV and floor count as things stand today. */
  baselineMeanEvPercent: number | null;
  baselineClearingFloor: number;
  currentAllowlist: string[];
  /**
   * Upper bound: mean EV if every book in the feed were bettable. Not
   * achievable, and not a target. It is the ceiling the allowlist is trading
   * against, useful for knowing whether the remaining headroom is worth chasing.
   */
  ceilingMeanEvPercent: number | null;
  ceilingClearingFloor: number;
  /** Candidates, best first. */
  candidates: BookValue[];
}

export function bookValueReport(
  outcomes: PricedOutcome[],
  currentAllowlist: ReadonlySet<string>,
  scheme: ConsensusScheme,
  floorPercent: number,
): BookValueReport {
  const baseline = scoreAllowlist(outcomes, currentAllowlist, scheme, floorPercent);

  const everyBook = new Set<string>();
  const titles = new Map<string, string>();
  for (const o of outcomes) {
    for (const [k, q] of o.priceByBook) {
      everyBook.add(k);
      if (!titles.has(k)) titles.set(k, q.title);
    }
  }
  const ceiling = scoreAllowlist(outcomes, everyBook, scheme, floorPercent);

  const candidates: BookValue[] = [];
  for (const key of everyBook) {
    if (currentAllowlist.has(key)) continue;

    const expanded = new Set(currentAllowlist);
    expanded.add(key);
    const scored = scoreAllowlist(outcomes, expanded, scheme, floorPercent);

    let quoted = 0;
    let improves = 0;
    for (const o of outcomes) {
      const quote = o.priceByBook.get(key);
      if (!quote) continue;
      quoted += 1;
      const current = bestPriceAmong(o, currentAllowlist);
      const currentDecimal = current ? americanToDecimal(current.americanOdds) : -Infinity;
      if (americanToDecimal(quote.americanOdds) > currentDecimal) improves += 1;
    }

    candidates.push({
      book: key,
      title: titles.get(key) ?? key,
      outcomesQuoted: quoted,
      timesImproves: improves,
      meanEvPercent: scored.meanEvPercent,
      deltaPoints:
        scored.meanEvPercent == null || baseline.meanEvPercent == null
          ? null
          : scored.meanEvPercent - baseline.meanEvPercent,
      clearingFloor: scored.clearingFloor,
    });
  }

  candidates.sort((a, b) => (b.deltaPoints ?? -Infinity) - (a.deltaPoints ?? -Infinity));

  return {
    baselineMeanEvPercent: baseline.meanEvPercent,
    baselineClearingFloor: baseline.clearingFloor,
    currentAllowlist: [...currentAllowlist].sort(),
    ceilingMeanEvPercent: ceiling.meanEvPercent,
    ceilingClearingFloor: ceiling.clearingFloor,
    candidates,
  };
}

/**
 * The player-prop counterpart of collectOutcomes.
 *
 * Props need their own collector because the payload shape is different, not
 * because the analysis is. A game market gives one two-sided line per book. A
 * prop market response bundles every player at that book into one array, so the
 * Over/Under pair that the vig actually lives inside has to be reassembled from
 * (player, line) before anything can be de-vigged. This mirrors computePropEdges
 * deliberately, including its refusal to touch a pair that is not exactly one
 * Over and one Under, so that a difference in the output is a difference in the
 * market rather than in the method.
 *
 * The result is the same PricedOutcome shape game lines produce, which means
 * compareConstructions, describeFeed and bookValueReport all work on props with
 * no changes. That is the whole reason for the shared shape: the strategic
 * question ("is this market worth scanning") should be asked the same way of
 * every market, or the answers are not comparable.
 */
export function collectPropOutcomes(event: OddsEvent, method?: DevigMethod): PricedOutcome[] {
  const devigMethod = method ?? configuredDevigMethod();
  const byKey = new Map<string, PricedOutcome>();

  for (const bookmaker of event.bookmakers) {
    for (const market of bookmaker.markets) {
      const pairs = new Map<string, { name: string; price: number; point?: number }[]>();
      for (const outcome of market.outcomes) {
        // Props always carry the player here; anything without it is a team
        // market that wandered into the response and cannot be paired.
        if (!outcome.description) continue;
        const pairKey = `${outcome.description}|${outcome.point ?? ""}`;
        const list = pairs.get(pairKey) ?? [];
        list.push(outcome);
        pairs.set(pairKey, list);
      }

      for (const [pairKey, outcomes] of pairs) {
        // Exactly one Over and one Under. A one-sided quote, a duplicate row,
        // or an alternate-line artifact has no coherent overround to remove.
        if (outcomes.length !== 2 || outcomes[0].name === outcomes[1].name) continue;

        const implied = outcomes.map((o) => americanToImpliedProb(o.price));
        if (implied.reduce((a, b) => a + b, 0) <= 0) continue;
        const fair = devig(implied, devigMethod);

        const player = pairKey.slice(0, pairKey.lastIndexOf("|"));

        for (let i = 0; i < outcomes.length; i++) {
          const o = outcomes[i];
          const point = o.point ?? null;
          const key = `${market.key}|${player}|${o.name}|${point ?? ""}`;

          let rec = byKey.get(key);
          if (!rec) {
            rec = {
              gameId: event.id,
              market: market.key,
              // Carries the player so a prop reads as "Aaron Judge Over 1.5"
              // rather than an anonymous "Over" in any report built on this.
              selection: `${player} ${o.name}`,
              point,
              fairByBook: new Map(),
              priceByBook: new Map(),
              bestBettable: null,
            };
            byKey.set(key, rec);
          }

          rec.fairByBook.set(bookmaker.key, fair[i]);
          rec.priceByBook.set(bookmaker.key, {
            americanOdds: o.price,
            title: bookmaker.title,
          });

          if (isBettableBook(bookmaker.key)) {
            const current = rec.bestBettable;
            const currentDecimal = current ? americanToDecimal(current.americanOdds) : -Infinity;
            if (americanToDecimal(o.price) > currentDecimal) {
              rec.bestBettable = { americanOdds: o.price, book: bookmaker.title };
            }
          }
        }
      }
    }
  }

  return [...byKey.values()];
}
