import { describe, expect, it } from "vitest";
import { computeModelEdges, MODEL_SPORT_KEY, PITCHER_K_MARKET } from "./pitcher-k-scanner";
import type { OddsEvent } from "./odds";
import type { MatchupKInputs, PitcherKStats, PitcherKMatchupSide } from "./mlb";

/**
 * Guards the model consumer against projecting off empty/degraded K inputs.
 * When getMatchupKInputs degrades (MLB feed failure, unannounced starter) it
 * hands back a pitcher object with zeroed rolling stats and null season/career.
 * The model must abstain and surface insufficient data rather than dress the
 * league-average fallback up as a precise projection.
 */

function pitcher(overrides: Partial<PitcherKStats>): PitcherKStats {
  return {
    id: 1,
    name: "Test Pitcher",
    team: "Home Team",
    throws: "R",
    rollingStrikeouts: 0,
    rollingBattersFaced: 0,
    rollingStarts: 0,
    rollingBfPerStart: null,
    seasonStrikeouts: null,
    seasonBattersFaced: null,
    seasonGamesStarted: null,
    careerStrikeouts: null,
    careerBattersFaced: null,
    ...overrides,
  };
}

/** An event quoting an over/under strikeout line for the given pitcher name. */
function eventWithLine(pitcherName: string): OddsEvent {
  return {
    id: "evt1",
    sport_key: MODEL_SPORT_KEY,
    commence_time: "2025-07-02T02:10:00Z",
    home_team: "Home Team",
    away_team: "Away Team",
    bookmakers: [
      {
        key: "book_a",
        title: "Book A",
        markets: [
          {
            key: PITCHER_K_MARKET,
            outcomes: [
              { name: "Over", description: pitcherName, point: 5.5, price: -110 },
              { name: "Under", description: pitcherName, point: 5.5, price: -110 },
            ],
          },
        ],
      },
      {
        key: "book_b",
        title: "Book B",
        markets: [
          {
            key: PITCHER_K_MARKET,
            outcomes: [
              { name: "Over", description: pitcherName, point: 5.5, price: -105 },
              { name: "Under", description: pitcherName, point: 5.5, price: -115 },
            ],
          },
        ],
      },
    ],
  };
}

function inputs(home: PitcherKMatchupSide, away: PitcherKMatchupSide): MatchupKInputs {
  return { home, away };
}

describe("computeModelEdges — abstention on empty K inputs", () => {
  it("abstains and flags insufficient data when a side has no rolling/season/career sample", () => {
    const event = eventWithLine("Test Pitcher");
    const degraded = pitcher({ name: "Test Pitcher", throws: null });
    const result = computeModelEdges(
      event,
      MODEL_SPORT_KEY,
      inputs({ pitcher: degraded, opponent: null }, { pitcher: null, opponent: null }),
      1,
    );

    expect(result).toHaveLength(1);
    const proj = result[0];
    expect(proj.insufficientData).toBe(true);
    expect(proj.lines).toEqual([]);
    // No misleadingly precise numbers leak through.
    expect(proj.expectedStrikeouts).toBe(0);
    expect(proj.ratePerBF).toBe(0);
    expect(proj.pitcher).toBe("Test Pitcher");
  });

  it("still projects a side backed only by season data", () => {
    const event = eventWithLine("Test Pitcher");
    const seasonOnly = pitcher({
      name: "Test Pitcher",
      seasonStrikeouts: 180,
      seasonBattersFaced: 700,
      seasonGamesStarted: 28,
    });
    const result = computeModelEdges(
      event,
      MODEL_SPORT_KEY,
      inputs({ pitcher: seasonOnly, opponent: null }, { pitcher: null, opponent: null }),
      1,
    );

    expect(result).toHaveLength(1);
    const proj = result[0];
    expect(proj.insufficientData).toBe(false);
    expect(proj.lines.length).toBeGreaterThan(0);
    expect(proj.expectedStrikeouts).toBeGreaterThan(0);
  });

  it("projects a real rolling-window side and abstains on the degraded one in the same game", () => {
    const event: OddsEvent = {
      ...eventWithLine("Good Pitcher"),
    };
    // Add lines for the degraded pitcher too so the only reason it's surfaced is
    // the insufficient-data abstention, not the market.
    event.bookmakers = event.bookmakers.map((b) => ({
      ...b,
      markets: b.markets.map((m) => ({
        ...m,
        outcomes: [
          ...m.outcomes,
          { name: "Over", description: "Bad Pitcher", point: 4.5, price: -110 },
          { name: "Under", description: "Bad Pitcher", point: 4.5, price: -110 },
        ],
      })),
    }));

    const good = pitcher({
      name: "Good Pitcher",
      team: "Home Team",
      rollingStrikeouts: 60,
      rollingBattersFaced: 240,
      rollingStarts: 10,
      rollingBfPerStart: 24,
      seasonStrikeouts: 180,
      seasonBattersFaced: 700,
      seasonGamesStarted: 28,
    });
    const bad = pitcher({ name: "Bad Pitcher", team: "Away Team", throws: null });

    const result = computeModelEdges(
      event,
      MODEL_SPORT_KEY,
      inputs({ pitcher: good, opponent: null }, { pitcher: bad, opponent: null }),
      1,
    );

    expect(result).toHaveLength(2);
    const goodProj = result.find((p) => p.pitcher === "Good Pitcher");
    const badProj = result.find((p) => p.pitcher === "Bad Pitcher");
    expect(goodProj?.insufficientData).toBe(false);
    expect(goodProj?.lines.length).toBeGreaterThan(0);
    expect(badProj?.insufficientData).toBe(true);
    expect(badProj?.lines).toEqual([]);
  });
});
