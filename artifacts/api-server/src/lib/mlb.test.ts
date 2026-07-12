import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMlbLeaders, getMatchupKInputs, getMatchupPitchers } from "./mlb";
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

/**
 * Guards the strikeout-model input path against MLB Stats API drift. This path
 * reads a *different* set of shapes than getMatchupPitchers: the people hydrate
 * pulls season/career/gameLog groups plus `pitchHand.code`, the rolling window
 * math relies on `battersFaced` (with an outs+hits+walks+HBP fallback), and the
 * opponent lineup K% comes from the team statSplits (vl/vr) feed. A silent
 * upstream change would zero out the model's K-rate inputs without failing.
 */
describe("getMatchupKInputs", () => {
  const K_ROUTES = [
    { contains: "/schedule", payload: loadFixture("schedule-mlb-probable.json") },
    { contains: "/people/605483", payload: loadFixture("people-kstats-snell.json") },
    { contains: "/people/657277", payload: loadFixture("people-kstats-webb.json") },
    { contains: "/teams/137/stats", payload: loadFixture("team-kprofile-giants.json") },
    { contains: "/teams/119/stats", payload: loadFixture("team-kprofile-dodgers.json") },
  ];

  it("assembles pitcher K rates, workload, and opposing-lineup K% per side", async () => {
    stubFetchRoutes(K_ROUTES);

    const { home, away } = await getMatchupKInputs(
      "Los Angeles Dodgers",
      "San Francisco Giants",
      "2025-07-02T02:10:00Z",
    );

    // Home side = Dodgers' starter (Snell), who faces the Giants lineup.
    const snell = home.pitcher;
    expect(snell).not.toBeNull();
    expect(snell?.id).toBe(605483);
    expect(snell?.name).toBe("Blake Snell");
    expect(snell?.team).toBe("Los Angeles Dodgers");
    expect(snell?.throws).toBe("L");

    // Rolling window keeps the last 10 starts: the relief outing (gamesStarted
    // !== 1) and the 11th-oldest start both fall outside the window, so the
    // totals are exactly the 10 recent starts (7 K / 25 BF each).
    expect(snell?.rollingStarts).toBe(10);
    expect(snell?.rollingStrikeouts).toBe(70);
    expect(snell?.rollingBattersFaced).toBe(250);
    expect(snell?.rollingBfPerStart).toBe(25);

    // Season and career aggregates come straight from the season/career groups.
    expect(snell?.seasonStrikeouts).toBe(200);
    expect(snell?.seasonBattersFaced).toBe(720);
    expect(snell?.seasonGamesStarted).toBe(30);
    expect(snell?.careerStrikeouts).toBe(1500);
    expect(snell?.careerBattersFaced).toBe(5400);

    // The lineup Snell faces is the Giants, keyed by their handedness splits.
    expect(home.opponent).toEqual({
      team: "San Francisco Giants",
      kPctVsLhp: 300 / 1200,
      kPctVsRhp: 360 / 1800,
    });

    // Away side = Giants' starter (Webb), who faces the Dodgers lineup.
    const webb = away.pitcher;
    expect(webb?.id).toBe(657277);
    expect(webb?.throws).toBe("R");

    // Webb's gameLog omits `battersFaced`, so each start falls back to
    // outs+hits+walks+HBP. Start 1: 18 outs (6.0 IP) +5 +2 +1 = 26.
    // Start 2: 23 outs (7.2 IP) +4 +1 +0 = 28. Start 3: 21 outs field +6 +3 = 30.
    // Start 4 has no IP and no outs → batters-faced unknown → skipped entirely.
    expect(webb?.rollingStarts).toBe(3);
    expect(webb?.rollingBattersFaced).toBe(26 + 28 + 30);
    expect(webb?.rollingStrikeouts).toBe(8 + 9 + 6);
    expect(webb?.rollingBfPerStart).toBe((26 + 28 + 30) / 3);

    expect(webb?.seasonBattersFaced).toBe(690);
    expect(webb?.careerBattersFaced).toBe(4000);

    // The lineup Webb faces is the Dodgers.
    expect(away.opponent).toEqual({
      team: "Los Angeles Dodgers",
      kPctVsLhp: 240 / 1000,
      kPctVsRhp: 330 / 1500,
    });
  });

  it("serves the second call from cache without refetching, keyed by start time", async () => {
    stubFetchRoutes(K_ROUTES);
    // Distinct start time (vs the test above) so this exercises a fresh cache
    // key rather than a pre-populated one from another test.
    const args = ["Los Angeles Dodgers", "San Francisco Giants", "2025-07-02T02:11:00Z"] as const;

    const first = await getMatchupKInputs(...args);
    // 1 schedule + 2 people + 2 team feeds.
    expect(fetch).toHaveBeenCalledTimes(5);

    const second = await getMatchupKInputs(...args);
    expect(fetch).toHaveBeenCalledTimes(5); // no additional fetches: served from cache
    expect(second).toEqual(first);
  });

  it("picks the doubleheader game closest to the requested start time", async () => {
    stubFetchRoutes([
      { contains: "/schedule", payload: loadFixture("schedule-mlb-doubleheader.json") },
      { contains: "/people/477132", payload: loadFixture("people-kstats-kershaw.json") },
      { contains: "/people/592791", payload: loadFixture("people-kstats-ray.json") },
      { contains: "/teams/137/stats", payload: loadFixture("team-kprofile-giants.json") },
      { contains: "/teams/119/stats", payload: loadFixture("team-kprofile-dodgers.json") },
    ]);

    // Requested start is minutes before game 2 (23:40Z), far from game 1 (17:10Z).
    const { home, away } = await getMatchupKInputs(
      "Los Angeles Dodgers",
      "San Francisco Giants",
      "2025-07-04T23:35:00Z",
    );

    // Game 2's starters (Kershaw / Ray), not game 1's (Snell / Webb).
    expect(home.pitcher?.id).toBe(477132);
    expect(home.pitcher?.name).toBe("Clayton Kershaw");
    expect(away.pitcher?.id).toBe(592791);
    expect(away.pitcher?.name).toBe("Robbie Ray");
  });

  it("returns null sides when no scheduled game matches the teams", async () => {
    stubFetchRoutes([
      { contains: "/schedule", payload: loadFixture("schedule-mlb-probable.json") },
    ]);

    const result = await getMatchupKInputs(
      "Boston Red Sox",
      "New York Yankees",
      "2025-07-02T02:10:00Z",
    );

    expect(result).toEqual({
      home: { pitcher: null, opponent: null },
      away: { pitcher: null, opponent: null },
    });
  });
});
