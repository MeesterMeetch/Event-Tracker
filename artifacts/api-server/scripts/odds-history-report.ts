/**
 * Odds history report. Run with `pnpm odds:history`.
 *
 * Two questions, both unanswerable before snapshots were being stored:
 *
 *   1. Is the "sharp consensus" real? SHARP_BOOK_KEYS lists Pinnacle, but the
 *      feed does not carry it. If the sharp share of stored quotes is near
 *      zero, then the sharp-versus-public split in the UI is a soft-book
 *      average with a misleading label, and no model refinement fixes a
 *      mislabelled input.
 *   2. How do lines actually move, and which books move first?
 *
 * Usage:
 *   pnpm odds:history                          sharp coverage, last 7 days
 *   pnpm odds:history --days 30
 *   pnpm odds:history --game <gameId> --market totals --selection Over
 */

import { and, eq, sql } from "drizzle-orm";
import { db, oddsSnapshotsTable } from "@workspace/db";
import { sharpCoverageStats } from "../src/lib/odds-recorder";
import { lineMovementByBook, bookLeadership } from "../src/lib/odds-history";

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function pct(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a";
}

function heading(title: string): void {
  console.log("");
  console.log(title);
  console.log("=".repeat(title.length));
}

async function sharpCoverage(days: number): Promise<void> {
  heading(`Sharp book coverage (last ${days} days)`);
  const stats = await sharpCoverageStats(days);

  if (stats.totalRows === 0) {
    console.log("No snapshots stored yet. Set ODDS_HISTORY_ENABLED=true and run a few scans.");
    return;
  }

  console.log(`Total quotes stored:  ${stats.totalRows.toLocaleString()}`);
  console.log(`From sharp books:     ${stats.sharpRows.toLocaleString()} (${pct(stats.sharpShare)})`);
  console.log("");
  console.log("book                        quotes    sharp");
  for (const b of stats.byBook.slice(0, 25)) {
    console.log(
      `${b.book.slice(0, 26).padEnd(27)} ${String(b.rows).padStart(7)}    ${b.isSharp ? "yes" : "no"}`,
    );
  }

  console.log("");
  if (stats.sharpShare === 0) {
    console.log(
      "No sharp books at all. The sharp-versus-public split is currently meaningless: " +
        "every quote is coming from a soft book. Treat the 'sharp' number in the UI as a second soft consensus.",
    );
  } else if (stats.sharpShare < 0.05) {
    console.log(
      "Sharp coverage is very thin. The split fires rarely enough that it is closer to noise than signal, " +
        "and any single sharp quote is carrying far too much weight.",
    );
  } else {
    console.log("Sharp coverage looks usable. The split is running on real data.");
  }
  const pinnacle = stats.byBook.find((b) => b.book === "pinnacle");
  console.log(
    pinnacle
      ? `Pinnacle is present with ${pinnacle.rows} quotes.`
      : "Pinnacle is absent, as expected: it is not carried by this feed. It stays in SHARP_BOOK_KEYS only so it would be picked up automatically if the data source ever changes.",
  );
}

async function movement(gameId: string, market: string, selection: string): Promise<void> {
  heading(`Line movement: ${gameId} / ${market} / ${selection}`);

  const rows = await db
    .select({
      capturedAt: oddsSnapshotsTable.capturedAt,
      book: oddsSnapshotsTable.book,
      bookTitle: oddsSnapshotsTable.bookTitle,
      americanOdds: oddsSnapshotsTable.americanOdds,
      point: oddsSnapshotsTable.point,
      isSharp: oddsSnapshotsTable.isSharp,
    })
    .from(oddsSnapshotsTable)
    .where(
      and(
        eq(oddsSnapshotsTable.gameId, gameId),
        eq(oddsSnapshotsTable.market, market),
        eq(oddsSnapshotsTable.selection, selection),
      ),
    )
    .orderBy(sql`${oddsSnapshotsTable.capturedAt} asc`);

  if (rows.length === 0) {
    console.log("No stored snapshots for that outcome.");
    return;
  }

  console.log(`${rows.length} stored quotes.`);
  console.log("");
  console.log("book                   open     latest   move   line move   changes");
  for (const m of lineMovementByBook(rows)) {
    const lineMove = m.pointDelta == null ? "n/a" : m.pointDelta.toFixed(1);
    console.log(
      `${m.book.slice(0, 20).padEnd(21)} ${String(m.openOdds).padStart(6)}   ` +
        `${String(m.latestOdds).padStart(6)}   ${String(m.oddsDelta).padStart(5)}   ` +
        `${lineMove.padStart(9)}   ${String(m.moveCount).padStart(7)}`,
    );
  }

  const leaders = bookLeadership(rows);
  if (leaders.length > 0 && leaders[0].sampleSize > 0) {
    console.log("");
    console.log(`Book leadership (${leaders[0].sampleSize} market moves observed)`);
    console.log("book                   leads   follows   lead rate");
    for (const l of leaders) {
      if (l.leads + l.follows === 0) continue;
      console.log(
        `${l.book.slice(0, 20).padEnd(21)} ${String(l.leads).padStart(5)}   ` +
          `${String(l.follows).padStart(7)}   ${pct(l.leadRate).padStart(9)}`,
      );
    }
    console.log("");
    console.log(
      "A book that consistently leads is moving on information before the rest of the market. " +
        "That is the closest thing to a sharp signal available without a sharp book in the feed. " +
        "One caveat: a book can move first by being wrong just as easily as by being informed, " +
        "so trust this only across a large sample of outcomes.",
    );
  }
}

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? 7);
  const gameId = arg("--game");

  await sharpCoverage(days);

  if (gameId) {
    await movement(gameId, arg("--market") ?? "totals", arg("--selection") ?? "Over");
  } else {
    console.log("");
    console.log("Pass --game <gameId> to see line movement and book leadership for one outcome.");
  }
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("odds:history failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
