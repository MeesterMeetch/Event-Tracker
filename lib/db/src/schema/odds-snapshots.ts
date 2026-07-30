import { pgTable, serial, text, doublePrecision, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * One quoted price, from one book, for one outcome, at one moment in time.
 *
 * Every scan already pulls a full odds payload and then throws almost all of it
 * away, keeping only the closing line for CLV. That discards the single most
 * valuable dataset this app could own. Persisting each snapshot buys three
 * things that cannot be reconstructed later:
 *
 *   Line movement. Opening price versus current versus close, per book.
 *   Book leadership. Which books move first and which follow, which is the
 *     closest thing to a sharp signal available without a true sharp book in
 *     the feed.
 *   A backtest surface. Right now the question "would this rule have made
 *     money last month" is unanswerable, because last month does not exist.
 *
 * This compounds with time, which is the argument for switching it on before
 * it is perfect rather than after.
 *
 * A note on volume. A full MLB slate across three markets and roughly twenty
 * books is on the order of a couple thousand rows per scan. At a five minute
 * cadence that is meaningful but not alarming for Postgres, and the table is
 * append-only with no updates. Still, prune it: `pruneOddsSnapshots` in
 * odds-recorder.ts keeps a bounded window, and `shouldRetainSnapshot` in
 * odds-history.ts describes the finer policy worth moving to later.
 */
export const oddsSnapshotsTable = pgTable(
  "odds_snapshots",
  {
    id: serial("id").primaryKey(),
    /** When this scan ran. The whole point of the table. */
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    sport: text("sport").notNull(),
    gameId: text("game_id").notNull(),
    commenceTime: timestamp("commence_time", { withTimezone: true }).notNull(),
    homeTeam: text("home_team").notNull(),
    awayTeam: text("away_team").notNull(),
    /** "h2h" | "spreads" | "totals" | a player prop market key. */
    market: text("market").notNull(),
    selection: text("selection").notNull(),
    /** Line for spreads/totals/props; null for moneylines. */
    point: doublePrecision("point"),
    /** Player name for prop markets; null for team markets. */
    player: text("player"),
    /** Odds API bookmaker key, e.g. "draftkings". Stable across scans. */
    book: text("book").notNull(),
    /** Human-readable book name at capture time. */
    bookTitle: text("book_title").notNull(),
    americanOdds: doublePrecision("american_odds").notNull(),
    /**
     * Whether this book counted as sharp at capture time. Stored rather than
     * derived so a later change to SHARP_BOOK_KEYS does not silently rewrite
     * history, and so the "how often does the sharp split actually fire"
     * question is answerable from the data itself.
     */
    isSharp: boolean("is_sharp").notNull().default(false),
  },
  (table) => [
    // Primary read pattern: the price history of one outcome over time.
    index("odds_snapshots_outcome_idx").on(
      table.sport,
      table.gameId,
      table.market,
      table.selection,
      table.capturedAt,
    ),
    // Pruning and time-window queries.
    index("odds_snapshots_captured_idx").on(table.capturedAt),
    // Per-book leadership analysis.
    index("odds_snapshots_book_idx").on(table.book, table.capturedAt),
  ],
);

export const insertOddsSnapshotSchema = createInsertSchema(oddsSnapshotsTable).omit({
  id: true,
  capturedAt: true,
});
export type InsertOddsSnapshot = z.infer<typeof insertOddsSnapshotSchema>;
export type OddsSnapshot = typeof oddsSnapshotsTable.$inferSelect;
