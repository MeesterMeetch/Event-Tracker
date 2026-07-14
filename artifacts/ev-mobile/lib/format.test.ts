import { describe, expect, it } from 'vitest';

import { formatProb, formatRate } from './format';

/**
 * Tests for mobile-only helpers. The shared date/format helpers
 * (easternDayKey, formatDayLabel, formatOdds, …) live in @workspace/format
 * with their own boundary suite (lib/format/src/index.test.ts) — one
 * implementation, one suite, no copies to drift.
 */

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
