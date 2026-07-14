import { describe, expect, it } from 'vitest';

import { parseOddsInput, parsePnlInput, parseUnitsInput } from './inputs';

/**
 * Safety net over the stake/odds input parsing shared by the scanner's
 * LogPropSheet and the bet log's EditBetSheet. These rules guard the ledger:
 * a bogus stake or a zero price would flow straight into P&L math on the
 * server, so the forms must refuse to submit them.
 */

describe('parseUnitsInput', () => {
  it('accepts plain decimal stakes', () => {
    expect(parseUnitsInput('1')).toEqual({ value: 1, valid: true });
    expect(parseUnitsInput('2.5')).toEqual({ value: 2.5, valid: true });
  });

  it('accepts a comma decimal separator (European keyboards)', () => {
    expect(parseUnitsInput('1,36')).toEqual({ value: 1.36, valid: true });
  });

  it('accepts the minimum stake of 0.01 units exactly', () => {
    expect(parseUnitsInput('0.01').valid).toBe(true);
  });

  it('rejects stakes below 0.01 units, zero, and negatives', () => {
    expect(parseUnitsInput('0.009').valid).toBe(false);
    expect(parseUnitsInput('0').valid).toBe(false);
    expect(parseUnitsInput('-1').valid).toBe(false);
  });

  it('rejects non-numeric and empty input', () => {
    expect(parseUnitsInput('abc').valid).toBe(false);
    expect(parseUnitsInput('1.2.3').valid).toBe(false);
    // Number('') is 0 — must not sneak through as a valid stake.
    expect(parseUnitsInput('').valid).toBe(false);
    expect(parseUnitsInput('   ').valid).toBe(false);
  });
});

describe('parseOddsInput', () => {
  it('accepts positive and negative American odds, sign optional', () => {
    expect(parseOddsInput('-110')).toEqual({ value: -110, valid: true });
    expect(parseOddsInput('+150')).toEqual({ value: 150, valid: true });
    expect(parseOddsInput('150')).toEqual({ value: 150, valid: true });
  });

  it('rejects zero — not a price (and Number("") is 0 too)', () => {
    expect(parseOddsInput('0').valid).toBe(false);
    expect(parseOddsInput('').valid).toBe(false);
  });

  it('rejects impossible American prices inside (-100, 100), like a +50 typo', () => {
    expect(parseOddsInput('50').valid).toBe(false);
    expect(parseOddsInput('+50').valid).toBe(false);
    expect(parseOddsInput('-12').valid).toBe(false);
    expect(parseOddsInput('99.5').valid).toBe(false);
  });

  it('accepts the boundary prices -100 and +100', () => {
    expect(parseOddsInput('-100')).toEqual({ value: -100, valid: true });
    expect(parseOddsInput('+100')).toEqual({ value: 100, valid: true });
  });

  it('rejects non-numeric input', () => {
    expect(parseOddsInput('even').valid).toBe(false);
    expect(parseOddsInput('--110').valid).toBe(false);
  });
});

describe('parsePnlInput', () => {
  it('treats empty/whitespace as "no override" and stays valid', () => {
    expect(parsePnlInput('')).toEqual({ value: 0, valid: true, provided: false });
    expect(parsePnlInput('   ')).toEqual({ value: 0, valid: true, provided: false });
  });

  it('accepts positive, negative, and zero corrections', () => {
    expect(parsePnlInput('1.82')).toEqual({ value: 1.82, valid: true, provided: true });
    expect(parsePnlInput('-0.5')).toEqual({ value: -0.5, valid: true, provided: true });
    // Zero is a legitimate graded amount (e.g. a fully voided ticket).
    expect(parsePnlInput('0')).toEqual({ value: 0, valid: true, provided: true });
  });

  it('accepts a comma decimal separator (European keyboards)', () => {
    expect(parsePnlInput('-0,5')).toEqual({ value: -0.5, valid: true, provided: true });
  });

  it('rejects non-numeric input but still marks it provided', () => {
    expect(parsePnlInput('abc').valid).toBe(false);
    expect(parsePnlInput('abc').provided).toBe(true);
    expect(parsePnlInput('1.2.3').valid).toBe(false);
  });
});
