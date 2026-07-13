/** Converts American odds to decimal odds (e.g. +150 -> 2.5, -120 -> 1.8333). */
export function americanToDecimal(american: number): number {
  return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
}

/** Converts American odds to their raw (vig-included) implied probability. */
export function americanToImpliedProb(american: number): number {
  return american > 0 ? 100 / (american + 100) : Math.abs(american) / (Math.abs(american) + 100);
}

/** Converts decimal odds back to American odds (e.g. 2.5 -> +150, 1.8333 -> -120). */
export function decimalToAmerican(decimal: number): number {
  if (decimal <= 1) return 0;
  return decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1));
}

/** Converts a fair (no-vig) probability back to American odds. */
export function probToAmerican(prob: number): number {
  const clamped = Math.min(Math.max(prob, 1e-6), 1 - 1e-6);
  if (clamped >= 0.5) return Math.round((-100 * clamped) / (1 - clamped));
  return Math.round((100 * (1 - clamped)) / clamped);
}

/**
 * Closing-line value: how much better (or worse) the bet's price was versus
 * the closing price, in percent of decimal odds. Positive means the bettor
 * beat the closing line.
 */
export function computeClvPercent(betAmericanOdds: number, closingAmericanOdds: number): number {
  const betDecimal = americanToDecimal(betAmericanOdds);
  const closeDecimal = americanToDecimal(closingAmericanOdds);
  return Math.round((betDecimal / closeDecimal - 1) * 10000) / 100;
}

/**
 * Require at least this many books to quote a line before recording a close.
 * A one-book feed is too thin to trust — a single stale or mispriced quote would
 * become the "consensus" — so both closing-line jobs abstain below this.
 */
export const MIN_CLOSING_BOOKS = 2;

/**
 * Consensus closing price from a set of per-book American quotes for a single
 * line/side. American odds aren't linear, so averaging the raw numbers is wrong:
 * we convert to decimal, drop the single best and worst quote once at least four
 * books quote the line (a trimmed mean, so one stale/mispriced sportsbook can't
 * drag the close off), mean the rest, and convert back to American. Returns null
 * when fewer than `MIN_CLOSING_BOOKS` quotes are supplied.
 *
 * This is the shared robustness rule behind both closing-line jobs (game lines
 * and pitcher strikeouts) — keep it here so a tweak to the trim size or minimum
 * threshold applies to both at once instead of letting them drift apart.
 */
export function trimmedMeanClosingAmerican(americanPrices: number[]): number | null {
  if (americanPrices.length < MIN_CLOSING_BOOKS) return null;
  const decimals = americanPrices.map(americanToDecimal).sort((a, b) => a - b);
  const trimmed = decimals.length >= 4 ? decimals.slice(1, -1) : decimals;
  const meanDecimal = trimmed.reduce((sum, d) => sum + d, 0) / trimmed.length;
  return decimalToAmerican(meanDecimal);
}

/** Normalizes a totals selection like "Over 8.5" down to "Over" or "Under". */
export function baseSelection(market: string, selection: string): string {
  if (market === "totals") {
    if (selection.startsWith("Over")) return "Over";
    if (selection.startsWith("Under")) return "Under";
  }
  return selection;
}
