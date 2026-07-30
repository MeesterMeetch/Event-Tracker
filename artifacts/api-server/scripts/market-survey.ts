/**
 * Market softness survey. Run with `pnpm market:survey`.
 *
 * Answers a strategic question rather than a tactical one: given limited
 * attention and limited API credits, where is this scanner actually worth
 * pointing?
 *
 * It exists because "college football is softer than the NFL" is a claim worth
 * checking rather than believing. Your own feed can settle it: scan several
 * sports, strip the vig out of every book's price, and measure how much the
 * books disagree with each other and how much edge is available from simply
 * always taking the best quote.
 *
 * Usage:
 *   pnpm market:survey                                 game lines, default sports
 *   pnpm market:survey --sports americanfootball_nfl,americanfootball_ncaaf
 *   pnpm market:survey --props --events 2              also sample player props
 *
 * Credit cost: one call per sport for game lines. Props cost one call per event
 * sampled, which is why they are opt-in and capped by --events.
 */

import { fetchOdds, fetchEvents, fetchEventOdds, logRequestsRemaining } from "../src/lib/odds";
import { getPropMarkets } from "../src/lib/props";
import { surveyMarkets, interpretSurvey, type MarketStats } from "../src/lib/market-survey";
import { configuredDevigMethod } from "../src/lib/devig";

const DEFAULT_SPORTS = [
  "americanfootball_nfl",
  "americanfootball_ncaaf",
  "baseball_mlb",
  "basketball_nba",
];

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function pct(x: number, digits = 2): string {
  return `${x.toFixed(digits)}%`;
}

function printTable(rows: MarketStats[]): void {
  console.log(
    "sport                     market                      events  outs  books   vig    disagree   best-price   >2%",
  );
  for (const r of rows) {
    console.log(
      `${r.sport.slice(0, 25).padEnd(26)}${r.market.slice(0, 27).padEnd(28)}` +
        `${String(r.events).padStart(6)}${String(r.outcomes).padStart(6)}` +
        `${String(r.medianBookCount).padStart(7)}` +
        `${pct(r.meanOverroundPercent, 1).padStart(7)}` +
        `${pct(r.meanDispersionPercent, 2).padStart(11)}` +
        `${pct(r.meanBestPriceEdgePercent, 2).padStart(13)}` +
        `${pct(r.shareAboveTwoPercent * 100, 0).padStart(7)}`,
    );
  }
}

async function surveyGameLines(sports: string[]): Promise<MarketStats[]> {
  const all: MarketStats[] = [];
  for (const sport of sports) {
    try {
      const { data, requestsRemaining } = await fetchOdds(sport);
      logRequestsRemaining(`market-survey ${sport}`, requestsRemaining);
      if (data.length === 0) {
        console.log(`  ${sport}: no games on the board`);
        continue;
      }
      const rows = surveyMarkets(data, sport);
      console.log(`  ${sport}: ${data.length} events, ${rows.length} markets`);
      all.push(...rows);
    } catch (err) {
      console.log(`  ${sport}: failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return all;
}

async function surveyProps(sports: string[], maxEvents: number): Promise<MarketStats[]> {
  const all: MarketStats[] = [];
  for (const sport of sports) {
    const markets = getPropMarkets(sport);
    if (!markets || markets.length === 0) {
      console.log(`  ${sport}: no prop markets configured`);
      continue;
    }
    try {
      const events = await fetchEvents(sport);
      if (events.length === 0) {
        console.log(`  ${sport}: no events to sample`);
        continue;
      }
      const sample = events.slice(0, maxEvents);
      const collected = [];
      for (const stub of sample) {
        const { data, requestsRemaining } = await fetchEventOdds(sport, stub.id, markets);
        logRequestsRemaining(`market-survey props ${sport}`, requestsRemaining);
        collected.push(data);
      }
      const rows = surveyMarkets(collected, sport);
      console.log(`  ${sport}: sampled ${sample.length} events, ${rows.length} prop markets`);
      all.push(...rows);
    } catch (err) {
      console.log(`  ${sport}: failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return all;
}

async function main(): Promise<void> {
  const sports = (arg("--sports") ?? DEFAULT_SPORTS.join(",")).split(",").map((s) => s.trim());
  const includeProps = process.argv.includes("--props");
  const maxEvents = Number(arg("--events") ?? 2);

  console.log("Market softness survey");
  console.log("======================");
  console.log(`Sports:       ${sports.join(", ")}`);
  console.log(`Devig method: ${configuredDevigMethod()}`);
  console.log(`Props:        ${includeProps ? `yes, up to ${maxEvents} events per sport` : "no (pass --props to include)"}`);
  console.log("");

  console.log("Scanning game lines...");
  const gameLines = await surveyGameLines(sports);

  let props: MarketStats[] = [];
  if (includeProps) {
    console.log("");
    console.log("Sampling player props...");
    props = await surveyProps(sports, maxEvents);
  }

  const all = [...gameLines, ...props].sort(
    (a, b) => b.meanBestPriceEdgePercent - a.meanBestPriceEdgePercent,
  );

  console.log("");
  console.log("Results, most exploitable first");
  console.log("===============================");
  if (all.length === 0) {
    console.log("Nothing measurable. Most likely the sports scanned are out of season.");
    console.log("Football boards fill out through August, so this is worth re-running then.");
    return;
  }
  printTable(all);

  console.log("");
  console.log("Columns");
  console.log("=======");
  console.log("vig        Bookmaker margin. A cost, not an opportunity.");
  console.log("disagree   Spread of de-vigged fair probabilities across books. The opportunity.");
  console.log("best-price EV of always taking the best quote against consensus. The headline.");
  console.log(">2%        Share of outcomes where that edge clears two percent.");

  console.log("");
  console.log("Read");
  console.log("====");
  for (const note of interpretSurvey(all)) {
    console.log(note);
    console.log("");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("market:survey failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
