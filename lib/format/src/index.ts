/**
 * Shared date/formatting helpers for the EV Tracker web and mobile apps.
 *
 * This is the single source of truth for Eastern-day bucketing, day labels,
 * and odds/percent/point/market formatting. Both apps import from here so a
 * late-night game can never bucket under different dates on web vs phone.
 *
 * Signatures are the widest either app needs: time helpers accept ISO strings
 * or Date objects, and odds/percent accept null/undefined (rendered as "—").
 */

export * from './betInputs';
export * from './selection';

/** American odds with an explicit + for positives; "—" for null/undefined. */
export function formatOdds(odds: number | null | undefined): string {
  if (odds == null) return '—';
  return odds > 0 ? `+${odds}` : `${odds}`;
}

/** Signed percentage, e.g. "+3.20%" / "-1.10%"; "—" for null/undefined. */
export function formatPercent(percent: number | null | undefined): string {
  if (percent == null) return '—';
  const val = percent.toFixed(2);
  return percent > 0 ? `+${val}%` : `${val}%`;
}

/** Spread-style point with sign for spreads; plain number otherwise. */
export function formatPoint(point: number | null | undefined, market: string): string {
  if (point == null) return '';
  if (market === 'spreads') {
    return point > 0 ? `+${point}` : `${point}`;
  }
  // Totals just use the selection directly, so we might not even render point
  // if market is totals. We'll return point as string just in case.
  return point.toString();
}

const MARKET_LABELS: Record<string, string> = {
  h2h: 'H2H',
  spreads: 'Spreads',
  totals: 'Totals',
};

/**
 * Human label for a market key: "totals" → "Totals",
 * "batter_total_bases" → "Batter Total Bases", "player_pass_yds" → "Pass Yds"
 * (the "player_" prefix is dropped — it's redundant next to a player name).
 */
export function formatMarketLabel(market: string): string {
  const known = MARKET_LABELS[market];
  if (known) return known;
  const cleaned = market.startsWith('player_') ? market.slice('player_'.length) : market;
  return cleaned
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
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

/**
 * YYYY-MM-DD calendar day of an instant in US Eastern time. Games are bucketed
 * by their Eastern day so late-night games land on the correct baseball date.
 */
export function easternDayKey(iso: string | Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function shiftDayKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** "Today" / "Tomorrow" / "Tue Jul 14" for a YYYY-MM-DD Eastern day key. */
export function formatDayLabel(key: string): string {
  if (!key) return '';
  const todayKey = easternDayKey(new Date().toISOString());
  if (key === todayKey) return 'Today';
  if (key === shiftDayKey(todayKey, 1)) return 'Tomorrow';
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return dt.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** "7:05 PM" in the viewer's local timezone. */
export function formatTimeOnly(iso: string | Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** "Jul 11 · 7:05 PM" in the viewer's local timezone. */
export function formatGameTime(iso: string | Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}
