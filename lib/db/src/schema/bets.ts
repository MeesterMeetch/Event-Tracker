import { pgTable, serial, text, doublePrecision, timestamp } from "drizzle-orm/pg-core";
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertBetSchema = createInsertSchema(betsTable).omit({ id: true, createdAt: true });
export type InsertBet = z.infer<typeof insertBetSchema>;
export type Bet = typeof betsTable.$inferSelect;
