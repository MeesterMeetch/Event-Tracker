import { describe, expect, it } from "vitest";

import { formatCurrency } from "./utils";

/**
 * Tests for web-only helpers. The shared date/format helpers (easternDayKey,
 * formatDayLabel, formatOdds, …) live in @workspace/format with their own
 * boundary suite (lib/format/src/index.test.ts) — one implementation, one
 * suite, no copies to drift.
 */

describe("formatCurrency", () => {
  it("renders US dollars with grouping and cents", () => {
    expect(formatCurrency(1234.5)).toBe("$1,234.50");
  });
  it("keeps the sign on losses", () => {
    expect(formatCurrency(-42)).toBe("-$42.00");
  });
});
