import { describe, expect, it, vi } from "vitest";

vi.mock("./logger", () => ({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}));

import { buildFootballContext, espnDate, findEvent } from "./football-context";

// Shapes trimmed from the live ESPN NFL scoreboard and summary for
// Falcons at Saints, 2026-10-05.
const EVENT = {
  id: "401872979",
  date: "2026-10-06T00:15Z",
  weather: { displayValue: "Cloudy", temperature: 79 },
  competitions: [
    {
      venue: { indoor: true, fullName: "Caesars Superdome" },
      competitors: [
        {
          homeAway: "home",
          team: { displayName: "New Orleans Saints" },
          records: [
            { type: "total", summary: "1-2" },
            { type: "home", summary: "0-1" },
            { type: "road", summary: "1-1" },
          ],
          leaders: [
            {
              name: "passingLeader",
              leaders: [
                {
                  displayValue: "91/132, 917 YDS, 8 TD, 3 INT",
                  athlete: { fullName: "Tyler Shough", position: { abbreviation: "QB" } },
                },
              ],
            },
          ],
        },
        {
          homeAway: "away",
          team: { displayName: "Atlanta Falcons" },
          records: [
            { type: "total", summary: "1-2" },
            { type: "road", summary: "1-1" },
          ],
          leaders: [],
        },
      ],
    },
  ],
};

const NOW = new Date("2026-10-05T20:00:00Z").getTime();

const SUMMARY = {
  injuries: [
    {
      team: { displayName: "New Orleans Saints" },
      injuries: [
        {
          status: "Questionable",
          date: "2026-10-02T18:00Z",
          athlete: { fullName: "Chris Olave", position: { abbreviation: "WR" } },
          details: { type: "Hamstring" },
        },
        {
          // Stale preseason designation: should be dropped.
          status: "Questionable",
          date: "2026-08-23T03:46Z",
          athlete: { fullName: "Torricelli Simpkins III", position: { abbreviation: "G" } },
          details: { type: "Concussion" },
        },
        {
          // Not a game-status designation: should be dropped.
          status: "Injured Reserve",
          date: "2026-10-01T18:00Z",
          athlete: { fullName: "Someone Else", position: { abbreviation: "LB" } },
        },
      ],
    },
  ],
  lastFiveGames: [
    {
      team: { displayName: "New Orleans Saints" },
      events: [
        { gameDate: "2025-12-21T18:00Z", gameResult: "W", score: "29-6", atVs: "vs", opponent: { abbreviation: "NYJ" } },
        { gameDate: "2026-09-28T17:00Z", gameResult: "L", score: "17-24", atVs: "@", opponent: { abbreviation: "BUF" } },
      ],
    },
  ],
  predictor: { homeTeam: { gameProjection: "48.6" }, awayTeam: { gameProjection: "51" } },
};

describe("espnDate", () => {
  it("keys a Monday night kickoff to the Eastern calendar date", () => {
    expect(espnDate("2026-10-06T00:15:00Z")).toBe("20261005");
  });
});

describe("findEvent", () => {
  it("matches the event by both team names regardless of home/away order", () => {
    const ev = findEvent({ events: [EVENT] }, "New Orleans Saints", "Atlanta Falcons", "2026-10-06T00:15:00Z");
    expect(ev?.id).toBe("401872979");
  });

  it("returns null when the matchup isn't on the board", () => {
    expect(findEvent({ events: [EVENT] }, "Chicago Bears", "Atlanta Falcons", "2026-10-06T00:15:00Z")).toBeNull();
  });
});

describe("buildFootballContext", () => {
  const text = buildFootballContext(EVENT, SUMMARY, "2026-10-06T00:15:00Z", NOW)!;

  it("includes records and the starting QB line", () => {
    expect(text).toContain("New Orleans Saints (1-2 overall, 0-1 at home)");
    expect(text).toContain("Atlanta Falcons (1-2 overall, 1-1 on the road)");
    expect(text).toContain("Passing: Tyler Shough (QB), 91/132, 917 YDS, 8 TD, 3 INT");
  });

  it("keeps recent game-status injuries and drops stale or IR entries", () => {
    expect(text).toContain("Chris Olave WR Questionable (Hamstring)");
    expect(text).not.toContain("Simpkins");
    expect(text).not.toContain("Someone Else");
  });

  it("lists recent results most recent first", () => {
    expect(text).toMatch(/Last 2 \(most recent first\): L 17-24 @ BUF, W 29-6 vs NYJ/);
  });

  it("flags a dome instead of reporting weather", () => {
    expect(text).toContain("Caesars Superdome (indoors");
    expect(text).not.toContain("Forecast");
  });

  it("includes the ESPN predictor", () => {
    expect(text).toContain("home 48.6% / away 51% to win");
  });

  it("still produces scoreboard context when the summary call failed", () => {
    const partial = buildFootballContext(EVENT, null, "2026-10-06T00:15:00Z", NOW)!;
    expect(partial).toContain("Tyler Shough");
    expect(partial).not.toContain("Injury report");
  });

  it("reports outdoor weather when not in a dome", () => {
    const outdoor = {
      ...EVENT,
      competitions: [{ ...EVENT.competitions[0], venue: { indoor: false, fullName: "Soldier Field" } }],
    };
    expect(buildFootballContext(outdoor, null, "2026-10-06T00:15:00Z", NOW)).toContain("Forecast: Cloudy, 79F (outdoors)");
  });

  it("never mentions missing data", () => {
    expect(text.toLowerCase()).not.toMatch(/unknown|not provided|unavailable/);
  });
});
