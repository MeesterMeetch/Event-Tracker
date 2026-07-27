/**
 * Edge persistence probe. Run with `pnpm edge:decay`.
 *
 * Scans a sport for +EV edges, waits, scans the identical markets again, and
 * reports how many of those edges were still there. The point is to separate
 * genuine market inefficiency from stale quotes in the odds feed.
 *
 * Usage:
 *   pnpm edge:decay                                  MLB game lines, 60s delay
 *   pnpm edge:decay --sport americanfootball_nfl
 *   pnpm edge:decay --sport baseball_mlb --delay 120 --min-edge 1
 *   pnpm edge:decay --props --event <eventId> --sport baseball_mlb
 *
 * Each round costs odds-API credits: two scans per round. Game-line scans are
 * one credit each; prop scans are per-event and more expensive, which is why
 * prop mode requires an explicit event id rather than sweeping a slate.
 */

import { fetchOdds, fetchEventOdds, logRequestsRemaining } from "../src/lib/odds";
import { computeEdges, type EdgeOpportunity } from "../src/lib/ev";
import { computePropEdges, getPropMarkets } from "../src/lib/props";
import { compareScans, decayReport, type EdgeSnapshot } from "../src/lib/edge-decay";
import { configuredDevigMethod } from "../src/lib/devig";

interface Args {
  sport: string;
  delaySeconds: number;
  minEdge: number;
  rounds: number;
  props: boolean;
  eventId: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  return {
    sport: get("--sport") ?? "baseball_mlb",
    delaySeconds: Number(get("--delay") ?? 60),
    minEdge: Number(get("--min-edge") ?? 2),
    rounds: Number(get("--rounds") ?? 1),
    props: argv.includes("--props"),
    eventId: get("--event"),
  };
}

function toSnapshots(edges: EdgeOpportunity[]): EdgeSnapshot[] {
  return edges.map((e) => ({
    gameId: e.gameId,
    market: e.market,
    selection: e.selection,
    point: e.point,
    player: e.player,
    book: e.book,
    americanOdds: e.americanOdds,
    evPercent: e.evPercent,
  }));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function scanOnce(args: Args): Promise<EdgeSnapshot[]> {
  if (args.props) {
    if (!args.eventId) throw new Error("--props requires --event <eventId>");
    const markets = getPropMarkets(args.sport);
    if (!markets || markets.length === 0) throw new Error(`No prop markets configured for ${args.sport}`);
    const { data, requestsRemaining } = await fetchEventOdds(args.sport, args.eventId, markets);
    logRequestsRemaining("edge-decay props", requestsRemaining);
    // minEdge 0 here: we want every quoted side so the re-scan can match on
    // edges that decayed below the threshold rather than counting them vanished.
    return toSnapshots(computePropEdges(data, args.sport, -100));
  }
  const { data, requestsRemaining } = await fetchOdds(args.sport);
  logRequestsRemaining("edge-decay lines", requestsRemaining);
  return toSnapshots(computeEdges(data, args.sport, -100));
}

function pct(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log("Edge persistence probe");
  console.log("======================");
  console.log(`Sport:        ${args.sport}${args.props ? ` (props, event ${args.eventId})` : " (game lines)"}`);
  console.log(`Delay:        ${args.delaySeconds}s`);
  console.log(`Min edge:     ${args.minEdge}%`);
  console.log(`Rounds:       ${args.rounds}`);
  console.log(`Devig method: ${configuredDevigMethod()}`);
  console.log("");

  const allComparisons = [];

  for (let round = 1; round <= args.rounds; round++) {
    console.log(`Round ${round}: first scan...`);
    const first = await scanOnce(args);
    // Only edges at or above the threshold are the ones we claim to bet.
    const flagged = first.filter((e) => e.evPercent >= args.minEdge);
    console.log(`  ${first.length} priced sides, ${flagged.length} at or above ${args.minEdge}% EV`);

    if (flagged.length === 0) {
      console.log("  Nothing flagged this round; skipping the re-scan to save credits.");
      if (round < args.rounds) await sleep(args.delaySeconds * 1000);
      continue;
    }

    console.log(`  waiting ${args.delaySeconds}s...`);
    await sleep(args.delaySeconds * 1000);

    console.log("  second scan...");
    const second = await scanOnce(args);
    const comparisons = compareScans(flagged, second);
    allComparisons.push(...comparisons);
    console.log("");
  }

  if (allComparisons.length === 0) {
    console.log("No flagged edges across any round, so there is nothing to measure.");
    console.log("Try a lower --min-edge, a sport with a fuller slate, or more --rounds.");
    return;
  }

  const report = decayReport(allComparisons);

  console.log("Results");
  console.log("=======");
  console.log(`Flagged edges:      ${report.totalEdges}`);
  console.log(`Still quoted:       ${report.matched}`);
  console.log(`  price held:       ${report.persisted}`);
  console.log(`  price improved:   ${report.improved}`);
  console.log(`  price worsened:   ${report.worsened}`);
  console.log(`Vanished entirely:  ${report.vanished}`);
  console.log(`Survival rate:      ${pct(report.overallSurvivalRate)}`);
  console.log(
    `Mean EV change:     ${report.meanEvDelta == null ? "n/a" : `${report.meanEvDelta.toFixed(2)} points`}`,
  );

  console.log("");
  console.log("By edge size");
  console.log("bucket          n    survived   vanished   mean EV change");
  for (const b of report.byEvBucket) {
    console.log(
      `${b.label.padEnd(15)} ${String(b.count).padStart(3)}   ${pct(b.survivalRate).padStart(7)}    ` +
        `${pct(b.vanished / b.count).padStart(7)}    ` +
        `${(b.meanEvDelta == null ? "n/a" : b.meanEvDelta.toFixed(2)).padStart(8)}`,
    );
  }

  console.log("");
  console.log("By book (worst first)");
  console.log("book                      n    survived   vanished");
  for (const b of report.byBook) {
    console.log(
      `${b.book.slice(0, 24).padEnd(25)} ${String(b.count).padStart(3)}   ` +
        `${pct(b.survivalRate).padStart(7)}    ${pct(b.vanishRate).padStart(7)}`,
    );
  }

  console.log("");
  console.log("Read");
  console.log("====");
  console.log(report.interpretation);
  console.log("");
  console.log(
    "A book near the top of that list is quoting prices that are gone by the time you act. " +
      "If one book dominates your flagged edges and also sits at the top, your EV distribution is mostly that book's latency.",
  );
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("edge:decay failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
