import { logger } from "./logger";

const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

/**
 * Regions to pull bookmakers from.
 *
 * Line shopping is the most reliable edge available to a small bettor: the
 * same bet at +105 instead of +100 is free money, every time. "us2" adds a
 * second tranche of US books (ESPN Bet, Fanatics, Hard Rock and friends) on
 * top of the "us" set, which widens the price search and finds better numbers.
 *
 * COST: The Odds API charges credits per market PER REGION, so "us,us2"
 * costs twice as much per scan as "us" alone. If credits burn too fast, set
 * ODDS_API_REGIONS=us in the Render dashboard to halve the spend instantly —
 * no code change and no redeploy of anything else.
 */
const DEFAULT_REGIONS = "us,us2";

function regions(): string {
  const configured = process.env.ODDS_API_REGIONS?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_REGIONS;
}

function apiKey(): string {
  const key = process.env.ODDS_API_KEY;
  if (!key) throw new Error("ODDS_API_KEY is not set");
  return key;
}

async function oddsApiFetch<T>(path: string, params: Record<string, string> = {}): Promise<{ data: T; requestsRemaining: number | null }> {
  const url = new URL(`${ODDS_API_BASE}${path}`);
  url.searchParams.set("apiKey", apiKey());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Odds API request failed: ${res.status} ${res.statusText} ${body}`.trim());
  }

  const remainingHeader = res.headers.get("x-requests-remaining");
  const requestsRemaining = remainingHeader != null ? Number(remainingHeader) : null;
  const data = (await res.json()) as T;
  return { data, requestsRemaining: Number.isNaN(requestsRemaining) ? null : requestsRemaining };
}

export interface OddsOutcome {
  name: string;
  price: number;
  point?: number;
  /** Player-prop markets carry the player name here; absent on team markets. */
  description?: string;
}

export interface OddsMarket {
  key: string;
  outcomes: OddsOutcome[];
}

export interface OddsBookmaker {
  key: string;
  title: string;
  markets: OddsMarket[];
}

export interface OddsEvent {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: OddsBookmaker[];
}

/** Fetches current odds for every upcoming event in a sport, across US books. */
export async function fetchOdds(sportKey: string, markets = "h2h,spreads,totals"): Promise<{ data: OddsEvent[]; requestsRemaining: number | null }> {
  return oddsApiFetch<OddsEvent[]>(`/sports/${sportKey}/odds`, {
    regions: regions(),
    markets,
    oddsFormat: "american",
  });
}

export interface OddsSport {
  key: string;
  group: string;
  title: string;
  description: string;
  active: boolean;
  has_outrights: boolean;
}

/**
 * Lists in-season sports/leagues. The /sports endpoint is free — it does not
 * count against the API request quota.
 */
export async function fetchSports(): Promise<OddsSport[]> {
  const { data } = await oddsApiFetch<OddsSport[]>("/sports", { all: "false" });
  return data;
}

export interface EventStub {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
}

/** Lists upcoming events for a sport. Free — does not consume the request quota. */
export async function fetchEvents(sportKey: string): Promise<EventStub[]> {
  const { data } = await oddsApiFetch<EventStub[]>(`/sports/${sportKey}/events`);
  return data;
}

/**
 * Fetches odds for a single event — the only way to access player-prop
 * markets. Unlike the bulk odds endpoint, this is charged per market (x
 * regions) on every call, so callers keep the market list tight.
 */
export async function fetchEventOdds(sportKey: string, eventId: string, markets: string[]): Promise<{ data: OddsEvent; requestsRemaining: number | null }> {
  return oddsApiFetch<OddsEvent>(`/sports/${sportKey}/events/${encodeURIComponent(eventId)}/odds`, {
    regions: regions(),
    markets: markets.join(","),
    oddsFormat: "american",
  });
}

export interface ScoresGame {
  id: string;
  sport_key: string;
  commence_time: string;
  completed: boolean;
  home_team: string;
  away_team: string;
  scores: Array<{ name: string; score: string }> | null;
}

/**
 * Fetches final and in-progress scores. Costs extra credits when daysFrom is
 * supplied (needed to include recently completed games).
 */
export async function fetchScores(sportKey: string, daysFrom = 3): Promise<{ data: ScoresGame[]; requestsRemaining: number | null }> {
  return oddsApiFetch<ScoresGame[]>(`/sports/${sportKey}/scores`, {
    daysFrom: String(daysFrom),
    dateFormat: "iso",
  });
}

export function logRequestsRemaining(context: string, requestsRemaining: number | null): void {
  if (requestsRemaining != null) {
    logger.debug({ context, requestsRemaining }, "odds api: requests remaining");
  }
}
