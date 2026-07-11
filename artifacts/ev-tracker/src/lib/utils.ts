import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatOdds(odds: number) {
  if (odds > 0) return `+${odds}`;
  return `${odds}`;
}

export function formatPercent(percent: number | null | undefined) {
  if (percent == null) return '-';
  const val = percent.toFixed(2);
  if (percent > 0) return `+${val}%`;
  return `${val}%`;
}

export function formatPoint(point: number | null | undefined, market: string) {
  if (point == null) return '';
  if (market === 'spreads') {
    return point > 0 ? `+${point}` : `${point}`;
  }
  // Totals just use the selection directly, so we might not even render point if market is totals.
  // We'll return point as string just in case.
  return point.toString();
}

export function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount);
}

/** "Jul 11 · 7:05 PM" in the viewer's local timezone. */
export function formatGameTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}
