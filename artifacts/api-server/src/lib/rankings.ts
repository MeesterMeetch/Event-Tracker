import { fetchMlbLeaders } from "./mlb";

/**
 * League standings and stat leaders sourced from free public feeds — ESPN's
 * public site APIs for standings (all leagues) and leaders (NFL/NBA/WNBA/NHL),
 * plus the MLB Stats API for MLB leaders. No keys required and zero Odds API
 * credits. Feeds are unofficial, so parsing is defensive throughout: a shape
 * change degrades to missing fields or an upstream error, never a crash.
 */

export interface TeamStanding {
  rank: number;
  team: string;
  record: string;
  wins: number;
  losses: number;
  ties: number | null;
  winPct: string | null;
  gamesBack: string | null;
  points: number | null;
  streak: string | null;
}

export interface StandingsGroup {
  name: string;
  teams: TeamStanding[];
}

export interface LeaderEntry {
  rank: number;
  player: string;
  team: string | null;
  value: string;
}

export interface LeaderCategory {
  key: string;
  label: string;
  leaders: LeaderEntry[];
}

export interface RankingsSport {
  key: string;
  title: string;
  group: string;
}

interface RankingsSource {
  title: string;
  group: string;
  /** Path segment under ESPN's sports APIs, e.g. "baseball/mlb". */
  espnPath: string;
  /** League records read W-L-OTL, third number always shown (NHL). */
  otlRecord?: boolean;
  /** League table runs on points (soccer, NHL) — surface the PTS column. */
  usesPoints?: boolean;
  leaders: { kind: "espn"; categories: string[] } | { kind: "mlb" } | null;
}

const SOURCES: Record<string, RankingsSource> = {
  baseball_mlb: {
    title: "MLB",
    group: "Baseball",
    espnPath: "baseball/mlb",
    leaders: { kind: "mlb" },
  },
  basketball_nba: {
    title: "NBA",
    group: "Basketball",
    espnPath: "basketball/nba",
    leaders: { kind: "espn", categories: ["pointsPerGame", "reboundsPerGame", "assistsPerGame", "stealsPerGame"] },
  },
  basketball_wnba: {
    title: "WNBA",
    group: "Basketball",
    espnPath: "basketball/wnba",
    leaders: { kind: "espn", categories: ["pointsPerGame", "reboundsPerGame", "assistsPerGame", "stealsPerGame"] },
  },
  americanfootball_nfl: {
    title: "NFL",
    group: "American Football",
    espnPath: "football/nfl",
    leaders: { kind: "espn", categories: ["passingYards", "rushingYards", "receivingYards", "sacks"] },
  },
  americanfootball_ncaaf: {
    title: "NCAAF",
    group: "American Football",
    espnPath: "football/college-football",
    leaders: null,
  },
  icehockey_nhl: {
    title: "NHL",
    group: "Ice Hockey",
    espnPath: "hockey/nhl",
    otlRecord: true,
    usesPoints: true,
    leaders: { kind: "espn", categories: ["points", "goals", "assists"] },
  },
  soccer_epl: {
    title: "EPL",
    group: "Soccer",
    espnPath: "soccer/eng.1",
    usesPoints: true,
    leaders: null,
  },
  soccer_usa_mls: {
    title: "MLS",
    group: "Soccer",
    espnPath: "soccer/usa.1",
    usesPoints: true,
    leaders: null,
  },
};

/**
 * Maps an Odds API sport key to its rankings source. Variant keys like
 * americanfootball_nfl_preseason share the base league's standings.
 */
function resolveKey(sportKey: string): string | null {
  if (sportKey in SOURCES) return sportKey;
  const base = Object.keys(SOURCES).find((k) => sportKey.startsWith(`${k}_`));
  return base ?? null;
}

export function rankingsSupported(sportKey: string): boolean {
  return resolveKey(sportKey) !== null;
}

/**
 * Rankings-capable sports. Intentionally independent of the odds in-season
 * list so leagues keep their standings during the off-season.
 */
export function listRankingsSports(): RankingsSport[] {
  return Object.entries(SOURCES)
    .map(([key, s]) => ({ key, title: s.title, group: s.group }))
    .sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title));
}

// Standings move once a day at most; a few hours of caching keeps the page
// instant without hammering the public feeds.
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;

interface CacheSlot<T> {
  data: T;
  expires: number;
}

const standingsCache = new Map<string, CacheSlot<StandingsGroup[]>>();
const leadersCache = new Map<string, CacheSlot<LeaderCategory[]>>();

const ESPN_STANDINGS_BASE = "https://site.api.espn.com/apis/v2/sports";
const ESPN_LEADERS_BASE = "https://site.web.api.espn.com/apis/site/v3/sports";

async function espnFetch<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ESPN request failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

// ---- ESPN standings (site.api v2) — nested league/conference/division tree ----

interface EspnStandingsNode {
  name?: string;
  standings?: { entries?: EspnEntry[] };
  children?: EspnStandingsNode[];
}

interface EspnEntry {
  team?: { displayName?: string };
  stats?: Array<{ name?: string; value?: number; displayValue?: string }>;
}

function numStat(entry: EspnEntry, name: string): number | null {
  const v = entry.stats?.find((s) => s.name === name)?.value;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strStat(entry: EspnEntry, name: string): string | null {
  const v = entry.stats?.find((s) => s.name === name)?.displayValue;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function parseEntry(entry: EspnEntry, idx: number, src: RankingsSource): TeamStanding | null {
  const team = entry.team?.displayName?.trim();
  const wins = numStat(entry, "wins");
  let losses = numStat(entry, "losses");

  // College football has no flat "losses" stat; recover W-L(-T) from the
  // "overall" record summary (e.g. "9-4" or "10-2-1") instead.
  const overall = strStat(entry, "overall")?.match(/^(\d+)-(\d+)(?:-(\d+))?$/) ?? null;
  if (losses === null && overall) losses = Number(overall[2]);

  if (!team || wins === null || losses === null) return null;

  // "ties" covers NFL ties and soccer draws; NHL reports otLosses instead.
  const ties =
    numStat(entry, "ties") ??
    numStat(entry, "otLosses") ??
    (overall?.[3] !== undefined ? Number(overall[3]) : null);
  const rank = numStat(entry, "rank") ?? idx + 1;
  const points = src.usesPoints ? numStat(entry, "points") : null;

  // Compact record for display next to team names: NHL reads W-L-OTL, soccer
  // is clearer as table points (W-L-D order is ambiguous), others read W-L
  // with ties appended only when a league actually has them.
  let record: string;
  if (src.otlRecord) {
    record = `${wins}-${losses}-${ties ?? 0}`;
  } else if (src.usesPoints && points !== null) {
    record = `${points} pts`;
  } else if (ties !== null && ties > 0) {
    record = `${wins}-${losses}-${ties}`;
  } else {
    record = `${wins}-${losses}`;
  }

  return {
    rank: Math.trunc(rank),
    team,
    record,
    wins,
    losses,
    ties,
    winPct: strStat(entry, "winPercent") ?? strStat(entry, "leagueWinPercent"),
    gamesBack: strStat(entry, "gamesBehind"),
    points,
    streak: strStat(entry, "streak"),
  };
}

/** Walks the ESPN tree; any node with entries becomes one standings group. */
function collectGroups(node: EspnStandingsNode, src: RankingsSource, out: StandingsGroup[]): void {
  const entries = node.standings?.entries ?? [];
  if (entries.length > 0) {
    const teams = entries
      .map((e, i) => parseEntry(e, i, src))
      .filter((t): t is TeamStanding => t !== null);
    if (teams.length > 0) {
      out.push({ name: node.name?.trim() || "Standings", teams });
    }
  }
  for (const child of node.children ?? []) {
    collectGroups(child, src, out);
  }
}

export async function getStandings(sportKey: string): Promise<StandingsGroup[]> {
  const key = resolveKey(sportKey);
  const src = key ? SOURCES[key] : undefined;
  if (!key || !src) {
    throw new Error(`No rankings source for sport: ${sportKey}`);
  }

  const cached = standingsCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.data;

  // level=3 asks for division-level grouping where the league has divisions;
  // leagues without them (soccer) return their single table regardless.
  const root = await espnFetch<EspnStandingsNode>(
    `${ESPN_STANDINGS_BASE}/${src.espnPath}/standings?level=3`,
  );
  const groups: StandingsGroup[] = [];
  collectGroups(root, src, groups);
  if (groups.length === 0) {
    throw new Error(`ESPN standings for ${src.espnPath} returned no parseable groups`);
  }

  standingsCache.set(key, { data: groups, expires: Date.now() + CACHE_TTL_MS });
  return groups;
}

// ---- ESPN leaders (site.web.api v3) ----

interface EspnLeadersResponse {
  leaders?: { categories?: EspnLeaderCategory[] };
}

interface EspnLeaderCategory {
  name?: string;
  displayName?: string;
  leaders?: Array<{
    displayValue?: string;
    athlete?: { displayName?: string };
    team?: { displayName?: string; abbreviation?: string };
  }>;
}

function parseEspnLeaders(data: EspnLeadersResponse, wanted: string[]): LeaderCategory[] {
  const all = data.leaders?.categories ?? [];
  const byName = new Map(all.map((c) => [c.name ?? "", c] as const));
  const picked = wanted
    .map((w) => byName.get(w))
    .filter((c): c is EspnLeaderCategory => c !== undefined);
  // If the feed renamed its categories, fall back to whatever it leads with
  // rather than showing nothing.
  const source = picked.length > 0 ? picked : all.slice(0, 4);

  return source
    .map((c): LeaderCategory => ({
      key: c.name ?? "",
      label: c.displayName ?? c.name ?? "Leaders",
      leaders: (c.leaders ?? [])
        .slice(0, 5)
        .map((l, i): LeaderEntry | null => {
          const player = l.athlete?.displayName?.trim();
          const value = l.displayValue?.trim();
          if (!player || !value) return null;
          return {
            rank: i + 1,
            player,
            team: l.team?.displayName ?? l.team?.abbreviation ?? null,
            value,
          };
        })
        .filter((l): l is LeaderEntry => l !== null),
    }))
    .filter((c) => c.leaders.length > 0);
}

export async function getLeaders(sportKey: string): Promise<LeaderCategory[]> {
  const key = resolveKey(sportKey);
  const src = key ? SOURCES[key] : undefined;
  if (!key || !src) {
    throw new Error(`No rankings source for sport: ${sportKey}`);
  }
  if (!src.leaders) return [];

  const cached = leadersCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.data;

  let categories: LeaderCategory[];
  if (src.leaders.kind === "mlb") {
    categories = await fetchMlbLeaders(new Date().getFullYear());
  } else {
    // ESPN's leaders endpoint 500s on limit=10; limit=5 is reliable and five
    // leaders per category is plenty for context cards.
    const data = await espnFetch<EspnLeadersResponse>(
      `${ESPN_LEADERS_BASE}/${src.espnPath}/leaders?limit=5`,
    );
    categories = parseEspnLeaders(data, src.leaders.categories);
  }

  leadersCache.set(key, { data: categories, expires: Date.now() + CACHE_TTL_MS });
  return categories;
}
