import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMlbLeaders, getMatchupPitchers } from "./mlb";
import { loadFixture, stubFetchRoutes } from "./__fixtures__/index";

/**
 * Guards parsing of MLB's free public Stats API leaders feed. The hitting and
 * pitching stat groups are requested separately (strikeouts exists in both), so
 * the fixtures and routes mirror that two-call shape.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchMlbLeaders", () => {
  it("maps hitting then pitching categories with friendly labels", async () => {
    stubFetchRoutes([
      { contains: "statGroup=hitting", payload: loadFixture("leaders-mlb-hitting.json") },
      { contains: "statGroup=pitching", payload: loadFixture("leaders-mlb-pitching.json") },
    ]);

    const cats = await fetchMlbLeaders(2025);

    // Hitting group is requested first, then pitching.
    expect(cats.map((c) => c.key)).toEqual([
      "homeRuns",
      "battingAverage",
      "runsBattedIn",
      "earnedRunAverage",
      "strikeouts",
    ]);
    expect(cats.map((c) => c.label)).toEqual([
      "Home Runs",
      "Batting Avg",
      "RBI",
      "ERA",
      "Strikeouts (P)",
    ]);

    const homeRuns = cats[0];
    expect(homeRuns.leaders[0]).toEqual({
      rank: 1,
      player: "Cal Raleigh",
      team: "Seattle Mariners",
      value: "60",
    });
    expect(homeRuns.leaders).toHaveLength(2);

    // Numeric values from the feed are stringified for display.
    const era = cats.find((c) => c.key === "earnedRunAverage");
    expect(era?.leaders[0].value).toBe("2.14");
  });

  it("skips categories that return no usable leaders", async () => {
    stubFetchRoutes([
      {
        contains: "statGroup=hitting",
        payload: {
          leagueLeaders: [
            // Missing person name → dropped, leaving the category empty.
            { leaderCategory: "homeRuns", leaders: [{ rank: 1, value: "40", team: { name: "X" } }] },
            {
              leaderCategory: "battingAverage",
              leaders: [{ rank: 1, value: ".300", person: { fullName: "Real Hitter" } }],
            },
          ],
        },
      },
      { contains: "statGroup=pitching", payload: { leagueLeaders: [] } },
    ]);

    const cats = await fetchMlbLeaders(2025);

    expect(cats.map((c) => c.key)).toEqual(["battingAverage"]);
    expect(cats[0].leaders[0]).toEqual({
      rank: 1,
      player: "Real Hitter",
      team: null,
      value: ".300",
    });
  });
});

/**
 * Guards the probable-pitcher matchup path against MLB Stats API drift: the
 * schedule shape (hydrate=probablePitcher), the people stats hydrate (season +
 * gameLog groups), start filtering, W/L decisions, and doubleheader
 * disambiguation. A silent upstream shape change would otherwise blank out
 * pitcher cards without failing anything.
 */
describe("getMatchupPitchers", () => {
  it("resolves each side's starter with season aggregates and recent starts", async () => {
    stubFetchRoutes([
      { contains: "/schedule", payload: loadFixture("schedule-mlb-probable.json") },
      { contains: "/people/605483", payload: loadFixture("people-pitcher-snell.json") },
      { contains: "/people/657277", payload: loadFixture("people-pitcher-webb.json") },
    ]);

    const { home, away } = await getMatchupPitchers(
      "Los Angeles Dodgers",
      "San Francisco Giants",
      "2025-07-02T02:10:00Z",
    );

    // Home side maps to the correct pitcher and season line.
    expect(home).not.toBeNull();
    expect(home?.id).toBe(605483);
    expect(home?.name).toBe("Blake Snell");
    expect(home?.team).toBe("Los Angeles Dodgers");
    expect(home?.seasonEra).toBe("2.50");
    expect(home?.seasonWhip).toBe("1.10");
    expect(home?.seasonStrikeouts).toBe(200);
    expect(home?.inningsPitched).toBe("180.0");
    expect(home?.gamesStarted).toBe(30);
    expect(home?.seasonRecord).toBe("15-5");

    // gameLog has 6 starts + 1 relief appearance: relief dropped, only the last
    // 5 starts kept, most recent first.
    expect(home?.recentStarts).toHaveLength(5);
    expect(home?.recentStarts[0]).toEqual({
      date: "2025-07-01",
      opponent: "Philadelphia Phillies",
      inningsPitched: "7.0",
      earnedRuns: 1,
      strikeOuts: 9,
      walks: 1,
      hits: 4,
      decision: "W",
    });
    // The oldest start (2025-06-01) fell outside the last-5 window.
    expect(home?.recentStarts.some((s) => s.date === "2025-06-01")).toBe(false);
    // The relief outing (gamesStarted !== 1) is never counted as a start.
    expect(home?.recentStarts.some((s) => s.date === "2025-06-10")).toBe(false);
    // A no-decision start (0 wins, 0 losses) yields "-".
    const noDecision = home?.recentStarts.find((s) => s.date === "2025-06-07");
    expect(noDecision?.decision).toBe("-");
    // A loss is surfaced as "L".
    const loss = home?.recentStarts.find((s) => s.date === "2025-06-13");
    expect(loss?.decision).toBe("L");

    // Away side maps independently.
    expect(away?.id).toBe(657277);
    expect(away?.name).toBe("Logan Webb");
    expect(away?.team).toBe("San Francisco Giants");
    expect(away?.seasonRecord).toBe("9-8");
    expect(away?.recentStarts).toHaveLength(2);
    expect(away?.recentStarts[0].opponent).toBe("Miami Marlins");
    expect(away?.recentStarts[0].decision).toBe("W");
    expect(away?.recentStarts[0].inningsPitched).toBe("7.0");
    expect(away?.recentStarts[1].decision).toBe("L");
  });

  it("picks the doubleheader game closest to the requested start time", async () => {
    stubFetchRoutes([
      { contains: "/schedule", payload: loadFixture("schedule-mlb-doubleheader.json") },
      { contains: "/people/477132", payload: loadFixture("people-pitcher-kershaw.json") },
      { contains: "/people/592791", payload: loadFixture("people-pitcher-ray.json") },
    ]);

    // Requested start is minutes before game 2 (23:40Z), far from game 1 (17:10Z).
    const { home, away } = await getMatchupPitchers(
      "Los Angeles Dodgers",
      "San Francisco Giants",
      "2025-07-04T23:35:00Z",
    );

    // Game 2's starters, not game 1's (Blake Snell / Logan Webb).
    expect(home?.id).toBe(477132);
    expect(home?.name).toBe("Clayton Kershaw");
    expect(away?.id).toBe(592791);
    expect(away?.name).toBe("Robbie Ray");
  });

  it("returns nulls when no scheduled game matches the teams", async () => {
    stubFetchRoutes([
      { contains: "/schedule", payload: loadFixture("schedule-mlb-probable.json") },
    ]);

    const result = await getMatchupPitchers(
      "Boston Red Sox",
      "New York Yankees",
      "2025-07-02T02:10:00Z",
    );

    expect(result).toEqual({ home: null, away: null });
  });
});
