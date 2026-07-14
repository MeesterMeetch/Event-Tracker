/**
 * Parsing/validation for free-text numeric inputs on the phone (units and
 * American odds fields in the log/edit bet sheets). One implementation shared
 * by the scanner's LogPropSheet and the bet log's EditBetSheet so the two
 * forms can never disagree on what counts as a valid stake or price.
 */

export interface ParsedInput {
  value: number;
  valid: boolean;
}

/**
 * Units stake input: accepts a comma or dot decimal separator (European
 * keyboards emit ","), must be a finite number of at least 0.01 units.
 */
export function parseUnitsInput(text: string): ParsedInput {
  const value = Number(text.replace(',', '.'));
  return { value, valid: Number.isFinite(value) && value >= 0.01 };
}

/**
 * American odds input: accepts a comma or dot decimal separator, must be a
 * finite non-zero number ("0" is not a price; signs are optional — "150"
 * means +150).
 */
export function parseOddsInput(text: string): ParsedInput {
  const value = Number(text.replace(',', '.'));
  return { value, valid: Number.isFinite(value) && value !== 0 };
}

/**
 * Optional manual P&L override input (EditBetSheet, settled bets only).
 * Empty/whitespace means "no override" — the server keeps pnl in lockstep
 * with odds/units. Any non-empty text must parse to a finite number (zero
 * and negatives are legitimate graded amounts, e.g. voided legs or losses).
 */
export function parsePnlInput(text: string): ParsedInput & { provided: boolean } {
  if (text.trim() === '') {
    return { value: 0, valid: true, provided: false };
  }
  const value = Number(text.replace(',', '.'));
  return { value, valid: Number.isFinite(value), provided: true };
}
