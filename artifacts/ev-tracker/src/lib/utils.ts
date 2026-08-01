import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

// Shared date/format helpers live in @workspace/format — one implementation
// used by both web and mobile so Eastern-day bucketing can never disagree.
export {
  easternDayKey,
  formatDayLabel,
  formatGameTime,
  formatMarketLabel,
  formatOdds,
  formatPercent,
  formatPoint,
  formatTimeOnly,
} from "@workspace/format";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount);
}

// ---------------------------------------------------------------------------
// Bankroll / stake sizing
//
// The database, the Kelly model, and all P&L + ROI math stay denominated in
// UNITS — that's what makes the numbers portable if the bankroll changes.
// Dollars are purely a display layer: one unit is worth UNIT_SIZE dollars.
//
// To re-scale the whole app (say the bankroll grows to $500 and a unit becomes
// $5), change these two constants. Nothing else needs to move, and historical
// bets keep their original unit sizing.
// ---------------------------------------------------------------------------
export const BANKROLL = 100;
export const UNIT_SIZE = 1; // 1 unit = $1 = 1% of a $100 bankroll

/** Render a unit-denominated stake as dollars, e.g. 0.5 -> "$0.50". */
export function formatStake(units: number) {
  return formatCurrency(units * UNIT_SIZE);
}

/** Convert a dollar amount typed by the bettor back into stored units. */
export function dollarsToUnits(dollars: number) {
  return dollars / UNIT_SIZE;
}

/** Convert stored units into dollars (unformatted, for input fields). */
export function unitsToDollars(units: number) {
  return units * UNIT_SIZE;
}
