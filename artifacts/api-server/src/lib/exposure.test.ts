import { describe, it, expect } from "vitest";
import {
  correlationScale,
  correlationTier,
  sizePosition,
  exposureSummary,
  CORRELATION_BY_TIER,
  DEFAULT_EXPOSURE_LIMITS,
  type Position,
} from "./exposure";

function pos(gameId: string, units: number, player: string | null = null, team: string | null = null): Position {
  return { gameId, player, team, units };
}

describe("correlationScale", () => {
  it("leaves a lone position alone", () => {
    expect(correlationScale(1, 0.6)).toBe(1);
  });

  it("reduces to 1/sqrt(n) for uncorrelated positions", () => {
    expect(correlationScale(4, 0)).toBeCloseTo(0.5, 10);
    expect(correlationScale(9, 0)).toBeCloseTo(1 / 3, 10);
  });

  it("collapses to 1/n when positions are perfectly correlated", () => {
    // The whole cluster should then carry the risk of exactly one position.
    expect(correlationScale(4, 1)).toBeCloseTo(0.25, 10);
    expect(correlationScale(5, 1)).toBeCloseTo(0.2, 10);
  });

  it("lands between those bounds for partial correlation", () => {
    const partial = correlationScale(4, 0.5);
    expect(partial).toBeLessThan(correlationScale(4, 0));
    expect(partial).toBeGreaterThan(correlationScale(4, 1));
  });

  it("shrinks monotonically as correlation rises", () => {
    const scales = [0, 0.25, 0.5, 0.75, 1].map((rho) => correlationScale(5, rho));
    for (let i = 1; i < scales.length; i++) {
      expect(scales[i]).toBeLessThan(scales[i - 1]);
    }
  });

  it("clamps a nonsense correlation instead of producing garbage", () => {
    expect(correlationScale(3, 5)).toBeCloseTo(correlationScale(3, 1), 10);
    expect(correlationScale(3, -2)).toBeCloseTo(correlationScale(3, 0), 10);
  });
});

describe("correlationTier", () => {
  it("treats different games as unrelated", () => {
    expect(correlationTier(pos("g1", 1), pos("g2", 1))).toBe("unrelated");
  });

  it("identifies the same player in the same game", () => {
    expect(correlationTier(pos("g1", 1, "Mahomes"), pos("g1", 1, "Mahomes"))).toBe("samePlayer");
  });

  it("identifies teammates", () => {
    expect(correlationTier(pos("g1", 1, "Kelce", "KC"), pos("g1", 1, "Mahomes", "KC"))).toBe("sameTeam");
  });

  it("falls back to same-game for unrelated sides of one game", () => {
    expect(correlationTier(pos("g1", 1, null, "KC"), pos("g1", 1, null, "BUF"))).toBe("sameGame");
  });

  it("orders the tiers by strength", () => {
    expect(CORRELATION_BY_TIER.samePlayer).toBeGreaterThan(CORRELATION_BY_TIER.sameTeam);
    expect(CORRELATION_BY_TIER.sameTeam).toBeGreaterThan(CORRELATION_BY_TIER.sameGame);
    expect(CORRELATION_BY_TIER.unrelated).toBe(0);
  });
});

describe("sizePosition", () => {
  it("grants the full request when nothing correlated is open", () => {
    const result = sizePosition(pos("g1", 1.5, "Mahomes", "KC"), []);
    expect(result.units).toBeCloseTo(1.5, 6);
    expect(result.boundBy).toBe("kelly");
    expect(result.correlationScale).toBe(1);
  });

  it("does not shrink a position for bets in other games", () => {
    const result = sizePosition(pos("g1", 1.5, "Mahomes", "KC"), [pos("g2", 2), pos("g3", 2)]);
    expect(result.units).toBeCloseTo(1.5, 6);
    expect(result.tier).toBe("unrelated");
  });

  it("cuts hardest for a second position on the same player", () => {
    const samePlayer = sizePosition(pos("g1", 2, "Mahomes", "KC"), [pos("g1", 2, "Mahomes", "KC")]);
    const sameTeam = sizePosition(pos("g1", 2, "Kelce", "KC"), [pos("g1", 2, "Mahomes", "KC")]);
    const sameGame = sizePosition(pos("g1", 2, null, "BUF"), [pos("g1", 2, null, "KC")]);
    expect(samePlayer.units).toBeLessThan(sameTeam.units);
    expect(sameTeam.units).toBeLessThan(sameGame.units);
  });

  it("is the scenario that motivates the module: five correlated legs total roughly one position", () => {
    // Four already open on one game script, all same-player tier.
    const open = [
      pos("g1", 1, "Mahomes", "KC"),
      pos("g1", 1, "Mahomes", "KC"),
      pos("g1", 1, "Mahomes", "KC"),
      pos("g1", 1, "Mahomes", "KC"),
    ];
    const result = sizePosition(pos("g1", 1, "Mahomes", "KC"), open);
    // rho 0.6, cluster of 5 -> 1/sqrt(5 + 20*0.6) = 1/sqrt(17)
    expect(result.correlationScale).toBeCloseTo(1 / Math.sqrt(17), 10);
    expect(result.units).toBeLessThan(0.3);
  });

  it("respects the per-position ceiling", () => {
    const result = sizePosition(pos("g1", 99, "Mahomes", "KC"), []);
    expect(result.units).toBeCloseTo(DEFAULT_EXPOSURE_LIMITS.maxUnitsPerPosition, 6);
    expect(result.boundBy).toBe("position");
  });

  it("caps against remaining game headroom", () => {
    // 4.5 of 5 units already committed to this game.
    const open = [pos("g1", 4.5, null, "KC")];
    const result = sizePosition(pos("g1", 2, null, "BUF"), open);
    expect(result.units).toBeCloseTo(0.5, 6);
    expect(result.boundBy).toBe("game");
  });

  it("returns zero and says so when a cap is exhausted", () => {
    const open = [pos("g1", 5, null, "KC")];
    const result = sizePosition(pos("g1", 2, null, "BUF"), open);
    expect(result.units).toBe(0);
    expect(result.reason).toMatch(/no headroom/i);
  });

  it("caps against the daily limit across unrelated games", () => {
    const open = Array.from({ length: 3 }, (_, i) => pos(`g${i}`, 4.8));
    const result = sizePosition(pos("gNew", 2), open);
    // 14.4 of 15 used, so 0.6 left.
    expect(result.units).toBeCloseTo(0.6, 6);
    expect(result.boundBy).toBe("day");
  });

  it("applies the drawdown throttle", () => {
    const full = sizePosition(pos("g1", 2), [], DEFAULT_EXPOSURE_LIMITS, 1);
    const throttled = sizePosition(pos("g1", 2), [], DEFAULT_EXPOSURE_LIMITS, 0.5);
    expect(throttled.units).toBeCloseTo(full.units * 0.5, 6);
    expect(throttled.boundBy).toBe("drawdown");
  });

  it("never returns a negative stake", () => {
    const open = [pos("g1", 100, null, "KC")];
    expect(sizePosition(pos("g1", 2, null, "BUF"), open).units).toBe(0);
  });

  it("explains what bound the number", () => {
    const result = sizePosition(pos("g1", 2, "Mahomes", "KC"), [pos("g1", 1, "Mahomes", "KC")]);
    expect(result.reason).toMatch(/correlated/i);
  });
});

describe("exposureSummary", () => {
  const open = [
    pos("g1", 2, "Mahomes", "KC"),
    pos("g1", 1.5, "Kelce", "KC"),
    pos("g2", 3, null, "NYY"),
  ];

  it("totals exposure across positions", () => {
    expect(exposureSummary(open).totalUnits).toBeCloseTo(6.5, 6);
  });

  it("aggregates by game, biggest first", () => {
    const summary = exposureSummary(open);
    expect(summary.byGame[0].gameId).toBe("g1");
    expect(summary.byGame[0].units).toBeCloseTo(3.5, 6);
  });

  it("aggregates by player", () => {
    const summary = exposureSummary(open);
    const mahomes = summary.byPlayer.find((p) => p.player === "Mahomes")!;
    expect(mahomes.units).toBeCloseTo(2, 6);
  });

  it("flags a breached cap", () => {
    const summary = exposureSummary([pos("g1", 6, null, "KC")]);
    expect(summary.breaches.some((b) => b.includes("Game g1"))).toBe(true);
  });

  it("flags a breached daily cap", () => {
    const heavy = Array.from({ length: 5 }, (_, i) => pos(`g${i}`, 4));
    expect(exposureSummary(heavy).breaches.some((b) => b.startsWith("Day"))).toBe(true);
  });

  it("handles no open positions", () => {
    const summary = exposureSummary([]);
    expect(summary.totalUnits).toBe(0);
    expect(summary.breaches).toEqual([]);
  });
});
