/**
 * Pinnacle availability probe. Run with `pnpm pinnacle:probe`.
 *
 * Answers one question that a documentation page cannot: does *your* API key,
 * on *your* plan, actually receive Pinnacle prices, and for which markets?
 *
 * Background. The app hardcoded `regions=us` for its entire life, and Pinnacle
 * is an EU-region book, so it was never going to appear no matter what the plan
 * allowed. That made the sharp-versus-public split in the UI a comparison
 * between soft books. This probe establishes whether adding the EU region fixes
 * that, before committing to the credit cost of doing so everywhere.
 *
 * Cost. Deliberately small and stated up front rather than buried. Game lines
 * are three markets across two regions, so six credits. The optional prop check
 * is one market across two regions for a single event, so two more. Nothing
 * here sweeps a slate.
 *
 * Usage:
 *   pnpm pinnacle:probe                          MLB game lines
 *   pnpm pinnacle:probe --sport americanfootball_nfl
 *   pnpm pinnacle:probe --props                  also test one event's props
 */

import { fetchOdds, fetchEvents, fetchEventOdds, logRequestsRemaining } from "../src/lib/odds";
import { creditCost } from "../src/lib/odds-regions";
import { SHARP_BOOK_KEYS } from "../src/lib/odds-math";
import type { OddsEvent } from "../src/lib/odds";

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

/** Distinct bookmaker keys present across a set of events. */
function booksIn(events: OddsEvent[]): Map<string, string> {
  const books = new Map<string, string>();
  for (const e of events) for (const b of e.bookmakers) books.set(b.key, b.title);
  return books;
}

function report(label: string, books: Map<string, string>, cost: number): boolean {
  const sharp = Array.from(books.keys()).filter((k) => SHARP_BOOK_KEYS.has(k));
  const hasPinnacle = books.has("pinnacle");

  console.log("");
  console.log(label);
  console.log("-".repeat(label.length));
  console.log(`Credits spent:    ${cost}`);
  console.log(`Books returned:   ${books.size}`);
  console.log(`Sharp books:      ${sharp.length > 0 ? sharp.join(", ") : "none"}`);
  console.log(`Pinnacle present: ${hasPinnacle ? "YES" : "no"}`);

  if (books.size > 0) {
    console.log("");
    console.log("All books:");
    const names = Array.from(books.keys())
      .map((key) => `${key}${SHARP_BOOK_KEYS.has(key) ? " (sharp)" : ""}`)
      .sort();
    for (let i = 0; i < names.length; i += 4) {
      console.log("  " + names.slice(i, i + 4).map((n) => n.padEnd(24)).join(""));
    }
  }
  return hasPinnacle;
}

async function main(): Promise<void> {
  const sport = arg("--sport") ?? "baseball_mlb";
  const includeProps = process.argv.includes("--props");

  console.log("Pinnacle availability probe");
  console.log("===========================");
  console.log(`Sport: ${sport}`);
  console.log("Requesting regions us,eu explicitly, overriding the configured default.");

  // Game lines, both regions, so the comparison is like for like.
  const lineMarkets = "h2h,spreads,totals";
  const { data: withEu, requestsRemaining } = await fetchOdds(sport, lineMarkets, "us,eu");
  logRequestsRemaining("pinnacle-probe lines", requestsRemaining);

  if (withEu.length === 0) {
    console.log("");
    console.log("No games on the board for this sport, so there is nothing to inspect.");
    console.log("Try --sport baseball_mlb, or wait until the football boards fill out in August.");
    return;
  }

  const lineBooks = booksIn(withEu);
  const pinnacleOnLines = report(
    `Game lines (${withEu.length} events)`,
    lineBooks,
    creditCost(3, "us,eu"),
  );

  let pinnacleOnProps: boolean | null = null;
  if (includeProps) {
    // One market, one event. The cheapest possible prop test.
    const propMarket = sport === "baseball_mlb" ? "pitcher_strikeouts" : "player_pass_yds";
    const events = await fetchEvents(sport);
    if (events.length === 0) {
      console.log("");
      console.log("No events available to test props against.");
    } else {
      const { data, requestsRemaining: prem } = await fetchEventOdds(
        sport,
        events[0].id,
        [propMarket],
        "us,eu",
      );
      logRequestsRemaining("pinnacle-probe props", prem);
      pinnacleOnProps = report(
        `Player props, single event, market ${propMarket}`,
        booksIn([data]),
        creditCost(1, "us,eu"),
      );
    }
  }

  console.log("");
  console.log("What this means");
  console.log("===============");

  if (pinnacleOnLines) {
    console.log(
      "Pinnacle is reaching your key on game lines. Set ODDS_REGIONS_LINES=us,eu to keep it, " +
        "which doubles game-line cost from three credits per scan to six. That is the single best " +
        "value change available to this app: a genuine sharp anchor improves every fair price it computes.",
    );
  } else {
    console.log(
      "Pinnacle did not appear on game lines even with the EU region requested. Either your plan " +
        "excludes it or coverage is absent for this sport. Worth checking one other sport before " +
        "concluding, and worth asking The Odds API directly, since their pricing page shows no feature " +
        "gating by tier.",
    );
  }

  if (pinnacleOnProps === true) {
    console.log("");
    console.log(
      "Pinnacle also quotes props here. Be deliberate before setting ODDS_REGIONS_PROPS=us,eu: props " +
        "are billed per market per event, so a second region doubles your most expensive call. Worth it " +
        "for a focused single-market scan like the strikeout model, much less obviously worth it for an " +
        "eleven-market NFL sweep.",
    );
  } else if (pinnacleOnProps === false) {
    console.log("");
    console.log(
      "Pinnacle did not quote this prop market. Leave ODDS_REGIONS_PROPS at us: paying double for a " +
        "region that adds no sharp price is pure waste.",
    );
  }

  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("pinnacle:probe failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
