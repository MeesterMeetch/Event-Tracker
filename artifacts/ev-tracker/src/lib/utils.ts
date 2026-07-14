import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

// Shared date/format helpers live in @workspace/format — one implementation
// used by both web and mobile so Eastern-day bucketing can never disagree.
export {
  easternDayKey,
  formatDayLabel,
  formatGameTime,
  formatMarketLabel,
  formatOdds,
  formatPercent,
  formatPoint,
  formatTimeOnly,
} from "@workspace/format";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount);
}
