import { lt, sql } from "drizzle-orm";
import type { OddsEvent } from "./odds";
import { snapshotRowsFromEvents } from "./odds-history";
import { logger } from "./logger";

/**
 * The db package throws at import time when DATABASE_URL is unset, so this
 * module must not import it eagerly. The edges and prop-edges routes carry no
 * other database dependency, and importing one here would force every test that
 * merely loads those routes to provision a database. Loading it lazily keeps
 * that cost where it belongs: only on the paths that actually write.
 */
async function loadDb() {
  const mod = await import("@workspace/db");
  return { db: mod.db, oddsSnapshotsTable: mod.oddsSnapshotsTable };
}

/**
 * Persists odds snapshots. Deliberately fire-and-forget.
 *
 * Recording history is valuable but it is not what the user asked for when they
 * loaded the edges page. If the insert is slow or the database is unhappy, that
 * must not turn into a failed or sluggish request, so nothing here is awaited by
 * the caller and every error is swallowed after logging.
 *
 * Enable with ODDS_HISTORY_ENABLED=true. It ships off: it writes a few thousand
 * rows per scan, and that should be a deliberate choice rather than a surprise
 * on someone's database bill.
 */

export function oddsHistoryEnabled(): boolean {
  return process.env.ODDS_HISTORY_ENABLED?.trim().toLowerCase() === "true";
}

/** Rows per insert. Postgres has a parameter ceiling, so chunk generously. */
const CHUNK_SIZE = 500;

/**
 * Writes one scan's worth of prices. Returns the number of rows written, or 0
 * when disabled or on failure. Safe to call without awaiting.
 */
export async function recordOddsSnapshot(events: OddsEvent[], sport: string): Promise<number> {
  if (!oddsHistoryEnabled()) return 0;

  try {
    const rows = snapshotRowsFromEvents(events, sport);
    if (rows.length === 0) return 0;

    const { db, oddsSnapshotsTable } = await loadDb();
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      await db.insert(oddsSnapshotsTable).values(rows.slice(i, i + CHUNK_SIZE));
    }

    logger.debug({ sport, rows: rows.length }, "odds-history: snapshot recorded");
    return rows.length;
  } catch (err) {
    // Never let history collection break a live request.
    logger.error({ err, sport }, "odds-history: failed to record snapshot");
    return 0;
  }
}

/** Calls recordOddsSnapshot without blocking the caller. */
export function recordOddsSnapshotInBackground(events: OddsEvent[], sport: string): void {
  if (!oddsHistoryEnabled()) return;
  void recordOddsSnapshot(events, sport).catch(() => {
    // Already logged inside; this catch only stops an unhandled rejection.
  });
}

/**
 * Deletes snapshots older than the retention window.
 *
 * Coarse on purpose. The finer per-row policy in `shouldRetainSnapshot` is the
 * right long-term approach, but a plain age cutoff is what keeps the table from
 * growing without bound on day one, and it is much harder to get wrong.
 */
export async function pruneOddsSnapshots(retentionDays = 90): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3_600_000);
  try {
    const { db, oddsSnapshotsTable } = await loadDb();
    const result = await db
      .delete(oddsSnapshotsTable)
      .where(lt(oddsSnapshotsTable.capturedAt, cutoff))
      .returning({ id: oddsSnapshotsTable.id });
    return result.length;
  } catch (err) {
    logger.error({ err, retentionDays }, "odds-history: prune failed");
    return 0;
  }
}

/**
 * How often the sharp-book split actually fires.
 *
 * This exists because SHARP_BOOK_KEYS lists Pinnacle, but the feed does not
 * carry it. If the sharp share is near zero, then "sharp consensus" in the UI
 * is really a soft-book consensus wearing a different label, and no amount of
 * model work fixes a mislabelled input. Better to measure it than assume.
 */
export async function sharpCoverageStats(sinceDays = 7): Promise<{
  totalRows: number;
  sharpRows: number;
  sharpShare: number;
  byBook: { book: string; rows: number; isSharp: boolean }[];
}> {
  const since = new Date(Date.now() - sinceDays * 24 * 3_600_000);
  const { db, oddsSnapshotsTable } = await loadDb();
  const rows = await db
    .select({
      book: oddsSnapshotsTable.book,
      isSharp: oddsSnapshotsTable.isSharp,
      count: sql<number>`count(*)::int`,
    })
    .from(oddsSnapshotsTable)
    .where(sql`${oddsSnapshotsTable.capturedAt} >= ${since}`)
    .groupBy(oddsSnapshotsTable.book, oddsSnapshotsTable.isSharp);

  const byBook = rows
    .map((r) => ({ book: r.book, rows: Number(r.count), isSharp: r.isSharp }))
    .sort((a, b) => b.rows - a.rows);

  const totalRows = byBook.reduce((a, b) => a + b.rows, 0);
  const sharpRows = byBook.filter((b) => b.isSharp).reduce((a, b) => a + b.rows, 0);

  return {
    totalRows,
    sharpRows,
    sharpShare: totalRows > 0 ? sharpRows / totalRows : 0,
    byBook,
  };
}
