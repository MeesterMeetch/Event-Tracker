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

/**
 * Bookmakers treated as "sharp" (low-vig market makers whose lines move on
 * professional money) when estimating the sharp-vs-public split for an edge.
 * LowVig and BetOnline are the sharpest books The Odds API returns for the
 * "us" region; Pinnacle is listed so it is picked up automatically if the
 * odds fetch ever includes non-US regions. Every other book is "public".
 */
export const SHARP_BOOK_KEYS: ReadonlySet<string> = new Set(["pinnacle", "lowvig", "betonlineag"]);

/** Whether an Odds API bookmaker key belongs to the sharp-book set. */
export function isSharpBook(bookmakerKey: string): boolean {
  return SHARP_BOOK_KEYS.has(bookmakerKey);
}

// ---------------------------------------------------------------------------
// Devigging
//
// Every "fair price" in the app comes out of here, so the method chosen below
// sets every EV number the scanners report. Two methods are implemented:
//
//   multiplicative — divide each raw implied probability by the overround.
//     Simple and fast, but it removes vig in proportion to each side's own
//     probability, which leaves the favourite-longshot bias intact: books
//     load more vig onto the longshot than this assumes, so the longshot's
//     "fair" probability comes out too high and the app sees phantom +EV on
//     underdogs.
//
//   power — solve for the exponent k where sum(p_i^k) = 1. Because p < 1,
//     raising to k > 1 shrinks the large probability proportionally less than
//     the small one, which better describes how books actually distribute
//     vig across a market. This is the default.
//
// ODDS_DEVIG_METHOD=multiplicative restores the old behaviour without a code
// change if the new numbers ever look wrong.
// ---------------------------------------------------------------------------
export type DevigMethod = "multiplicative" | "power";

function configuredDevigMethod(): DevigMethod {
  return process.env.ODDS_DEVIG_METHOD === "multiplicative" ? "multiplicative" : "power";
}

/** Proportional devig: each side's share of the overround. */
export function devigMultiplicative(rawProbs: number[]): number[] {
  const overround = rawProbs.reduce((sum, p) => sum + p, 0);
  if (overround <= 0) return rawProbs.map(() => 0);
  return rawProbs.map((p) => p / overround);
}

/**
 * Power devig: find k such that the raw probabilities raised to k sum to 1.
 * sum(p^k) is strictly decreasing in k for 0 < p < 1, so a bisection search
 * converges quickly and without derivatives.
 *
 * Falls back to the proportional method for inputs that have no valid k:
 * a degenerate quote (p <= 0 or p >= 1), or a book that is already balanced
 * or arbitrageable (overround <= 1).
 */
export function devigPower(rawProbs: number[]): number[] {
  const overround = rawProbs.reduce((sum, p) => sum + p, 0);
  if (overround <= 0) return rawProbs.map(() => 0);
  if (overround <= 1) return devigMultiplicative(rawProbs);
  if (rawProbs.some((p) => p <= 0 || p >= 1)) return devigMultiplicative(rawProbs);

  const total = (k: number) => rawProbs.reduce((sum, p) => sum + Math.pow(p, k), 0);

  // Grow the upper bound until the book is over-shrunk, then bisect.
  let lo = 1;
  let hi = 2;
  for (let i = 0; i < 64 && total(hi) > 1; i++) hi *= 2;
  if (total(hi) > 1) return devigMultiplicative(rawProbs);

  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (total(mid) > 1) lo = mid;
    else hi = mid;
  }

  const k = (lo + hi) / 2;
  const out = rawProbs.map((p) => Math.pow(p, k));
  const sum = out.reduce((s, p) => s + p, 0);
  // Normalize away any residual from the search tolerance.
  return sum > 0 ? out.map((p) => p / sum) : devigMultiplicative(rawProbs);
}

/**
 * Remove the vig from one book's quote for a single market, returning fair
 * probabilities in the same order as the input. Uses the configured method.
 */
export function devig(rawProbs: number[], method: DevigMethod = configuredDevigMethod()): number[] {
  return method === "power" ? devigPower(rawProbs) : devigMultiplicative(rawProbs);
}

// ---------------------------------------------------------------------------
// Consensus
//
// A plain average across books treats a recreational book's padded line as
// equal evidence to Pinnacle's. Sharp books are the closest thing to a true
// price, so they carry more weight in the consensus. SHARP_BOOK_WEIGHT=1
// restores the old equal-weight average.
// ---------------------------------------------------------------------------
export const DEFAULT_SHARP_BOOK_WEIGHT = 3;

export function sharpBookWeight(): number {
  const raw = Number(process.env.SHARP_BOOK_WEIGHT);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SHARP_BOOK_WEIGHT;
}

export interface ProbSample {
  prob: number;
  /** Whether the quote came from a sharp book. */
  sharp: boolean;
}

/**
 * Weighted mean of per-book fair probabilities, sharp books counting more.
 * Returns null when there are no samples.
 */
export function consensusProb(samples: ProbSample[]): number | null {
  if (samples.length === 0) return null;
  const weight = sharpBookWeight();
  let weighted = 0;
  let totalWeight = 0;
  for (const sample of samples) {
    const w = sample.sharp ? weight : 1;
    weighted += sample.prob * w;
    totalWeight += w;
  }
  return totalWeight > 0 ? weighted / totalWeight : null;
}
