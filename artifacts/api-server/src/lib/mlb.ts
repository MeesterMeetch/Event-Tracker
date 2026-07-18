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

// ---- Pitcher strikeout projection inputs ----

export interface PitcherKStats {
  id: number;
  name: string;
  team: string;
  throws: "L" | "R" | null;
  rollingStrikeouts: number;
  rollingBattersFaced: number;
  rollingStarts: number;
  rollingBfPerStart: number | null;
  /** Decimal innings pitched across the rolling window (e.g. 38.667 for 38⅔ IP). */
  rollingInningsPitched: number | null;
  seasonStrikeouts: number | null;
  seasonBattersFaced: number | null;
  seasonGamesStarted: number | null;
  careerStrikeouts: number | null;
  careerBattersFaced: number | null;
}

export interface OpponentKProfile {
  team: string;
  /** Opponent lineup strikeouts / plate appearances vs LHP. */
  kPctVsLhp: number | null;
  /** Opponent lineup strikeouts / plate appearances vs RHP. */
  kPctVsRhp: number | null;
}

export interface PitcherKMatchupSide {
  pitcher: PitcherKStats | null;
  /** The lineup this pitcher faces (i.e. the *other* team). */
  opponent: OpponentKProfile | null;
}

export interface MatchupKInputs {
  home: PitcherKMatchupSide;
  away: PitcherKMatchupSide;
}

interface PeopleKResponse {
  people?: Array<{
    pitchHand?: { code?: string };
    stats?: Array<{
      type?: { displayName?: string };
      group?: { displayName?: string };
      splits?: Array<StatSplit>;
    }>;
  }>;
}

interface TeamSplitsResponse {
  stats?: Array<{
    splits?: Array<{
      split?: { code?: string };
      stat?: Record<string, unknown>;
    }>;
  }>;
}

/** Parses an innings-pitched string like "6.2" into total outs (20). */
function ipToOuts(ip: string | null): number | null {
  if (!ip) return null;
  const [wholeRaw, fracRaw = "0"] = ip.split(".");
  const whole = Number(wholeRaw);
  const frac = Number(fracRaw);
  if (!Number.isFinite(whole) || !Number.isFinite(frac)) return null;
  return whole * 3 + frac;
}

/** Batters faced for one start, falling back to outs+hits+walks+HBP if absent. */
function battersFacedFrom(stat: Record<string, unknown>): number | null {
  const bf = int(stat.battersFaced);
  if (bf != null && bf > 0) return bf;
  const outs = int(stat.outs) ?? ipToOuts(str(stat.inningsPitched));
  if (outs == null) return null;
  const hits = int(stat.hits) ?? 0;
  const walks = int(stat.baseOnBalls) ?? 0;
  const hbp = int(stat.hitByPitch) ?? 0;
  return outs + hits + walks + hbp;
}

/** How many recent starts feed the rolling strikeout-rate window. */
const ROLLING_START_WINDOW = 10;

async function fetchPitcherKStats(personId: number, name: string, team: string, season: number): Promise<PitcherKStats> {
  const stats: PitcherKStats = {
    id: personId,
    name,
    team,
    throws: null,
    rollingStrikeouts: 0,
    rollingBattersFaced: 0,
    rollingStarts: 0,
    rollingBfPerStart: null,
    rollingInningsPitched: null,
    seasonStrikeouts: null,
    seasonBattersFaced: null,
    seasonGamesStarted: null,
    careerStrikeouts: null,
    careerBattersFaced: null,
  };

  try {
    const data = await mlbFetch<PeopleKResponse>(
      `/people/${personId}?hydrate=stats(group=[pitching],type=[season,career,gameLog],season=${season})`,
    );
    const person = data.people?.[0];
    const hand = person?.pitchHand?.code;
    stats.throws = hand === "L" ? "L" : hand === "R" ? "R" : null;

    for (const group of person?.stats ?? []) {
      const type = group.type?.displayName;
      const splits = group.splits ?? [];

      if (type === "season" && splits[0]?.stat) {
        const s = splits[0].stat;
        stats.seasonStrikeouts = int(s.strikeOuts);
        stats.seasonBattersFaced = int(s.battersFaced);
        stats.seasonGamesStarted = int(s.gamesStarted);
      }

      if (type === "career" && splits[0]?.stat) {
        const s = splits[0].stat;
        stats.careerStrikeouts = int(s.strikeOuts);
        stats.careerBattersFaced = int(s.battersFaced);
      }

      if (type === "gameLog") {
        const starts = splits.filter((sp) => int(sp.stat?.gamesStarted) === 1).slice(-ROLLING_START_WINDOW);
        let so = 0;
        let bf = 0;
        let n = 0;
        let totalOuts = 0;
        let hasIp = false;
        for (const sp of starts) {
          const st = sp.stat ?? {};
          const b = battersFacedFrom(st);
          if (b == null) continue;
          so += int(st.strikeOuts) ?? 0;
          bf += b;
          n += 1;
          const outs = ipToOuts(str(st.inningsPitched));
          if (outs != null) { totalOuts += outs; hasIp = true; }
        }
        stats.rollingStrikeouts = so;
        stats.rollingBattersFaced = bf;
        stats.rollingStarts = n;
        stats.rollingBfPerStart = n > 0 ? bf / n : null;
        stats.rollingInningsPitched = hasIp ? totalOuts / 3 : null;
      }
    }
  } catch (err) {
    logger.warn({ err, personId }, "mlb: failed to fetch pitcher K stats");
  }

  return stats;
}

async function fetchTeamKProfile(teamId: number, teamName: string, season: number): Promise<OpponentKProfile> {
  const profile: OpponentKProfile = { team: teamName, kPctVsLhp: null, kPctVsRhp: null };

  try {
    const data = await mlbFetch<TeamSplitsResponse>(
      `/teams/${teamId}/stats?stats=statSplits&group=hitting&sitCodes=vl,vr&season=${season}&sportId=${MLB_SPORT_ID}`,
    );
    for (const g of data.stats ?? []) {
      for (const sp of g.splits ?? []) {
        const code = sp.split?.code;
        const so = int(sp.stat?.strikeOuts);
        const pa = int(sp.stat?.plateAppearances);
        if (so == null || pa == null || pa <= 0) continue;
        if (code === "vl") profile.kPctVsLhp = so / pa;
        if (code === "vr") profile.kPctVsRhp = so / pa;
      }
    }
  } catch (err) {
    logger.warn({ err, teamId }, "mlb: failed to fetch team K profile");
  }

  return profile;
}

// Projection inputs change slowly (probable starters + season splits), so cache
// per game for a few minutes to avoid re-fetching on repeated model scans.
const K_INPUTS_CACHE_TTL_MS = 10 * 60 * 1000;
const kInputsCache = new Map<string, { data: MatchupKInputs; expires: number }>();

/**
 * Assembles the strikeout-projection inputs for both probable starters in an
 * MLB matchup: each pitcher's rolling/season/career K rate and workload, plus
 * the opposing lineup's handedness strikeout tendency. Returns nulls for any
 * side that can't be resolved (no probable starter announced, etc.).
 */
export async function getMatchupKInputs(homeTeam: string, awayTeam: string, commenceTime: string): Promise<MatchupKInputs> {
  const empty: MatchupKInputs = { home: { pitcher: null, opponent: null }, away: { pitcher: null, opponent: null } };

  try {
    const date = easternDate(commenceTime);
    // Include the event's start time in the key: doubleheaders share the same
    // date + team names, so keying on date alone would serve game 1's starters
    // for game 2 within the TTL. The projection below already resolves the
    // nearest game by time — the key just has to preserve that distinction.
    const cacheKey = `${date}|${norm(homeTeam)}|${norm(awayTeam)}|${new Date(commenceTime).getTime()}`;
    const cached = kInputsCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.data;

    const season = Number(date.slice(0, 4));
    const schedule = await mlbFetch<ScheduleResponse>(`/schedule?sportId=${MLB_SPORT_ID}&date=${date}&hydrate=probablePitcher`);
    const games = schedule.dates?.flatMap((d) => d.games ?? []) ?? [];
    const wanted = new Set([norm(homeTeam), norm(awayTeam)]);

    const matches = games.filter((g) => {
      const h = norm(g.teams?.home?.team?.name ?? "");
      const a = norm(g.teams?.away?.team?.name ?? "");
      return wanted.has(h) && wanted.has(a);
    });
    if (matches.length === 0) return empty;

    const target = new Date(commenceTime).getTime();
    const timeDelta = (g: (typeof matches)[number]) =>
      g.gameDate ? Math.abs(new Date(g.gameDate).getTime() - target) : Number.POSITIVE_INFINITY;
    const game = matches.reduce((best, g) => (timeDelta(g) < timeDelta(best) ? g : best));

    const slots = (["home", "away"] as const).map((side) => {
      const td = game.teams?.[side];
      return {
        teamId: td?.team?.id ?? null,
        teamName: td?.team?.name ?? "",
        pitcherId: td?.probablePitcher?.id ?? null,
        pitcherName: td?.probablePitcher?.fullName ?? null,
      };
    });

    const built = await Promise.all(
      slots.map(async (slot, i) => {
        const opp = slots[1 - i];
        const [pitcher, opponent] = await Promise.all([
          slot.pitcherId && slot.pitcherName
            ? fetchPitcherKStats(slot.pitcherId, slot.pitcherName, slot.teamName, season)
            : Promise.resolve(null),
          opp.teamId ? fetchTeamKProfile(opp.teamId, opp.teamName, season) : Promise.resolve(null),
        ]);
        return { teamName: slot.teamName, side: { pitcher, opponent } satisfies PitcherKMatchupSide };
      }),
    );

    const result: MatchupKInputs = { home: { pitcher: null, opponent: null }, away: { pitcher: null, opponent: null } };
    for (const b of built) {
      const target2 = norm(b.teamName) === norm(homeTeam) ? "home" : "away";
      result[target2] = b.side;
    }

    kInputsCache.set(cacheKey, { data: result, expires: Date.now() + K_INPUTS_CACHE_TTL_MS });
    if (kInputsCache.size > 200) {
      const now = Date.now();
      for (const [k, v] of kInputsCache) if (v.expires <= now) kInputsCache.delete(k);
    }
    return result;
  } catch (err) {
    logger.warn({ err, homeTeam, awayTeam }, "mlb: failed to assemble matchup K inputs");
    return empty;
  }
}

// ---- League stat leaders ----

export interface MlbLeaderEntry {
  rank: number;
  player: string;
  team: string | null;
  value: string;
}

export interface MlbLeaderCategory {
  key: string;
  label: string;
  leaders: MlbLeaderEntry[];
}

interface LeagueLeadersResponse {
  leagueLeaders?: Array<{
    leaderCategory?: string;
    leaders?: Array<{
      rank?: number;
      value?: string | number;
      person?: { fullName?: string };
      team?: { name?: string };
    }>;
  }>;
}

// Strikeouts exists in both hitting and pitching groups, so categories are
// requested per stat group to disambiguate.
const MLB_LEADER_GROUPS: Array<{ statGroup: string; categories: string[] }> = [
  { statGroup: "hitting", categories: ["homeRuns", "battingAverage", "runsBattedIn"] },
  { statGroup: "pitching", categories: ["earnedRunAverage", "strikeouts"] },
];

const MLB_LEADER_LABELS: Record<string, string> = {
  homeRuns: "Home Runs",
  battingAverage: "Batting Avg",
  runsBattedIn: "RBI",
  earnedRunAverage: "ERA",
  strikeouts: "Strikeouts (P)",
};

/** Current-season MLB stat leaders across core hitting/pitching categories. */
export async function fetchMlbLeaders(season: number): Promise<MlbLeaderCategory[]> {
  const out: MlbLeaderCategory[] = [];
  const seen = new Set<string>();

  for (const grp of MLB_LEADER_GROUPS) {
    const data = await mlbFetch<LeagueLeadersResponse>(
      `/stats/leaders?leaderCategories=${grp.categories.join(",")}&statGroup=${grp.statGroup}&sportId=${MLB_SPORT_ID}&season=${season}&limit=5`,
    );

    for (const cat of data.leagueLeaders ?? []) {
      const key = cat.leaderCategory ?? "";
      if (!grp.categories.includes(key) || seen.has(key)) continue;

      const leaders = (cat.leaders ?? [])
        .slice(0, 5)
        .map((l, i): MlbLeaderEntry | null => {
          const player = l.person?.fullName?.trim();
          if (!player || l.value === null || l.value === undefined) return null;
          return {
            rank: l.rank ?? i + 1,
            player,
            team: l.team?.name ?? null,
            value: String(l.value),
          };
        })
        .filter((l): l is MlbLeaderEntry => l !== null);

      if (leaders.length > 0) {
        seen.add(key);
        out.push({ key, label: MLB_LEADER_LABELS[key] ?? key, leaders });
      }
    }
  }

  return out;
}

// ---- Actual strikeout results ----
//
// Uses the same schedule-match + doubleheader disambiguation approach as
// getMatchupPitchers, then reads the boxscore for the pitcher's actual line.
// Returns a discriminated union rather than nulls/zeros so consumers are
// forced to handle every state explicitly (see the "MLB K inputs degrade
// silently" memory note — this API deliberately does NOT repeat that mistake).

interface ScheduleStatusGame {
  gamePk: number;
  gameDate?: string;
  status?: { abstractGameState?: string };
  teams?: {
    home?: { team?: { id?: number; name?: string } };
    away?: { team?: { id?: number; name?: string } };
  };
}

interface ScheduleStatusResponse {
  dates?: Array<{ games?: ScheduleStatusGame[] }>;
}

interface BoxscoreResponse {
  teams?: {
    home?: BoxscoreTeam;
    away?: BoxscoreTeam;
  };
}

interface BoxscoreTeam {
  players?: Record<
    string,
    {
      person?: { id?: number };
      stats?: { pitching?: Record<string, unknown> };
    }
  >;
}

export type PitcherGameResult =
  /** Game is final and the pitcher pitched; strikeouts is his actual total. */
  | { kind: "final"; strikeouts: number; gamePk: number }
  /** Game found but not final yet — retry on a later run. */
  | { kind: "notFinal"; gamePk: number }
  /** Game is final but the pitcher never appeared (scratched / skipped). */
  | { kind: "didNotPitch"; gamePk: number }
  /** No matching game on the schedule for that date and matchup. */
  | { kind: "gameNotFound" };

/**
 * Resolves a pitcher's actual strikeout total for a given matchup. Matches the
 * game the same way getMatchupPitchers does: eastern-date schedule lookup,
 * team-name match, closest scheduled start for doubleheaders.
 */
export async function fetchPitcherGameStrikeouts(
  pitcherId: number,
  homeTeam: string,
  awayTeam: string,
  commenceTime: string,
): Promise<PitcherGameResult> {
  const date = easternDate(commenceTime);
  const schedule = await mlbFetch<ScheduleStatusResponse>(`/schedule?sportId=${MLB_SPORT_ID}&date=${date}`);

  const games = schedule.dates?.flatMap((d) => d.games ?? []) ?? [];
  const wanted = new Set([norm(homeTeam), norm(awayTeam)]);
  const matches = games.filter((g) => {
    const h = norm(g.teams?.home?.team?.name ?? "");
    const a = norm(g.teams?.away?.team?.name ?? "");
    return wanted.has(h) && wanted.has(a);
  });
  if (matches.length === 0) return { kind: "gameNotFound" };

  // Doubleheader disambiguation: closest scheduled start to the logged time.
  const target = new Date(commenceTime).getTime();
  const timeDelta = (g: ScheduleStatusGame) =>
    g.gameDate ? Math.abs(new Date(g.gameDate).getTime() - target) : Number.POSITIVE_INFINITY;
  const game = matches.reduce((best, g) => (timeDelta(g) < timeDelta(best) ? g : best));

  if (game.status?.abstractGameState !== "Final") {
    return { kind: "notFinal", gamePk: game.gamePk };
  }

  const box = await mlbFetch<BoxscoreResponse>(`/game/${game.gamePk}/boxscore`);
  for (const side of ["home", "away"] as const) {
    const players = box.teams?.[side]?.players ?? {};
    for (const player of Object.values(players)) {
      if (player.person?.id !== pitcherId) continue;
      const pitching = player.stats?.pitching;
      // A player entry exists for benched players too; an empty pitching stat
      // block (no battersFaced) means he did not pitch.
      const bf = int(pitching?.battersFaced);
      if (pitching == null || bf == null || bf === 0) {
        return { kind: "didNotPitch", gamePk: game.gamePk };
      }
      const strikeouts = int(pitching.strikeOuts);
      if (strikeouts == null) return { kind: "didNotPitch", gamePk: game.gamePk };
      return { kind: "final", strikeouts, gamePk: game.gamePk };
    }
  }
  return { kind: "didNotPitch", gamePk: game.gamePk };
}
