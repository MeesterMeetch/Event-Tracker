import { describe, expect, it } from "vitest";
import { calcPnl, gradeBet, type BetForGrading } from "./grading-math";
import type { ScoresGame } from "./odds";

/**
 * gradeBet and calcPnl settle finished games into a win/loss/push record and a
 * profit/loss in units. A silent bug here never crashes — it just reports the
 * wrong record and bankroll — so every expected value below is hand-verified
 * from the inputs and a math regression fails here loudly.
 */

function game(
  homeTeam: string,
  awayTeam: string,
  homeScore: number | null,
  awayScore: number | null,
  overrides: Partial<ScoresGame> = {},
): ScoresGame {
  const scores =
    homeScore == null || awayScore == null
      ? null
      : [
          { name: homeTeam, score: String(homeScore) },
          { name: awayTeam, score: String(awayScore) },
        ];
  return {
    id: "g1",
    sport_key: "baseball_mlb",
    commence_time: "2026-07-12T18:00:00Z",
    completed: true,
    home_team: homeTeam,
    away_team: awayTeam,
    scores,
    ...overrides,
  };
}

function bet(overrides: Partial<BetForGrading>): BetForGrading {
  return {
    market: "h2h",
    selection: "Home",
    point: null,
    homeTeam: "Home",
    awayTeam: "Away",
    ...overrides,
  };
}

describe("gradeBet — h2h", () => {
  it("grades a straight-up winner", () => {
    // Home wins 5-3; a bet on Home is a win, a bet on Away is a loss.
    const g = game("Home", "Away", 5, 3);
    expect(gradeBet(bet({ market: "h2h", selection: "Home" }), g)).toBe("won");
    expect(gradeBet(bet({ market: "h2h", selection: "Away" }), g)).toBe("lost");
  });

  it("grades the away side winning on the road", () => {
    const g = game("Home", "Away", 2, 6);
    expect(gradeBet(bet({ market: "h2h", selection: "Away" }), g)).toBe("won");
    expect(gradeBet(bet({ market: "h2h", selection: "Home" }), g)).toBe("lost");
  });

  it("returns a push when the score is level (no moneyline draw in the data)", () => {
    const g = game("Home", "Away", 4, 4);
    expect(gradeBet(bet({ market: "h2h", selection: "Home" }), g)).toBe("push");
  });

  it("returns null when the selection matches neither team", () => {
    const g = game("Home", "Away", 5, 3);
    expect(gradeBet(bet({ market: "h2h", selection: "Draw" }), g)).toBeNull();
  });
});

describe("gradeBet — spreads", () => {
  it("grades the favorite covering", () => {
    // Home -1.5 wins by 3 (5-2): adjusted 5 + (-1.5) = 3.5 > 2 → cover.
    const g = game("Home", "Away", 5, 2);
    expect(gradeBet(bet({ market: "spreads", selection: "Home", point: -1.5 }), g)).toBe("won");
  });

  it("grades the favorite failing to cover", () => {
    // Home -1.5 wins by only 1 (4-3): adjusted 4 - 1.5 = 2.5 < 3 → no cover.
    const g = game("Home", "Away", 4, 3);
    expect(gradeBet(bet({ market: "spreads", selection: "Home", point: -1.5 }), g)).toBe("lost");
  });

  it("grades the underdog covering by losing inside the number", () => {
    // Away +2.5 loses by 1 (5-4): adjusted 4 + 2.5 = 6.5 > 5 → cover.
    const g = game("Home", "Away", 5, 4);
    expect(gradeBet(bet({ market: "spreads", selection: "Away", point: 2.5 }), g)).toBe("won");
  });

  it("grades an exact push on a whole-number spread", () => {
    // Home -2 wins by exactly 2 (6-4): adjusted 6 - 2 = 4 == 4 → push.
    const g = game("Home", "Away", 6, 4);
    expect(gradeBet(bet({ market: "spreads", selection: "Home", point: -2 }), g)).toBe("push");
  });

  it("returns null when the spread point is missing", () => {
    const g = game("Home", "Away", 6, 4);
    expect(gradeBet(bet({ market: "spreads", selection: "Home", point: null }), g)).toBeNull();
  });

  it("returns null when the selection matches neither team", () => {
    const g = game("Home", "Away", 6, 4);
    expect(gradeBet(bet({ market: "spreads", selection: "Nobody", point: -1.5 }), g)).toBeNull();
  });
});

describe("gradeBet — totals", () => {
  it("grades an over hitting", () => {
    // 5 + 4 = 9 > 8.5 → Over wins, Under loses.
    const g = game("Home", "Away", 5, 4);
    expect(gradeBet(bet({ market: "totals", selection: "Over", point: 8.5 }), g)).toBe("won");
    expect(gradeBet(bet({ market: "totals", selection: "Under", point: 8.5 }), g)).toBe("lost");
  });

  it("grades an under hitting", () => {
    // 2 + 3 = 5 < 8.5 → Under wins, Over loses.
    const g = game("Home", "Away", 2, 3);
    expect(gradeBet(bet({ market: "totals", selection: "Under", point: 8.5 }), g)).toBe("won");
    expect(gradeBet(bet({ market: "totals", selection: "Over", point: 8.5 }), g)).toBe("lost");
  });

  it("grades an exact push on a whole-number total", () => {
    // 4 + 4 = 8 == 8 → push for both sides.
    const g = game("Home", "Away", 4, 4);
    expect(gradeBet(bet({ market: "totals", selection: "Over", point: 8 }), g)).toBe("push");
    expect(gradeBet(bet({ market: "totals", selection: "Under", point: 8 }), g)).toBe("push");
  });

  it("resolves the side from a decorated selection label", () => {
    // Selection labels like "Over 8.5" must still resolve to the Over side.
    const g = game("Home", "Away", 5, 4);
    expect(gradeBet(bet({ market: "totals", selection: "Over 8.5", point: 8.5 }), g)).toBe("won");
  });

  it("returns null when the total point is missing", () => {
    const g = game("Home", "Away", 5, 4);
    expect(gradeBet(bet({ market: "totals", selection: "Over", point: null }), g)).toBeNull();
  });

  it("returns null for an unrecognized totals side", () => {
    const g = game("Home", "Away", 5, 4);
    expect(gradeBet(bet({ market: "totals", selection: "Sideways", point: 8.5 }), g)).toBeNull();
  });
});

describe("gradeBet — incomplete data returns null instead of guessing", () => {
  it("returns null for a game not yet completed", () => {
    const g = game("Home", "Away", 5, 3, { completed: false });
    expect(gradeBet(bet({ market: "h2h", selection: "Home" }), g)).toBeNull();
  });

  it("returns null when scores are absent", () => {
    const g = game("Home", "Away", null, null);
    expect(g.scores).toBeNull();
    expect(gradeBet(bet({ market: "h2h", selection: "Home" }), g)).toBeNull();
  });

  it("returns null when a team's score row is missing", () => {
    const g = game("Home", "Away", 5, 3, {
      scores: [{ name: "Home", score: "5" }],
    });
    expect(gradeBet(bet({ market: "h2h", selection: "Home" }), g)).toBeNull();
  });

  it("returns null when a score is non-numeric", () => {
    const g = game("Home", "Away", 5, 3, {
      scores: [
        { name: "Home", score: "5" },
        { name: "Away", score: "TBD" },
      ],
    });
    expect(gradeBet(bet({ market: "h2h", selection: "Home" }), g)).toBeNull();
  });

  it("returns null for an unknown market", () => {
    const g = game("Home", "Away", 5, 3);
    expect(gradeBet(bet({ market: "player_strikeouts", selection: "Home" }), g)).toBeNull();
  });
});

describe("calcPnl", () => {
  it("pays an underdog winner at positive odds", () => {
    // +150 for 1u → 1 * 150/100 = +1.5.
    expect(calcPnl("won", 150, 1)).toBe(1.5);
  });

  it("pays a favorite winner at negative odds", () => {
    // -120 for 1.2u → 1.2 * 100/120 = +1.0.
    expect(calcPnl("won", -120, 1.2)).toBe(1);
  });

  it("scales the payout by the staked units", () => {
    // +200 for 2.5u → 2.5 * 200/100 = +5.0.
    expect(calcPnl("won", 200, 2.5)).toBe(5);
  });

  it("returns the negative stake on a loss", () => {
    expect(calcPnl("lost", 150, 1)).toBe(-1);
    expect(calcPnl("lost", -120, 1.2)).toBe(-1.2);
  });

  it("returns zero on a push regardless of odds or units", () => {
    expect(calcPnl("push", 150, 3)).toBe(0);
    expect(calcPnl("push", -200, 1)).toBe(0);
  });

  it("rounds payouts to the cent", () => {
    // -110 for 1u → 100/110 = 0.9090... → rounds to 0.91.
    expect(calcPnl("won", -110, 1)).toBe(0.91);
  });
});
