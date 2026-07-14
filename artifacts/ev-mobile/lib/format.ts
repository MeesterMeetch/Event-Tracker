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
