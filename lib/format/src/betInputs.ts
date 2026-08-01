/**
 * Shared validation rules and free-text parsing for bet form inputs (stake
 * units, American odds, manual P&L override). One implementation used by both
 * the web bet forms (LogBetDialog / EditBetDialog, via the isValid* predicates
 * in their zod schemas) and the phone's sheets (LogPropSheet / EditBetSheet,
 * via the parse*Input helpers), so the two surfaces can never disagree on
 * what counts as a valid bet.
 */

export interface ParsedInput {
  value: number;
  valid: boolean;
}

/** Smallest allowed stake, in units. */
export const MIN_UNITS_STAKE = 0.01;

/** A stake is a finite number of at least {@link MIN_UNITS_STAKE} units. */
export function isValidUnitsStake(value: number): boolean {
  return Number.isFinite(value) && value >= MIN_UNITS_STAKE;
}

/**
 * American odds only exist at -100 and below or +100 and above — the open
 * interval (-100, 100) has no meaning on that scale, so a typo like "+50" or
 * "-12" is rejected rather than silently skewing P&L math. (The API enforces
 * the same rule.)
 */
export function isValidAmericanOdds(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) >= 100;
}

/**
 * Units stake input: accepts a comma or dot decimal separator (European
 * keyboards emit ","), must satisfy {@link isValidUnitsStake}.
 */
export function parseUnitsInput(text: string): ParsedInput {
  const value = Number(text.replace(',', '.'));
  return { value, valid: isValidUnitsStake(value) };
}

/**
 * American odds input: accepts a comma or dot decimal separator, signs are
 * optional ("150" means +150), must satisfy {@link isValidAmericanOdds}.
 */
export function parseOddsInput(text: string): ParsedInput {
  const value = Number(text.replace(',', '.'));
  return { value, valid: isValidAmericanOdds(value) };
}

/**
 * Optional manual P&L override input (settled bets only). Empty/whitespace
 * means "no override" — the server keeps pnl in lockstep with odds/units. Any
 * non-empty text must parse to a finite number (zero and negatives are
 * legitimate graded amounts, e.g. voided legs or losses).
 */
export function parsePnlInput(text: string): ParsedInput & { provided: boolean } {
  if (text.trim() === '') {
    return { value: 0, valid: true, provided: false };
  }
  const value = Number(text.replace(',', '.'));
  return { value, valid: Number.isFinite(value), provided: true };
}
