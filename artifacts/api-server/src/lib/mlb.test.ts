import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMlbLeaders } from "./mlb";
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
