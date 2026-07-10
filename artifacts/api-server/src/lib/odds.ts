import { logger } from "./logger";

const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

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
    regions: "us",
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
