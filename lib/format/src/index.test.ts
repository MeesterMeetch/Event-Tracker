import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  easternDayKey,
  formatDayLabel,
  formatGameTime,
  formatMarketLabel,
  formatOdds,
  formatPercent,
  formatPoint,
  formatTimeOnly,
} from './index';

/**
 * Boundary tests for the shared date/format helpers. Both the web and mobile
 * apps import these helpers from this package, so this single suite guards
 * the Eastern-day boundaries for both — there is no second copy to drift.
 */

describe('easternDayKey', () => {
  it('buckets an evening ET first pitch on its own calendar day', () => {
    // 7:05 PM EDT on Jul 14 = 23:05 UTC
    expect(easternDayKey('2026-07-14T23:05:00.000Z')).toBe('2026-07-14');
  });

  it('keeps a late-night game (after midnight UTC) on the prior Eastern day', () => {
    // 11:35 PM EDT Jul 14 = 03:35 UTC Jul 15 — still baseball date Jul 14
    expect(easternDayKey('2026-07-15T03:35:00.000Z')).toBe('2026-07-14');
  });

  it('rolls to the next day exactly at Eastern midnight (EDT, UTC-4)', () => {
    expect(easternDayKey('2026-07-15T03:59:59.000Z')).toBe('2026-07-14');
    expect(easternDayKey('2026-07-15T04:00:00.000Z')).toBe('2026-07-15');
  });

  it('uses the EST offset (UTC-5) in winter', () => {
    expect(easternDayKey('2026-01-15T04:59:59.000Z')).toBe('2026-01-14');
    expect(easternDayKey('2026-01-15T05:00:00.000Z')).toBe('2026-01-15');
  });

  it('accepts Date objects', () => {
    expect(easternDayKey(new Date('2026-07-15T03:35:00.000Z'))).toBe('2026-07-14');
  });

  it('returns empty string for invalid input', () => {
    expect(easternDayKey('not-a-date')).toBe('');
  });
});

describe('formatDayLabel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('labels the current Eastern day as Today and the next as Tomorrow', () => {
    // 2 PM EDT on Jul 14
    vi.setSystemTime(new Date('2026-07-14T18:00:00.000Z'));
    expect(formatDayLabel('2026-07-14')).toBe('Today');
    expect(formatDayLabel('2026-07-15')).toBe('Tomorrow');
  });

  it('treats late night (after midnight UTC but before midnight ET) as the prior day', () => {
    // 11:30 PM EDT Jul 14 = 03:30 UTC Jul 15 — "today" is still Jul 14
    vi.setSystemTime(new Date('2026-07-15T03:30:00.000Z'));
    expect(formatDayLabel('2026-07-14')).toBe('Today');
    expect(formatDayLabel('2026-07-15')).toBe('Tomorrow');
  });

  it('flips Today/Tomorrow once Eastern midnight passes', () => {
    // 12:30 AM EDT Jul 15 = 04:30 UTC
    vi.setSystemTime(new Date('2026-07-15T04:30:00.000Z'));
    expect(formatDayLabel('2026-07-14')).not.toBe('Today');
    expect(formatDayLabel('2026-07-15')).toBe('Today');
    expect(formatDayLabel('2026-07-16')).toBe('Tomorrow');
  });

  it('handles Tomorrow across a month boundary', () => {
    // Noon EDT on Jul 31
    vi.setSystemTime(new Date('2026-07-31T16:00:00.000Z'));
    expect(formatDayLabel('2026-07-31')).toBe('Today');
    expect(formatDayLabel('2026-08-01')).toBe('Tomorrow');
  });

  it('formats other days as a short weekday + date, never Today/Tomorrow', () => {
    vi.setSystemTime(new Date('2026-07-14T18:00:00.000Z'));
    // Jul 16, 2026 is a Thursday. Ordering/punctuation vary by runtime locale
    // (en-US "Thu, Jul 16" vs en-GB "Thu 16 Jul"), so assert the contract —
    // weekday + day-of-month present, no Today/Tomorrow — not US ordering.
    const label = formatDayLabel('2026-07-16');
    expect(label).toMatch(/Thu/);
    expect(label).toMatch(/16/);
    expect(label).not.toMatch(/Today|Tomorrow/);
  });

  it('returns empty string for an empty key', () => {
    expect(formatDayLabel('')).toBe('');
  });
});

describe('formatOdds', () => {
  it('prefixes positive odds with +', () => {
    expect(formatOdds(150)).toBe('+150');
  });
  it('leaves negative odds as-is', () => {
    expect(formatOdds(-110)).toBe('-110');
  });
  it('renders zero without a sign', () => {
    expect(formatOdds(0)).toBe('0');
  });
  it('renders a dash for null/undefined', () => {
    expect(formatOdds(null)).toBe('—');
    expect(formatOdds(undefined)).toBe('—');
  });
});

describe('formatPercent', () => {
  it('signs and fixes positive percentages to two decimals', () => {
    expect(formatPercent(3.2)).toBe('+3.20%');
  });
  it('keeps the negative sign', () => {
    expect(formatPercent(-1.1)).toBe('-1.10%');
  });
  it('renders zero unsigned', () => {
    expect(formatPercent(0)).toBe('0.00%');
  });
  it('renders a dash for null/undefined', () => {
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(undefined)).toBe('—');
  });
});

describe('formatPoint', () => {
  it('signs positive spread points', () => {
    expect(formatPoint(1.5, 'spreads')).toBe('+1.5');
  });
  it('keeps negative spread points', () => {
    expect(formatPoint(-1.5, 'spreads')).toBe('-1.5');
  });
  it('does not sign totals points', () => {
    expect(formatPoint(8.5, 'totals')).toBe('8.5');
  });
  it('renders empty string for null/undefined', () => {
    expect(formatPoint(null, 'spreads')).toBe('');
    expect(formatPoint(undefined, 'totals')).toBe('');
  });
});

describe('formatMarketLabel', () => {
  it('uses known labels for core markets', () => {
    expect(formatMarketLabel('h2h')).toBe('H2H');
    expect(formatMarketLabel('spreads')).toBe('Spreads');
    expect(formatMarketLabel('totals')).toBe('Totals');
  });
  it('title-cases unknown snake_case markets', () => {
    expect(formatMarketLabel('batter_total_bases')).toBe('Batter Total Bases');
  });
  it('drops the redundant player_ prefix', () => {
    expect(formatMarketLabel('player_pass_yds')).toBe('Pass Yds');
  });
});

describe('formatTimeOnly / formatGameTime', () => {
  it('returns empty string for invalid input', () => {
    expect(formatTimeOnly('not-a-date')).toBe('');
    expect(formatGameTime('not-a-date')).toBe('');
  });
  it('accepts Date objects', () => {
    expect(formatTimeOnly(new Date('2026-07-11T23:05:00.000Z'))).toMatch(/\d{1,2}:\d{2}/);
  });
  it('joins date and time with a middle dot', () => {
    // Viewer-locale and -timezone dependent, so assert the structure only:
    // "<date part> · <clock-like time part>".
    const parts = formatGameTime('2026-07-11T23:05:00.000Z').split(' · ');
    expect(parts).toHaveLength(2);
    expect(parts[0]).not.toBe('');
    expect(parts[1]).toMatch(/\d{1,2}:\d{2}/);
  });
});
