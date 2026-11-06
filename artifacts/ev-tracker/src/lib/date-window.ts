/**
 * Date-window filter for slates. "This week" is a betting week, not a
 * calendar week: it runs through the end of the coming Monday so Thursday,
 * Sunday and Monday night football all land in the same week, and on a
 * Tuesday it reaches six days ahead. Boundaries use the viewer's local time,
 * matching how formatGameTime displays kickoffs.
 */

export type DateWindow = "all" | "today" | "week";

export const DATE_WINDOW_LABELS: Record<DateWindow, string> = {
  all: "All upcoming",
  today: "Today",
  week: "This week (thru Mon)",
};

/** Exclusive end of the window, or null for no limit. */
export function windowEnd(window: DateWindow, now: Date = new Date()): Date | null {
  if (window === "all") return null;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // getDay: Sunday 0 ... Monday 1. Days until Monday, 0 when it's Monday.
  const daysAhead = window === "today" ? 0 : (1 - now.getDay() + 7) % 7;
  return new Date(
    startOfToday.getFullYear(),
    startOfToday.getMonth(),
    startOfToday.getDate() + daysAhead + 1,
  );
}

/** True when a game's start falls inside the window. */
export function inDateWindow(commenceTime: string | Date, window: DateWindow, now: Date = new Date()): boolean {
  const end = windowEnd(window, now);
  if (!end) return true;
  return new Date(commenceTime).getTime() < end.getTime();
}
