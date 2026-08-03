import { describe, it, expect } from "vitest";
import { selectTopPlays, summarizeSlate, playScore } from "./top-plays";
import type { EdgeOpportunity } from "./ev";

function edge(o: Partial<EdgeOpportunity> = {}): EdgeOpportunity {
  return {
    gameId: "g1", sport: "baseball_mlb", commenceTime: "2026-08-02T18:00:00Z",
    homeTeam: "Home", awayTeam: "Away", market: "h2h", selection: "Home",
    point: null, player: null, americanOdds: -110, book: "DraftKings",
    dkOdds: -110, fairOdds: -120, evPercent: 3, sharpProb: 55, publicProb: 54,
    bookCount: 10, dispersionPercent: 1, confidenceTier: "playable",
    confidenceScore: 62, confidenceReasons: [], ...o,
  } as EdgeOpportunity;
}

describe("playScore", () => {
  it("ranks a small solid edge above a large fragile one", () => {
    // The central claim: confidence dominates size.
    expect(playScore(edge({ evPercent: 2, confidenceTier: "solid" })))
      .toBeGreaterThan(playScore(edge({ evPercent: 8, confidenceTier: "fragile" })));
  });

  it("uses EV to break ties inside a tier", () => {
    expect(playScore(edge({ evPercent: 5, confidenceTier: "solid" })))
      .toBeGreaterThan(playScore(edge({ evPercent: 2, confidenceTier: "solid" })));
  });

  it("caps the EV contribution so an implausible number cannot jump a tier", () => {
    expect(playScore(edge({ evPercent: 40, confidenceTier: "playable" })))
      .toBeLessThan(playScore(edge({ evPercent: 0.1, confidenceTier: "solid" })));
  });
});

describe("selectTopPlays — diversification", () => {
  it("does not fill the list with five bets on one game", () => {
    // Five strong edges, all the same game. The naive version returns all five.
    const sameGame = Array.from({ length: 5 }, (_, i) =>
      edge({ gameId: "g1", selection: `sel${i}`, evPercent: 8 - i, confidenceTier: "solid" }),
    );
    const picks = selectTopPlays(sameGame);
    expect(picks.length).toBeLessThanOrEqual(2);
  });

  it("prefers spreading across games over taking the next-best correlated edge", () => {
    const picks = selectTopPlays([
      edge({ gameId: "g1", selection: "A", evPercent: 9, confidenceTier: "solid" }),
      edge({ gameId: "g1", selection: "B", evPercent: 8.5, confidenceTier: "solid" }),
      edge({ gameId: "g1", selection: "C", evPercent: 8, confidenceTier: "solid" }),
      edge({ gameId: "g2", selection: "D", evPercent: 3, confidenceTier: "solid" }),
      edge({ gameId: "g3", selection: "E", evPercent: 2.5, confidenceTier: "solid" }),
    ]);
    const games = new Set(picks.map((p) => p.edge.gameId));
    expect(games.size).toBeGreaterThanOrEqual(3);
  });

  it("holds a same-player second prop to a higher bar than an unrelated market", () => {
    const base = edge({ gameId: "g1", player: "Ohtani", market: "batter_hits", evPercent: 9, confidenceTier: "solid" });
    const samePlayer = edge({ gameId: "g1", player: "Ohtani", market: "batter_total_bases", evPercent: 3, confidenceTier: "fragile" });
    const picks = selectTopPlays([base, samePlayer], { limit: 5 });
    // The weak same-player follow-up should not clear the correlation bar.
    expect(picks).toHaveLength(1);
  });

  it("flags a second pick from the same game so it can be sized down", () => {
    const picks = selectTopPlays([
      edge({ gameId: "g1", selection: "A", evPercent: 9, confidenceTier: "solid" }),
      edge({ gameId: "g1", selection: "B", evPercent: 9, confidenceTier: "solid" }),
    ]);
    if (picks.length > 1) {
      expect(picks[1].sameGameCount).toBe(1);
      expect(picks[1].rationale).toMatch(/size it smaller/i);
    }
  });
});

describe("selectTopPlays — filtering", () => {
  it("never selects a suspect edge, however large", () => {
    const picks = selectTopPlays([edge({ evPercent: 25, confidenceTier: "suspect" })]);
    expect(picks).toEqual([]);
  });

  it("excludes negative EV", () => {
    expect(selectTopPlays([edge({ evPercent: -4, confidenceTier: "solid" })])).toEqual([]);
  });

  it("respects the limit", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      edge({ gameId: `g${i}`, evPercent: 5, confidenceTier: "solid" }),
    );
    expect(selectTopPlays(many, { limit: 3 })).toHaveLength(3);
  });

  it("numbers the ranks from one", () => {
    const picks = selectTopPlays([
      edge({ gameId: "g1", evPercent: 6, confidenceTier: "solid" }),
      edge({ gameId: "g2", evPercent: 4, confidenceTier: "solid" }),
    ]);
    expect(picks.map((p) => p.rank)).toEqual([1, 2]);
  });

  it("returns an empty list for an empty slate rather than throwing", () => {
    expect(selectTopPlays([])).toEqual([]);
  });
});

describe("summarizeSlate", () => {
  it("says plainly when there is nothing worth betting", () => {
    const edges = [edge({ evPercent: -3, confidenceTier: "suspect" })];
    expect(summarizeSlate(edges, []).interpretation).toMatch(/nothing on the board|normal outcome/i);
  });

  it("warns when the list rests on no solid edges", () => {
    const edges = [edge({ confidenceTier: "playable" })];
    const picks = selectTopPlays(edges);
    expect(summarizeSlate(edges, picks).interpretation).toMatch(/no solid edges/i);
  });

  it("counts tiers and coverage", () => {
    const edges = [
      edge({ gameId: "g1", confidenceTier: "solid" }),
      edge({ gameId: "g2", confidenceTier: "suspect", sport: "americanfootball_nfl" }),
    ];
    const s = summarizeSlate(edges, []);
    expect(s.byTier.solid).toBe(1);
    expect(s.byTier.suspect).toBe(1);
    expect(s.gamesRepresented).toBe(2);
    expect(s.sportsRepresented).toBe(2);
  });
});
