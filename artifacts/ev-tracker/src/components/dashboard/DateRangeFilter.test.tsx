// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { paramsFor, DEFAULT_RANGE, type RangeState } from "./DateRangeFilter";

/**
 * The range maths, tested away from the UI.
 *
 * Every bound is built from a local midnight rather than from "now minus N
 * hours". A rolling window would put half of yesterday into "7 days" and drift
 * further every hour the page stayed open, and the answer would change
 * depending on when you happened to look.
 */

const NOW = new Date("2026-08-07T15:30:00-06:00");

function state(over: Partial<RangeState> = {}): RangeState {
  return { ...DEFAULT_RANGE, ...over };
}

describe("paramsFor", () => {
  it("defaults to 30 days by game date", () => {
    expect(DEFAULT_RANGE.preset).toBe("30d");
    expect(DEFAULT_RANGE.basis).toBe("game");
  });

  it("sends no bounds at all for all time", () => {
    const p = paramsFor(state({ preset: "all" }), NOW);
    expect(p.from).toBeUndefined();
    expect(p.to).toBeUndefined();
    expect(p.basis).toBe("game");
  });

  it("ends every preset at the start of tomorrow, so today counts in full", () => {
    for (const preset of ["7d", "30d", "month", "season"] as const) {
      const p = paramsFor(state({ preset }), NOW);
      const to = new Date(p.to!);
      expect(to.getHours()).toBe(0);
      expect(to.getDate()).toBe(8);
    }
  });

  it("starts each rolling window on a local midnight", () => {
    const seven = new Date(paramsFor(state({ preset: "7d" }), NOW).from!);
    expect(seven.getHours()).toBe(0);
    // Six days back plus today is seven days of games.
    expect(seven.getDate()).toBe(1);

    const thirty = new Date(paramsFor(state({ preset: "30d" }), NOW).from!);
    expect(thirty.getHours()).toBe(0);
    expect(thirty.getMonth()).toBe(6);
    expect(thirty.getDate()).toBe(9);
  });

  it("starts this month on the first and the season on 1 January", () => {
    const month = new Date(paramsFor(state({ preset: "month" }), NOW).from!);
    expect(month.getDate()).toBe(1);
    expect(month.getMonth()).toBe(7);

    const season = new Date(paramsFor(state({ preset: "season" }), NOW).from!);
    expect(season.getMonth()).toBe(0);
    expect(season.getDate()).toBe(1);
  });

  /**
   * A custom end date has to include that whole day. Sending it as-is would
   * silently drop every game played on the day the user actually asked about.
   */
  it("makes a custom end date inclusive of that day", () => {
    const p = paramsFor(
      state({ preset: "custom", customFrom: "2026-07-01", customTo: "2026-07-31" }),
      NOW,
    );
    const to = new Date(p.to!);
    expect(to.getDate()).toBe(1);
    expect(to.getMonth()).toBe(7);
    expect(to.getHours()).toBe(0);
  });

  it("omits a custom bound that was left blank", () => {
    const p = paramsFor(state({ preset: "custom", customFrom: "2026-07-01", customTo: "" }), NOW);
    expect(p.from).toBeDefined();
    expect(p.to).toBeUndefined();
  });

  it("carries the basis through every preset", () => {
    for (const preset of ["7d", "30d", "month", "season", "all", "custom"] as const) {
      expect(paramsFor(state({ preset, basis: "logged" }), NOW).basis).toBe("logged");
    }
  });
});
