import { describe, expect, it } from 'vitest';

import { formatPnlUnits, formatProb, formatRate } from './format';

/**
 * Tests for mobile-only helpers. The shared date/format helpers
 * (easternDayKey, formatDayLabel, formatOdds, …) live in @workspace/format
 * with their own boundary suite (lib/format/src/index.test.ts) — one
 * implementation, one suite, no copies to drift.
 */

describe('formatPnlUnits', () => {
  it('signs wins with a leading plus', () => {
    expect(formatPnlUnits(1.36)).toBe('+1.36u');
  });
  it('keeps the bare minus for losses', () => {
    expect(formatPnlUnits(-1)).toBe('-1.00u');
  });
  it('renders an unsigned zero for a push', () => {
    expect(formatPnlUnits(0)).toBe('0.00u');
  });
  it('rounds to cents before signing, so a tiny negative cannot render "-0.00u"', () => {
    expect(formatPnlUnits(-0.001)).toBe('0.00u');
    expect(formatPnlUnits(0.004)).toBe('0.00u');
    expect(formatPnlUnits(1.006)).toBe('+1.01u');
  });
});

describe('formatProb', () => {
  it('renders a [0,1] probability as a one-decimal percentage', () => {
    expect(formatProb(0.625)).toBe('62.5%');
  });
  it('renders a dash for null/undefined', () => {
    expect(formatProb(null)).toBe('—');
    expect(formatProb(undefined)).toBe('—');
  });
});

describe('formatRate', () => {
  it('renders a [0,1] rate as a whole percentage', () => {
    expect(formatRate(0.582)).toBe('58%');
  });
  it('renders a dash for null/undefined', () => {
    expect(formatRate(null)).toBe('—');
    expect(formatRate(undefined)).toBe('—');
  });
});
