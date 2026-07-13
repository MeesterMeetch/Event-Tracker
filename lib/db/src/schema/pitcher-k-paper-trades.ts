import { pgTable, serial, text, doublePrecision, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * A paper-traded pitcher-strikeout flag from the projection model. These are
 * deliberately kept separate from the real `bets` table and the auto-grading /
 * game-line CLV pipeline: they are model validation records, not wagers.
 *
 * A row starts as "open" when the user logs a model flag (capturing the model
 * probability and the price that was available at that moment). A background
 * job later fills `closingOdds`/`closingProb`/`clvPercent`/`beatClose` near
 * first pitch to measure closing-line value, flipping `status` to "closed";
 * flags whose closing line can't be captured in the window become "expired".
 */
export const pitcherKPaperTradesTable = pgTable("pitcher_k_paper_trades", {
  id: serial("id").primaryKey(),
  sport: text("sport").notNull(),
  gameId: text("game_id").notNull(),
  commenceTime: timestamp("commence_time", { withTimezone: true }).notNull(),
  homeTeam: text("home_team").notNull(),
  awayTeam: text("away_team").notNull(),
  pitcher: text("pitcher").notNull(),
  pitcherId: integer("pitcher_id"),
  team: text("team").notNull(),
  opponent: text("opponent").notNull(),
  selection: text("selection").notNull(), // "Over" | "Under"
  point: doublePrecision("point").notNull(),
  book: text("book").notNull(),
  americanOdds: doublePrecision("american_odds").notNull(),
  modelProb: doublePrecision("model_prob").notNull(),
  marketProb: doublePrecision("market_prob"),
  edgePercent: doublePrecision("edge_percent"),
  // The model's actual flag decision at scan time (scanner's `isFlagged`), so
  // the flagged-vs-unflagged comparison reflects what the model really picked
  // rather than a client-side re-derivation. Nullable: rows logged before this
  // column existed have no recorded decision and fall back to the heuristic.
  isFlagged: boolean("is_flagged"),
  expectedStrikeouts: doublePrecision("expected_strikeouts").notNull(),
  projectedBattersFaced: doublePrecision("projected_batters_faced").notNull(),
  recommendedUnits: doublePrecision("recommended_units").notNull(),
  kellyMultiplier: doublePrecision("kelly_multiplier").notNull(),
  closingOdds: doublePrecision("closing_odds"),
  closingProb: doublePrecision("closing_prob"),
  clvPercent: doublePrecision("clv_percent"),
  beatClose: boolean("beat_close"),
  status: text("status").notNull().default("open"), // "open" | "closed" | "expired"
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPitcherKPaperTradeSchema = createInsertSchema(pitcherKPaperTradesTable).omit({
  id: true,
  createdAt: true,
  closingOdds: true,
  closingProb: true,
  clvPercent: true,
  beatClose: true,
  status: true,
});
export type InsertPitcherKPaperTrade = z.infer<typeof insertPitcherKPaperTradeSchema>;
export type PitcherKPaperTrade = typeof pitcherKPaperTradesTable.$inferSelect;
