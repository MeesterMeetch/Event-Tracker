import { pgTable, serial, text, doublePrecision, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * A logged sports bet. `status` starts as "pending" and is later set either
 * by the background auto-grading job (once the game finishes and the Odds
 * API scores endpoint confirms a result) or manually via PATCH /bets/{id}.
 * `closingOdds`/`clvPercent` are filled in by the background CLV-capture job
 * shortly before the game locks.
 */
export const betsTable = pgTable("bets", {
  id: serial("id").primaryKey(),
  sport: text("sport").notNull(),
  gameId: text("game_id").notNull(),
  commenceTime: timestamp("commence_time", { withTimezone: true }).notNull(),
  homeTeam: text("home_team").notNull(),
  awayTeam: text("away_team").notNull(),
  market: text("market").notNull(), // "h2h" | "spreads" | "totals"
  selection: text("selection").notNull(),
  point: doublePrecision("point"),
  americanOdds: doublePrecision("american_odds").notNull(),
  units: doublePrecision("units").notNull(),
  fairOdds: doublePrecision("fair_odds"),
  evPercent: doublePrecision("ev_percent"),
  book: text("book"),
  closingOdds: doublePrecision("closing_odds"),
  clvPercent: doublePrecision("clv_percent"),
  status: text("status").notNull().default("pending"), // "pending" | "won" | "lost" | "push"
  pnl: doublePrecision("pnl"),
  notes: text("notes"),
  /**
   * The pitcher-strikeout paper trade this bet was promoted from, when it was.
   *
   * Player props cannot be graded from the scores endpoint, which only returns
   * final team scores, so a prop bet used to sit pending until settled by hand.
   * But the paper trade it came from is already settled every thirty minutes by
   * settleKOutcomes against the real boxscore, including pushes and scratched
   * starters. This link lets the bet inherit that answer rather than duplicating
   * the lookup.
   *
   * Null for game-line bets, which the scores grader handles, and for any prop
   * logged by hand rather than promoted.
   */
  paperTradeId: integer("paper_trade_id"),
  // Soft-delete marker backing the client "Undo" affordance: deleting a bet
  // stamps this instead of dropping the row, so an immediate undo can restore
  // the exact record — logged odds, units, and any captured closing-line/CLV
  // data — rather than approximating it with a re-create. Rows with a
  // non-null deletedAt are invisible to list/dashboard/grading/CLV and are
  // purged after a grace period.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertBetSchema = createInsertSchema(betsTable).omit({ id: true, createdAt: true, deletedAt: true });
export type InsertBet = z.infer<typeof insertBetSchema>;
export type Bet = typeof betsTable.$inferSelect;
