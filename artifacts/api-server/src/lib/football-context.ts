import { logger } from "./logger";

/**
 * Pregame football context for the game-analysis prompt, pulled from ESPN's
 * public site API (the same feed rankings.ts already uses). Without this the
 * analysis model had nothing to reason from but the price, so every NFL and
 * college write-up came back as "no QB, pace, or injury data provided."
 *
 * Two calls per game, both cached:
 *   scoreboard  -> event id, records, season stat leaders (QB/RB/WR), weather, dome
 *   summary     -> injury report, last five results per team, ESPN win projection
 *
 * Everything is best-effort. Any failure returns null and the analysis falls
 * back to market-only reasoning; a missing field is simply left out of the
 * text rather than rendered as "unknown", so the model never sees (and never
 * repeats) a list of things it doesn't have.
 */

const ESPN_SITE = "https://site.api.espn.com/apis/site/v2/sports";
const CACHE_TTL_MS = 20 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
/** Injury designations older than this are usually stale preseason entries. */
const INJURY_MAX_AGE_MS = 21 * 24 * 60 * 60 * 1000;
const RELEVANT_INJURY_STATUSES = new Set(["out", "doubtful", "questionable"]);

const ESPN_PATHS: Record<string, string> = {
  americanfootball_nfl: "football/nfl",
  americanfootball_nfl_preseason: "football/nfl",
  americanfootball_ncaaf: "football/college-football",
};

// ---- Partial ESPN shapes, parsed defensively ----

interface EspnLeader {
  displayValue?: string;
  athlete?: { fullName?: string; position?: { abbreviation?: string } };
}

interface EspnCompetitor {
  homeAway?: string;
  team?: { displayName?: string };
  records?: Array<{ type?: string; summary?: string }>;
  leaders?: Array<{ name?: string; leaders?: EspnLeader[] }>;
}

interface EspnEvent {
  id?: string;
  date?: string;
  weather?: { displayValue?: string; temperature?: number };
  competitions?: Array<{
    venue?: { indoor?: boolean; fullName?: string };
    competitors?: EspnCompetitor[];
  }>;
}

interface EspnScoreboard {
  events?: EspnEvent[];
}

interface EspnInjury {
  status?: string;
  date?: string;
  athlete?: { fullName?: string; position?: { abbreviation?: string } };
  details?: { type?: string };
}

interface EspnLastFive {
  team?: { displayName?: string };
  events?: Array<{
    gameDate?: string;
    gameResult?: string;
    score?: string;
    atVs?: string;
    opponent?: { displayName?: string; abbreviation?: string };
  }>;
}

interface EspnSummary {
  injuries?: Array<{ team?: { displayName?: string }; injuries?: EspnInjury[] }>;
  lastFiveGames?: EspnLastFive[];
  predictor?: {
    homeTeam?: { gameProjection?: string };
    awayTeam?: { gameProjection?: string };
  };
}

// ---- Pure helpers (exported for tests) ----

function norm(name: string): string {
  return name.trim().toLowerCase();
}

/** ESPN keys its scoreboard by US Eastern calendar date, as YYYYMMDD. */
export function espnDate(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}`;
}

/** Finds the scoreboard event for this matchup, nearest kickoff wins. */
export function findEvent(
  board: EspnScoreboard,
  homeTeam: string,
  awayTeam: string,
  commenceTime: string,
): EspnEvent | null {
  const wanted = new Set([norm(homeTeam), norm(awayTeam)]);
  const matches = (board.events ?? []).filter((ev) => {
    const names = ev.competitions?.[0]?.competitors?.map((c) => norm(c.team?.displayName ?? "")) ?? [];
    return names.length === 2 && names.every((n) => wanted.has(n));
  });
  if (matches.length === 0) return null;
  const target = new Date(commenceTime).getTime();
  const delta = (ev: EspnEvent) =>
    ev.date ? Math.abs(new Date(ev.date).getTime() - target) : Number.POSITIVE_INFINITY;
  return matches.reduce((best, ev) => (delta(ev) < delta(best) ? ev : best));
}

function describeTeam(c: EspnCompetitor): string[] {
  const name = c.team?.displayName ?? "Unknown team";
  const rec = (type: string) => c.records?.find((r) => r.type === type)?.summary;
  const overall = rec("total");
  const split = c.homeAway === "home" ? rec("home") : rec("road");
  const recordBits = [overall && `${overall} overall`, split && `${split} ${c.homeAway === "home" ? "at home" : "on the road"}`]
    .filter(Boolean)
    .join(", ");

  const lines = [`${name}${recordBits ? ` (${recordBits})` : ""}`];
  const labels: Record<string, string> = {
    passingLeader: "Passing",
    rushingLeader: "Rushing",
    receivingLeader: "Receiving",
  };
  for (const cat of c.leaders ?? []) {
    const label = cat.name ? labels[cat.name] : undefined;
    const top = cat.leaders?.[0];
    if (!label || !top?.athlete?.fullName || !top.displayValue) continue;
    const pos = top.athlete.position?.abbreviation;
    lines.push(`  ${label}: ${top.athlete.fullName}${pos ? ` (${pos})` : ""}, ${top.displayValue}`);
  }
  return lines;
}

function describeInjuries(summary: EspnSummary, teamName: string, now: number): string | null {
  const block = summary.injuries?.find((b) => norm(b.team?.displayName ?? "") === norm(teamName));
  const relevant = (block?.injuries ?? []).filter((inj) => {
    const status = norm(inj.status ?? "");
    if (!RELEVANT_INJURY_STATUSES.has(status)) return false;
    const dated = inj.date ? new Date(inj.date).getTime() : NaN;
    return !Number.isFinite(dated) || now - dated <= INJURY_MAX_AGE_MS;
  });
  if (relevant.length === 0) return null;
  const parts = relevant.slice(0, 12).map((inj) => {
    const pos = inj.athlete?.position?.abbreviation;
    const what = inj.details?.type;
    return `${inj.athlete?.fullName ?? "?"}${pos ? ` ${pos}` : ""} ${inj.status}${what ? ` (${what})` : ""}`;
  });
  return `  Injury report: ${parts.join("; ")}`;
}

function describeLastFive(summary: EspnSummary, teamName: string, beforeIso: string): string | null {
  const block = summary.lastFiveGames?.find((b) => norm(b.team?.displayName ?? "") === norm(teamName));
  const before = new Date(beforeIso).getTime();
  const games = (block?.events ?? [])
    .filter((g) => g.gameDate && new Date(g.gameDate).getTime() < before && g.gameResult && g.score)
    .sort((a, b) => new Date(b.gameDate!).getTime() - new Date(a.gameDate!).getTime())
    .slice(0, 5);
  if (games.length === 0) return null;
  const parts = games.map(
    (g) => `${g.gameResult} ${g.score} ${g.atVs ?? "vs"} ${g.opponent?.abbreviation ?? g.opponent?.displayName ?? "?"}`,
  );
  return `  Last ${games.length} (most recent first): ${parts.join(", ")}`;
}

/**
 * Renders the scoreboard event plus summary into prompt text. Only lines with
 * real data are emitted. Returns null if there's nothing beyond team names.
 */
export function buildFootballContext(
  event: EspnEvent,
  summary: EspnSummary | null,
  commenceTime: string,
  now = Date.now(),
): string | null {
  const comp = event.competitions?.[0];
  const competitors = comp?.competitors ?? [];
  const ordered = [
    competitors.find((c) => c.homeAway === "away"),
    competitors.find((c) => c.homeAway === "home"),
  ].filter((c): c is EspnCompetitor => c != null);

  const lines: string[] = [];
  for (const c of ordered) {
    lines.push(...describeTeam(c));
    if (summary && c.team?.displayName) {
      const inj = describeInjuries(summary, c.team.displayName, now);
      if (inj) lines.push(inj);
      const form = describeLastFive(summary, c.team.displayName, commenceTime);
      if (form) lines.push(form);
    }
  }

  if (comp?.venue?.indoor) {
    lines.push(`Venue: ${comp.venue.fullName ?? "dome"} (indoors, weather not a factor)`);
  } else if (event.weather?.displayValue || event.weather?.temperature != null) {
    const temp = event.weather.temperature != null ? `${event.weather.temperature}F` : "";
    lines.push(`Forecast: ${[event.weather.displayValue, temp].filter(Boolean).join(", ")} (outdoors)`);
  }

  const homeProj = summary?.predictor?.homeTeam?.gameProjection;
  const awayProj = summary?.predictor?.awayTeam?.gameProjection;
  if (homeProj && awayProj) {
    lines.push(`ESPN matchup predictor: home ${homeProj}% / away ${awayProj}% to win`);
  }

  // Team names alone carry nothing the prompt doesn't already have.
  const informative = lines.filter((l) => l.startsWith("  ") || l.startsWith("Venue") || l.startsWith("Forecast") || l.startsWith("ESPN"));
  return informative.length > 0 ? lines.join("\n") : null;
}

// ---- I/O ----

const cache = new Map<string, { value: string | null; expires: number }>();

async function espnJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`ESPN request failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export function isFootballSport(sport: string): boolean {
  return sport in ESPN_PATHS;
}

/**
 * Fetches and renders football context for one game. Never throws: returns
 * null when the sport isn't football, the game can't be matched, or ESPN is
 * unreachable. A failed summary call still yields scoreboard-only context.
 */
export async function getFootballContext(
  sport: string,
  homeTeam: string,
  awayTeam: string,
  commenceTime: string,
): Promise<string | null> {
  const path = ESPN_PATHS[sport];
  if (!path) return null;

  const key = `${sport}|${homeTeam}|${awayTeam}|${commenceTime}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  let value: string | null = null;
  try {
    // College scoreboards default to ranked games only; groups=80 is all of FBS.
    const extra = path.includes("college") ? "&groups=80&limit=400" : "";
    const board = await espnJson<EspnScoreboard>(
      `${ESPN_SITE}/${path}/scoreboard?dates=${espnDate(commenceTime)}${extra}`,
    );
    const event = findEvent(board, homeTeam, awayTeam, commenceTime);
    if (!event?.id) {
      logger.info({ sport, homeTeam, awayTeam }, "football-context: no ESPN event matched");
    } else {
      let summary: EspnSummary | null = null;
      try {
        summary = await espnJson<EspnSummary>(`${ESPN_SITE}/${path}/summary?event=${event.id}`);
      } catch (err) {
        logger.warn({ err, eventId: event.id }, "football-context: summary fetch failed");
      }
      value = buildFootballContext(event, summary, commenceTime);
    }
  } catch (err) {
    logger.warn({ err, sport, homeTeam, awayTeam }, "football-context: scoreboard fetch failed");
  }

  if (cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
  }
  // A miss is usually transient (ESPN hiccup, scoreboard not posted yet), so
  // only hold it briefly; real context holds for the full TTL.
  cache.set(key, { value, expires: Date.now() + (value ? CACHE_TTL_MS : 3 * 60 * 1000) });
  return value;
}
