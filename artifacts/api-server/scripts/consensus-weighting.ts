/**
 * Consensus weighting probe. Run with `pnpm consensus:weighting`.
 *
 * Asks whether the flat average across every book in the feed is the right
 * definition of a fair price now that the EU region is on. Pinnacle is the only
 * reason to pull that region, but it arrives with roughly twenty European
 * recreational books alongside it, and under a flat average Pinnacle is one
 * vote in about twenty five. Meanwhile the bettable-books allowlist still draws
 * the best price from three US books.
 *
 * The math lives in src/lib/consensus-weighting.ts and is unit tested. This
 * file is I/O and formatting only.
 *
 * Cost: one call, the same as a single Live Edges load. Six credits at us,eu.
 *
 * Usage:
 *   pnpm consensus:weighting
 *   pnpm consensus:weighting --sport americanfootball_nfl
 *   pnpm consensus:weighting --min-edge 2
 */

import { fetchOdds, fetchEvents, fetchEventOdds, logRequestsRemaining } from "../src/lib/odds";
import { getPropMarkets } from "../src/lib/props";
import {
  collectOutcomes,
  compareConstructions,
  describeFeed,
  interpretComparison,
  bookValueReport,
  collectPropOutcomes,
} from "../src/lib/consensus-weighting";
import { configuredDevigMethod } from "../src/lib/devig";
import { lineRegions, propRegions } from "../src/lib/odds-regions";
import { describeBettableBooks, bettableBooks } from "../src/lib/bettable-books";

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function padStart(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

function pct(x: number | null, digits = 2): string {
  return x == null ? "n/a" : `${x.toFixed(digits)}%`;
}

async function main(): Promise<void> {
  const sport = arg("--sport") ?? "baseball_mlb";
  const floor = Number(arg("--min-edge") ?? 1);
  const props = process.argv.includes("--props");
  let eventId = arg("--event");

  const markets = props ? getPropMarkets(sport) : null;
  if (props && (!markets || markets.length === 0)) {
    console.error(`No prop markets are configured for ${sport}. See PROP_MARKETS in props.ts.`);
    process.exit(1);
  }

  console.log("Consensus weighting probe");
  console.log("=========================");
  console.log(`Sport:         ${sport}`);
  console.log(`Mode:          ${props ? "player props" : "game lines"}`);
  console.log(`Regions:       ${props ? propRegions() : lineRegions()}`);
  console.log(`Devig method:  ${configuredDevigMethod()}`);
  console.log(`Bettable:      ${describeBettableBooks()}`);
  console.log(`Edge floor:    ${floor}%  (selectTopPlays defaults to 1%)`);
  if (props && markets) {
    const regionCount = propRegions().split(",").filter(Boolean).length;
    console.log(`Markets:       ${markets.join(", ")}`);
    console.log(
      `Credit cost:   ${markets.length} markets x ${regionCount} region(s) = ` +
        `${markets.length * regionCount} for this one event`,
    );
  }
  console.log("");

  let eventCount = 0;
  let outcomes;

  if (props && markets) {
    if (!eventId) {
      // The events endpoint is free, so picking a game costs nothing. Taking the
      // first upcoming one is arbitrary but honest; a specific --event is better
      // if you care which game you are measuring.
      const stubs = await fetchEvents(sport);
      if (stubs.length === 0) {
        console.log("No upcoming events for this sport, so there is nothing to measure.");
        return;
      }
      eventId = stubs[0].id;
      console.log(`No --event given, so using the first upcoming game: ${eventId}`);
      console.log("");
    }

    const { data, requestsRemaining } = await fetchEventOdds(sport, eventId, markets);
    logRequestsRemaining("consensus-weighting props", requestsRemaining);
    console.log(`Event:         ${data.away_team} at ${data.home_team}`);
    console.log("");
    eventCount = 1;
    outcomes = collectPropOutcomes(data);
  } else {
    const { data, requestsRemaining } = await fetchOdds(sport);
    logRequestsRemaining("consensus-weighting", requestsRemaining);
    if (data.length === 0) {
      console.log("No events in the feed for this sport right now, so there is nothing to measure.");
      return;
    }
    eventCount = data.length;
    outcomes = collectOutcomes(data);
  }

  const scorable = outcomes.filter((o) => o.bestBettable !== null && o.fairByBook.size >= 2);
  if (scorable.length === 0) {
    console.log("Nothing on this event was quoted by two or more books at a bettable price.");
    return;
  }
  const feed = { ...describeFeed([], scorable), events: eventCount };

  console.log("Feed composition");
  console.log("================");
  console.log(`Events:                       ${feed.events}`);
  console.log(`Priced outcomes:              ${feed.pricedOutcomes}`);
  console.log(`Distinct books:               ${feed.distinctBooks}`);
  console.log(`  sharp:                      ${feed.sharpBooks.length}  (${feed.sharpBooks.join(", ") || "none"})`);
  console.log(`  bettable:                   ${feed.bettableBooks.length}  (${feed.bettableBooks.join(", ") || "none"})`);
  console.log(`  neither:                    ${feed.neitherCount}`);
  console.log(
    `Outcomes a sharp book quotes: ${feed.outcomesQuotedBySharp} of ${feed.pricedOutcomes}` +
      (feed.pricedOutcomes
        ? ` (${((feed.outcomesQuotedBySharp / feed.pricedOutcomes) * 100).toFixed(0)}%)`
        : ""),
  );
  console.log(`Median books per outcome:     ${feed.medianBooksPerOutcome}`);
  console.log("");
  console.log(
    `Under a flat average one sharp book carries 1/${feed.medianBooksPerOutcome} of the vote, and`,
  );
  console.log(
    `${feed.neitherCount} of ${feed.distinctBooks} books can neither anchor the price nor be bet.`,
  );
  console.log("");

  const stats = compareConstructions(scorable, floor);

  console.log("Fair-price construction comparison");
  console.log("==================================");
  console.log(
    pad("scheme", 12) +
      padStart("scored", 8) +
      padStart("mean EV", 10) +
      padStart("median EV", 11) +
      padStart(`>=${floor}%`, 9) +
      padStart(">=2%", 7) +
      padStart("best EV", 10),
  );
  for (const s of stats) {
    console.log(
      pad(s.scheme, 12) +
        padStart(String(s.scored), 8) +
        padStart(pct(s.meanEvPercent), 10) +
        padStart(pct(s.medianEvPercent), 11) +
        padStart(String(s.clearingFloor), 9) +
        padStart(String(s.clearingTwoPercent), 7) +
        padStart(pct(s.bestEvPercent), 10),
    );
  }

  console.log("");
  console.log("Read");
  console.log("====");
  console.log(interpretComparison(stats, floor));
  console.log("");
  console.log(
    "Sanity check: the bettable row is scored against a consensus built from the same three",
  );
  console.log(
    "books that supply the best price, so treat it as a control rather than a candidate.",
  );
  console.log("");
  console.log("What another book would be worth");
  console.log("===============================");

  const allow = bettableBooks();
  if (allow === null) {
    console.log("BETTABLE_BOOKS is set to \"all\", so there is no allowlist to expand.");
  } else {
    const value = bookValueReport(scorable, allow, "all", floor);
    console.log(
      `Baseline (${value.currentAllowlist.join(", ")}): mean ${pct(value.baselineMeanEvPercent)}, ` +
        `${value.baselineClearingFloor} clearing ${floor}%`,
    );
    console.log(
      `Ceiling (every book bettable):  mean ${pct(value.ceilingMeanEvPercent)}, ` +
        `${value.ceilingClearingFloor} clearing ${floor}%   <- not achievable, just the headroom`,
    );
    console.log("");
    console.log(
      pad("book", 22) +
        padStart("quotes", 8) +
        padStart("improves", 10) +
        padStart("mean EV", 10) +
        padStart("delta", 9) +
        padStart(`>=${floor}%`, 8),
    );
    // Books that never improve a price are noise in this table, however much
    // they quote, so they are collapsed into a single line at the end.
    const useful = value.candidates.filter((c) => c.timesImproves > 0);
    const useless = value.candidates.length - useful.length;
    for (const c of useful) {
      console.log(
        pad(c.title, 22) +
          padStart(String(c.outcomesQuoted), 8) +
          padStart(String(c.timesImproves), 10) +
          padStart(pct(c.meanEvPercent), 10) +
          padStart(c.deltaPoints == null ? "n/a" : `${c.deltaPoints >= 0 ? "+" : ""}${c.deltaPoints.toFixed(2)}`, 9) +
          padStart(String(c.clearingFloor), 8),
      );
    }
    if (useless > 0) {
      console.log(
        `${pad(`(${useless} books never improve a price)`, 22)}${padStart("-", 8)}${padStart("0", 10)}` +
          `${padStart("-", 10)}${padStart("+0.00", 9)}${padStart("-", 8)}`,
      );
    }
    console.log("");
    console.log(
      "Read the improves column before the delta column. A book quoting every outcome but",
    );
    console.log(
      "improving none is worth nothing to you. The delta is what mean EV does if that one book",
    );
    console.log(
      "joins the allowlist, and it costs no extra credits because it is already in this payload.",
    );
    console.log("");
    console.log(
      "This says nothing about whether you can open an account there. That is your call, not the",
    );
    console.log("data's. Most of these will be European books you cannot reach.");
  }

  console.log("");
  console.log(
    "One scan is one observation. A quiet afternoon five hours from first pitch is not the same",
  );
  console.log(
    "market as an hour out, so run this again near game time and on another sport before",
  );
  console.log("changing how EV is computed.");
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("consensus:weighting failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
