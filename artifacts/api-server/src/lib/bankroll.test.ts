import { describe, it, expect } from "vitest";
import {
  bankrollSummary,
  drawdownScale,
  unitsToCurrency,
  DEFAULT_THROTTLE,
  type BankrollEventLike,
  type SettledBetLike,
} from "./bankroll";

function bet(day: number, pnl: number | null, status = "won"): SettledBetLike {
  const at = new Date(Date.UTC(2026, 6, day));
  return { settledAt: at, createdAt: at, pnl, status };
}
function deposit(day: number, amount: number): BankrollEventLike {
  return { occurredAt: new Date(Date.UTC(2026, 6, day)), amount };
}

describe("bankrollSummary", () => {
  it("derives balance from deposits plus realized results", () => {
    const s = bankrollSummary([deposit(1, 1000)], [bet(2, 200), bet(3, -50)]);
    expect(s.currentBalance).toBeCloseTo(1150, 6);
    expect(s.realizedPnl).toBeCloseTo(150, 6);
    expect(s.totalDeposited).toBeCloseTo(1000, 6);
  });

  it("ignores pending bets, since money at risk is not yet won or lost", () => {
    const s = bankrollSummary([deposit(1, 1000)], [bet(2, null, "pending"), bet(3, 100)]);
    expect(s.currentBalance).toBeCloseTo(1100, 6);
  });

  it("tracks withdrawals separately from losses", () => {
    const s = bankrollSummary([deposit(1, 1000), deposit(5, -300)], []);
    expect(s.currentBalance).toBeCloseTo(700, 6);
    expect(s.totalWithdrawn).toBeCloseTo(300, 6);
    // A withdrawal lowers the balance but is not a drawdown: capital left, it
    // was not lost.
    expect(s.realizedPnl).toBe(0);
  });

  it("computes current and max drawdown from the peak", () => {
    // 1000 -> 1500 (peak) -> 1200
    const s = bankrollSummary([deposit(1, 1000)], [bet(2, 500), bet(3, -300)]);
    expect(s.peakBalance).toBeCloseTo(1500, 6);
    expect(s.currentDrawdown).toBeCloseTo(0.2, 6);
    expect(s.maxDrawdown).toBeCloseTo(0.2, 6);
  });

  it("remembers the worst drawdown even after recovering", () => {
    // 1000 -> 600 (40% down) -> 1100 (new peak)
    const s = bankrollSummary([deposit(1, 1000)], [bet(2, -400), bet(3, 500)]);
    expect(s.maxDrawdown).toBeCloseTo(0.4, 6);
    expect(s.currentDrawdown).toBeCloseTo(0, 6);
  });

  it("replays events in chronological order regardless of input order", () => {
    const jumbled = bankrollSummary([deposit(1, 1000)], [bet(5, -100), bet(2, 300)]);
    const ordered = bankrollSummary([deposit(1, 1000)], [bet(2, 300), bet(5, -100)]);
    expect(jumbled.curve.map((p) => p.balance)).toEqual(ordered.curve.map((p) => p.balance));
    expect(jumbled.maxDrawdown).toBeCloseTo(ordered.maxDrawdown, 10);
  });

  it("builds a curve with a monotonically non-decreasing peak", () => {
    const s = bankrollSummary([deposit(1, 1000)], [bet(2, 200), bet(3, -400), bet(4, 600)]);
    for (let i = 1; i < s.curve.length; i++) {
      expect(s.curve[i].peak).toBeGreaterThanOrEqual(s.curve[i - 1].peak);
    }
  });

  it("sizes a unit against the current balance", () => {
    const s = bankrollSummary([deposit(1, 2000)], [bet(2, 500)]);
    expect(s.unitValue).toBeCloseTo(25, 6);
  });

  it("handles an empty ledger without dividing by zero", () => {
    const s = bankrollSummary([], []);
    expect(s.currentBalance).toBe(0);
    expect(s.currentDrawdown).toBe(0);
    expect(s.maxDrawdown).toBe(0);
    expect(s.curve).toEqual([]);
  });
});

describe("drawdownScale", () => {
  it("leaves ordinary variance untouched", () => {
    expect(drawdownScale(0)).toBe(1);
    expect(drawdownScale(0.05)).toBe(1);
    expect(drawdownScale(DEFAULT_THROTTLE.freeThreshold)).toBe(1);
  });

  it("reaches the floor at the deep threshold and stays there", () => {
    expect(drawdownScale(DEFAULT_THROTTLE.fullThreshold)).toBeCloseTo(DEFAULT_THROTTLE.floor, 10);
    expect(drawdownScale(0.9)).toBeCloseTo(DEFAULT_THROTTLE.floor, 10);
  });

  it("ramps linearly in between", () => {
    // Midway between 10% and 30% should be midway between 1 and the floor.
    const mid = drawdownScale(0.2);
    expect(mid).toBeCloseTo((1 + DEFAULT_THROTTLE.floor) / 2, 10);
  });

  it("decreases monotonically as the hole deepens", () => {
    const scales = [0, 0.1, 0.15, 0.2, 0.25, 0.3].map((d) => drawdownScale(d));
    for (let i = 1; i < scales.length; i++) {
      expect(scales[i]).toBeLessThanOrEqual(scales[i - 1]);
    }
  });

  it("honours a custom throttle", () => {
    const strict = { freeThreshold: 0, fullThreshold: 0.2, floor: 0.25 };
    expect(drawdownScale(0.2, strict)).toBeCloseTo(0.25, 10);
    expect(drawdownScale(0.1, strict)).toBeCloseTo(0.625, 10);
  });
});

describe("unitsToCurrency", () => {
  it("converts units at one percent of bankroll", () => {
    expect(unitsToCurrency(2.5, 10000)).toBeCloseTo(250, 6);
  });

  it("shrinks with the bankroll, which is the entire point", () => {
    expect(unitsToCurrency(1, 5000)).toBeLessThan(unitsToCurrency(1, 10000));
  });
});
