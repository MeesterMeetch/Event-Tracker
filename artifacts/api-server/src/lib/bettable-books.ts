/**
 * Which bookmakers you can actually place a bet at.
 *
 * This exists because widening the odds fetch to the EU region, which is the
 * only way to reach Pinnacle, also pulls in roughly twenty European books:
 * Winamax, Betclic, Unibet NL, PMU, Tipico, LeoVegas, Nordicbet and friends.
 * None of them will open an account for someone sitting in the United States.
 *
 * That creates a subtle and expensive failure. The scanner computes EV against
 * the best price it can find anywhere, so without a filter it will report a
 * juicy edge at Winamax Germany, sort it to the top of Live Edges, and bury the
 * genuine DraftKings edge underneath it. The number is arithmetically correct
 * and completely unactionable.
 *
 * The fix is to recognise that books do two different jobs here:
 *
 *   Every book, including the unreachable ones, should feed the de-vigged fair
 *     price. A wider consensus is a better consensus, and Pinnacle's inclusion
 *     is the entire reason for adding the region in the first place.
 *   Only books you can actually bet at should be eligible to become the "best
 *     price" that EV is measured against, because an edge you cannot take is
 *     not an edge.
 *
 * Configure with BETTABLE_BOOKS as a comma-separated list of Odds API bookmaker
 * keys. Set it to "all" to disable filtering entirely, which restores the old
 * behaviour if you ever want to see the whole market.
 */

/**
 * Default allowlist. Deliberately narrow: it is better to miss an edge at a
 * book you forgot you had than to chase one at a book you can never use.
 */
const DEFAULT_BETTABLE = ["draftkings", "fanduel", "betmgm"];

/** Sentinel disabling the filter. */
const ALL = "all";

let cached: { raw: string | undefined; value: ReadonlySet<string> | null } | null = null;

function parse(raw: string | undefined): ReadonlySet<string> | null {
  const trimmed = raw?.trim().toLowerCase();
  if (!trimmed) return new Set(DEFAULT_BETTABLE);
  // null means "no filtering", which is distinct from an empty set (which would
  // filter everything out and silently produce zero edges).
  if (trimmed === ALL) return null;
  const keys = trimmed
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  return keys.length > 0 ? new Set(keys) : new Set(DEFAULT_BETTABLE);
}

/**
 * The allowlist, or null when filtering is disabled. Recomputed when the
 * environment variable changes so tests can vary it without stale caching.
 */
export function bettableBooks(): ReadonlySet<string> | null {
  const raw = process.env.BETTABLE_BOOKS;
  if (cached === null || cached.raw !== raw) {
    cached = { raw, value: parse(raw) };
  }
  return cached.value;
}

/** Whether a price at this book is one you could actually take. */
export function isBettableBook(bookmakerKey: string): boolean {
  const allow = bettableBooks();
  if (allow === null) return true;
  return allow.has(bookmakerKey);
}

/** Human-readable description of the current setting, for logs and reports. */
export function describeBettableBooks(): string {
  const allow = bettableBooks();
  if (allow === null) return "all books (no filtering)";
  return Array.from(allow).sort().join(", ");
}
