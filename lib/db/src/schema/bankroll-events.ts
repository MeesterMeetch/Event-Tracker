import { pgTable, serial, text, doublePrecision, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Money moving into or out of the bankroll, independent of bet results.
 *
 * The app has always sized in "units" without anywhere to say what a unit is
 * worth, which makes a unit a floating quantity rather than a fraction of
 * capital. Kelly sizing is defined as a fraction of *current* bankroll, so if
 * the bankroll is not tracked, quarter Kelly is really "quarter Kelly of
 * whatever the bankroll was on the day the unit size was chosen": too large
 * after a drawdown and too small after a run.
 *
 * Balance is deliberately not stored. It is derived as the sum of these events
 * plus realized profit and loss from the bets table, so the two can never drift
 * out of sync. See bankroll.ts.
 *
 * Event kinds:
 *   deposit     money added
 *   withdrawal  money removed (store a negative amount)
 *   adjustment  a correction, e.g. reconciling against the real book balance
 */
export const bankrollEventsTable = pgTable("bankroll_events", {
  id: serial("id").primaryKey(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  /** "deposit" | "withdrawal" | "adjustment" */
  kind: text("kind").notNull(),
  /** Signed, in currency. Withdrawals are negative. */
  amount: doublePrecision("amount").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertBankrollEventSchema = createInsertSchema(bankrollEventsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertBankrollEvent = z.infer<typeof insertBankrollEventSchema>;
export type BankrollEvent = typeof bankrollEventsTable.$inferSelect;
