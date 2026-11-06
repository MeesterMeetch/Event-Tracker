import { describe, expect, it } from "vitest";

import { inDateWindow, windowEnd } from "./date-window";

// Local-time constructors so the suite holds in any timezone.
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min);

describe("windowEnd", () => {
  it("is unbounded for all", () => {
    expect(windowEnd("all", at(2026, 11, 6))).toBeNull();
  });

  it("ends at local midnight tonight for today", () => {
    expect(windowEnd("today", at(2026, 11, 6, 15))).toEqual(at(2026, 11, 7, 0));
  });

  it("runs Friday through the end of Monday for this week", () => {
    expect(windowEnd("week", at(2026, 11, 6, 15))).toEqual(at(2026, 11, 10, 0));
  });

  it("reaches six days ahead on a Tuesday", () => {
    expect(windowEnd("week", at(2026, 11, 10, 9))).toEqual(at(2026, 11, 17, 0));
  });

  it("ends tonight when it's already Monday", () => {
    expect(windowEnd("week", at(2026, 11, 9, 10))).toEqual(at(2026, 11, 10, 0));
  });

  it("covers Sunday through Monday night", () => {
    expect(windowEnd("week", at(2026, 11, 8, 10))).toEqual(at(2026, 11, 10, 0));
  });
});

describe("inDateWindow", () => {
  const friday = at(2026, 11, 6, 15);

  it("keeps Monday night football in this week", () => {
    expect(inDateWindow(at(2026, 11, 9, 18, 15), "week", friday)).toBe(true);
  });

  it("drops next Thursday from this week", () => {
    expect(inDateWindow(at(2026, 11, 12, 18, 15), "week", friday)).toBe(false);
  });

  it("drops tomorrow from today", () => {
    expect(inDateWindow(at(2026, 11, 7, 11), "today", friday)).toBe(false);
    expect(inDateWindow(at(2026, 11, 6, 20), "today", friday)).toBe(true);
  });

  it("accepts ISO strings", () => {
    expect(inDateWindow(at(2026, 11, 8, 11).toISOString(), "week", friday)).toBe(true);
  });

  it("keeps everything for all", () => {
    expect(inDateWindow(at(2027, 1, 1), "all", friday)).toBe(true);
  });
});
