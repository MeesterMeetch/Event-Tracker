/**
 * Mobile-only formatting helpers. The shared date/format helpers
 * (easternDayKey, formatDayLabel, formatOdds, …) live in @workspace/format —
 * one implementation used by both web and mobile so odds, game times, and
 * Eastern-day bucketing can never disagree between the apps.
 */

export {
  easternDayKey,
  formatDayLabel,
  formatGameTime,
  formatMarketLabel,
  formatOdds,
  formatPercent,
  formatPoint,
  formatTimeOnly,
} from '@workspace/format';

/** Signed units string for wager P&L, e.g. "+1.36u" / "-1.00u" / "0.00u". */
export function formatPnlUnits(pnl: number): string {
  const rounded = Math.round(pnl * 100) / 100;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(2)}u`;
}

/**
 * Fallback display title for an Odds API sport key when the live sports list
 * doesn't cover it (out-of-season leagues drop off the free list), e.g.
 * "baseball_mlb" → "MLB", "basketball_wnba" → "WNBA". Prefer the API-provided
 * title when the key is present in the sports list.
 */
export function formatSportKey(key: string): string {
  const parts = key.split('_').filter(Boolean);
  if (parts.length > 1) return parts.slice(1).join(' ').toUpperCase();
  return key.toUpperCase();
}

/** A probability in [0,1] as a one-decimal percentage, e.g. "62.5%". */
export function formatProb(p: number | null | undefined): string {
  if (p == null) return '—';
  return `${(p * 100).toFixed(1)}%`;
}

/** A rate in [0,1] as a whole percentage, e.g. "58%". */
export function formatRate(rate: number | null | undefined): string {
  if (rate == null) return '—';
  return `${(rate * 100).toFixed(0)}%`;
}
