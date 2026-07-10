import { logger } from "./logger";

/**
 * Lightweight client for MLB's free public Stats API (statsapi.mlb.com).
 * Used to enrich game analysis with probable starting pitchers and their
 * recent form. No API key is required.
 */

const MLB_API_BASE = "https://statsapi.mlb.com/api/v1";
const MLB_SPORT_ID = 1; // MLB

export interface PitcherStart {
  date: string;
  opponent: string;
  inningsPitched: string;
  earnedRuns: number;
  strikeOuts: number;
  walks: number;
  hits: number;
  decision: string;
}

export interface ProbablePitcher {
  id: number;
  name: string;
  team: string;
  seasonEra: string | null;
  seasonRecord: string | null;
  seasonWhip: string | null;
  seasonStrikeouts: number | null;
  inningsPitched: string | null;
  gamesStarted: number | null;
  recentStarts: PitcherStart[];
}

export interface MatchupPitchers {
  home: ProbablePitcher | null;
  away: ProbablePitcher | null;
}

async function mlbFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${MLB_API_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`MLB Stats API request failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/** Returns the YYYY-MM-DD calendar date of an ISO timestamp in US Eastern time. */
function easternDate(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function norm(name: string): string {
  return name.trim().toLowerCase();
}

// ---- Stats API response shapes (partial, defensively parsed) ----

interface ScheduleResponse {
  dates?: Array<{
    games?: Array<{
      gamePk: number;
      gameDate?: string;
      teams?: {
        home?: ScheduleTeam;
        away?: ScheduleTeam;
      };
    }>;
  }>;
}

interface ScheduleTeam {
  team?: { id?: number; name?: string };
  probablePitcher?: { id?: number; fullName?: string };
}

interface PeopleStatsResponse {
  people?: Array<{
    stats?: Array<{
      type?: { displayName?: string };
      group?: { displayName?: string };
      splits?: Array<StatSplit>;
    }>;
  }>;
}

interface StatSplit {
  date?: string;
  opponent?: { name?: string };
  stat?: Record<string, unknown>;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

function int(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Fetches season aggregate + recent starts for a single pitcher. */
async function fetchPitcherProfile(
  personId: number,
  name: string,
  team: string,
  season: number,
): Promise<ProbablePitcher> {
  const profile: ProbablePitcher = {
    id: personId,
    name,
    team,
    seasonEra: null,
    seasonRecord: null,
    seasonWhip: null,
    seasonStrikeouts: null,
    inningsPitched: null,
    gamesStarted: null,
    recentStarts: [],
  };

  try {
    const data = await mlbFetch<PeopleStatsResponse>(
      `/people/${personId}?hydrate=stats(group=[pitching],type=[season,gameLog],season=${season})`,
    );
    const statGroups = data.people?.[0]?.stats ?? [];

    for (const group of statGroups) {
      const type = group.type?.displayName;
      const splits = group.splits ?? [];

      if (type === "season" && splits[0]?.stat) {
        const s = splits[0].stat;
        profile.seasonEra = str(s.era);
        profile.seasonWhip = str(s.whip);
        profile.seasonStrikeouts = int(s.strikeOuts);
        profile.inningsPitched = str(s.inningsPitched);
        profile.gamesStarted = int(s.gamesStarted);
        const wins = int(s.wins);
        const losses = int(s.losses);
        if (wins !== null || losses !== null) {
          profile.seasonRecord = `${wins ?? 0}-${losses ?? 0}`;
        }
      }

      if (type === "gameLog") {
        // gameLog splits are chronological; keep only actual starts, most recent last.
        const starts = splits
          .filter((sp) => int(sp.stat?.gamesStarted) === 1)
          .slice(-5)
          .map((sp): PitcherStart => {
            const s = sp.stat ?? {};
            const w = int(s.wins) ?? 0;
            const l = int(s.losses) ?? 0;
            const decision = w > 0 ? "W" : l > 0 ? "L" : "-";
            return {
              date: sp.date ?? "",
              opponent: sp.opponent?.name ?? "",
              inningsPitched: str(s.inningsPitched) ?? "0.0",
              earnedRuns: int(s.earnedRuns) ?? 0,
              strikeOuts: int(s.strikeOuts) ?? 0,
              walks: int(s.baseOnBalls) ?? 0,
              hits: int(s.hits) ?? 0,
              decision,
            };
          })
          .reverse(); // most recent first
        profile.recentStarts = starts;
      }
    }
  } catch (err) {
    logger.warn({ err, personId }, "mlb: failed to fetch pitcher profile");
  }

  return profile;
}

/**
 * Given an Odds API matchup (team names + kickoff), finds the MLB game on that
 * date and returns each side's probable starting pitcher with recent form.
 * Returns nulls when the game or a probable pitcher can't be resolved.
 */
export async function getMatchupPitchers(
  homeTeam: string,
  awayTeam: string,
  commenceTime: string,
): Promise<MatchupPitchers> {
  const result: MatchupPitchers = { home: null, away: null };

  try {
    const date = easternDate(commenceTime);
    const season = Number(date.slice(0, 4));
    const schedule = await mlbFetch<ScheduleResponse>(
      `/schedule?sportId=${MLB_SPORT_ID}&date=${date}&hydrate=probablePitcher`,
    );

    const games = schedule.dates?.flatMap((d) => d.games ?? []) ?? [];
    const wanted = new Set([norm(homeTeam), norm(awayTeam)]);

    const matches = games.filter((g) => {
      const h = norm(g.teams?.home?.team?.name ?? "");
      const a = norm(g.teams?.away?.team?.name ?? "");
      return wanted.has(h) && wanted.has(a);
    });

    if (matches.length === 0) return result;

    // Disambiguate doubleheaders (same teams, same day) by choosing the
    // scheduled game closest to the requested start time.
    const target = new Date(commenceTime).getTime();
    const timeDelta = (g: (typeof matches)[number]) =>
      g.gameDate ? Math.abs(new Date(g.gameDate).getTime() - target) : Number.POSITIVE_INFINITY;
    const game = matches.reduce((best, g) => (timeDelta(g) < timeDelta(best) ? g : best));

    // Map each Stats API side to the correct home/away slot by team name.
    for (const side of ["home", "away"] as const) {
      const teamData = game.teams?.[side];
      const pitcher = teamData?.probablePitcher;
      const teamName = teamData?.team?.name ?? "";
      if (!pitcher?.id || !pitcher.fullName) continue;

      const profile = await fetchPitcherProfile(pitcher.id, pitcher.fullName, teamName, season);
      const slot = norm(teamName) === norm(homeTeam) ? "home" : "away";
      result[slot] = profile;
    }
  } catch (err) {
    logger.warn({ err, homeTeam, awayTeam }, "mlb: failed to resolve matchup pitchers");
  }

  return result;
}
