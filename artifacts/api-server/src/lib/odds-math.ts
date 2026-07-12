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

/** Normalizes a totals selection like "Over 8.5" down to "Over" or "Under". */
export function baseSelection(market: string, selection: string): string {
  if (market === "totals") {
    if (selection.startsWith("Over")) return "Over";
    if (selection.startsWith("Under")) return "Under";
  }
  return selection;
}
