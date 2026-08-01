import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture, stubFetchRoutes } from "./__fixtures__/index";

/**
 * These tests guard the defensive parsing of ESPN's undocumented public feeds.
 * They mock `fetch` with saved sample payloads and run the real parsers through
 * the public getStandings/getLeaders entry points, so a silent upstream shape
 * change (or a regression in our parsing) fails loudly here instead of in prod.
 *
 * Modules are reset between tests because the rankings module caches results in
 * memory keyed by league; a fresh import per test keeps each case isolated.
 */

async function importRankings() {
  return import("./rankings");
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getStandings", () => {
  it("parses the nested NHL tree with OTL records and a points column", async () => {
    stubFetchRoutes([{ contains: "hockey/nhl/standings", payload: loadFixture("standings-nhl.json") }]);
    const { getStandings } = await importRankings();

    const groups = await getStandings("icehockey_nhl");

    // One group per division node with entries: Atlantic, Metropolitan, Central.
    expect(groups.map((g) => g.name)).toEqual([
      "Atlantic Division",
      "Metropolitan Division",
      "Central Division",
    ]);

    const toronto = groups[0].teams[0];
    expect(toronto.team).toBe("Toronto Maple Leafs");
    // NHL record reads W-L-OTL, with otLosses surfaced as the third number.
    expect(toronto.record).toBe("50-23-9");
    expect(toronto.wins).toBe(50);
    expect(toronto.losses).toBe(23);
    expect(toronto.ties).toBe(9);
    // usesPoints leagues expose the PTS column.
    expect(toronto.points).toBe(109);
    expect(toronto.streak).toBe("L1");
  });

  it("parses a points-based soccer table", async () => {
    stubFetchRoutes([{ contains: "soccer/eng.1/standings", payload: loadFixture("standings-soccer.json") }]);
    const { getStandings } = await importRankings();

    const groups = await getStandings("soccer_epl");

    expect(groups).toHaveLength(1);
    const city = groups[0].teams[0];
    expect(city.team).toBe("Manchester City");
    // Soccer is clearer shown as table points than an ambiguous W-L-D string.
    expect(city.record).toBe("78 pts");
    expect(city.points).toBe(78);
    expect(city.wins).toBe(24);
    expect(city.losses).toBe(4);
    expect(city.ties).toBe(6);
  });

  it("parses MLB divisions with win pct, games back, and streak", async () => {
    stubFetchRoutes([{ contains: "baseball/mlb/standings", payload: loadFixture("standings-mlb.json") }]);
    const { getStandings } = await importRankings();

    const groups = await getStandings("baseball_mlb");

    expect(groups.map((g) => g.name)).toEqual([
      "American League East",
      "National League West",
    ]);
    const yankees = groups[0].teams[0];
    expect(yankees.team).toBe("New York Yankees");
    expect(yankees.record).toBe("58-35");
    expect(yankees.wins).toBe(58);
    expect(yankees.losses).toBe(35);
    expect(yankees.ties).toBeNull();
    expect(yankees.points).toBeNull();
    expect(yankees.winPct).toBe(".624");
    expect(yankees.gamesBack).toBe("-");
    expect(yankees.streak).toBe("W2");

    const rays = groups[0].teams[1];
    expect(rays.gamesBack).toBe("2.0");
    // No "rank" stat in the feed → position falls back to row order.
    expect(rays.rank).toBe(2);
  });

  it("recovers NCAAF losses (and ties) from the overall record string", async () => {
    stubFetchRoutes([
      { contains: "football/college-football/standings", payload: loadFixture("standings-ncaaf.json") },
    ]);
    const { getStandings } = await importRankings();

    const groups = await getStandings("americanfootball_ncaaf");

    expect(groups.map((g) => g.name)).toEqual([
      "Southeastern Conference",
      "Big Ten Conference",
    ]);

    // Georgia's feed entry has "wins" but no flat "losses" stat — losses must be
    // recovered from overall "12-2".
    const georgia = groups[0].teams[0];
    expect(georgia.team).toBe("Georgia Bulldogs");
    expect(georgia.wins).toBe(12);
    expect(georgia.losses).toBe(2);
    expect(georgia.ties).toBeNull();
    expect(georgia.record).toBe("12-2");

    // Alabama's overall "10-2-1" carries a tie, which should surface in W-L-T.
    const alabama = groups[0].teams[1];
    expect(alabama.wins).toBe(10);
    expect(alabama.losses).toBe(2);
    expect(alabama.ties).toBe(1);
    expect(alabama.record).toBe("10-2-1");
  });

  it("throws loudly when the feed yields no parseable groups", async () => {
    // Entries missing the team name can't be parsed → no group survives.
    stubFetchRoutes([
      {
        contains: "baseball/mlb/standings",
        payload: {
          name: "MLB",
          standings: { entries: [{ stats: [{ name: "wins", value: 1 }] }] },
        },
      },
    ]);
    const { getStandings } = await importRankings();

    await expect(getStandings("baseball_mlb")).rejects.toThrow(/no parseable groups/);
  });

  it("propagates an upstream HTTP error", async () => {
    stubFetchRoutes([
      { contains: "hockey/nhl/standings", payload: {}, status: 503 },
    ]);
    const { getStandings } = await importRankings();

    await expect(getStandings("icehockey_nhl")).rejects.toThrow(/ESPN request failed: 503/);
  });
});

describe("getLeaders", () => {
  it("picks exactly the requested ESPN categories, in order, skipping extras", async () => {
    stubFetchRoutes([{ contains: "football/nfl/leaders", payload: loadFixture("leaders-espn-nfl.json") }]);
    const { getLeaders } = await importRankings();

    const cats = await getLeaders("americanfootball_nfl");

    // "totalTackles" sits between the wanted categories in the feed but must be
    // filtered out; wanted order is passing/rushing/receiving/sacks.
    expect(cats.map((c) => c.key)).toEqual([
      "passingYards",
      "rushingYards",
      "receivingYards",
      "sacks",
    ]);
    const passing = cats[0];
    expect(passing.label).toBe("Passing Yards");
    expect(passing.leaders[0]).toEqual({
      rank: 1,
      player: "Matthew Stafford",
      team: "Los Angeles Rams",
      value: "4707",
    });
  });

  it("falls back to the feed's leading categories when names are renamed", async () => {
    stubFetchRoutes([{ contains: "football/nfl/leaders", payload: loadFixture("leaders-espn-renamed.json") }]);
    const { getLeaders } = await importRankings();

    const cats = await getLeaders("americanfootball_nfl");

    // None of the requested category names exist, so we show what the feed
    // leads with rather than an empty section.
    expect(cats.map((c) => c.key)).toEqual([
      "passingYardsPerGame",
      "rushingYardsPerGame",
    ]);
    expect(cats[0].leaders[0].player).toBe("Matthew Stafford");
  });

  it("caches a transient empty leaders response only briefly so it recovers fast", async () => {
    vi.useFakeTimers();
    try {
      // ESPN hiccups with an empty-but-valid payload for a league that should
      // have leaders.
      stubFetchRoutes([{ contains: "football/nfl/leaders", payload: { leaders: { categories: [] } } }]);
      const { getLeaders } = await importRankings();

      expect(await getLeaders("americanfootball_nfl")).toEqual([]);

      // Feed recovers with real data.
      stubFetchRoutes([{ contains: "football/nfl/leaders", payload: loadFixture("leaders-espn-nfl.json") }]);

      // Within the short empty-TTL the cached empty is still served, so a
      // flurry of requests can't hammer ESPN while it's down.
      vi.advanceTimersByTime(60 * 1000);
      expect(await getLeaders("americanfootball_nfl")).toEqual([]);

      // But well before the 3h standings TTL, the empty expires and the real
      // leaders come back — no hours-long stale-empty window.
      vi.advanceTimersByTime(5 * 60 * 1000);
      const cats = await getLeaders("americanfootball_nfl");
      expect(cats.map((c) => c.key)).toEqual([
        "passingYards",
        "rushingYards",
        "receivingYards",
        "sacks",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps caching a non-empty leaders response for the full TTL", async () => {
    vi.useFakeTimers();
    try {
      const calls = { n: 0 };
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          calls.n += 1;
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => loadFixture("leaders-espn-nfl.json"),
          } as Response;
        }),
      );
      const { getLeaders } = await importRankings();

      await getLeaders("americanfootball_nfl");
      // Past the short empty-TTL but within the 3h TTL: a populated result is
      // still served from cache, so we don't re-fetch on the short cadence.
      vi.advanceTimersByTime(10 * 60 * 1000);
      await getLeaders("americanfootball_nfl");
      expect(calls.n).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
