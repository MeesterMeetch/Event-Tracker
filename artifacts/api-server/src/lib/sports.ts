import { fetchSports } from "./odds";
import { sportSupportsProps } from "./props";
import { logger } from "./logger";

export interface SupportedSport {
  key: string;
  title: string;
  group: string;
  supportsProps: boolean;
}

/**
 * Fallback list used only when the Odds API sports lookup is unavailable, so
 * the picker still works offline. The live in-season list is always preferred.
 */
const FALLBACK_SPORTS: SupportedSport[] = [
  { key: "americanfootball_nfl", title: "NFL", group: "American Football" },
  { key: "americanfootball_ncaaf", title: "NCAAF", group: "American Football" },
  { key: "basketball_nba", title: "NBA", group: "Basketball" },
  { key: "baseball_mlb", title: "MLB", group: "Baseball" },
  { key: "icehockey_nhl", title: "NHL", group: "Ice Hockey" },
  { key: "soccer_epl", title: "EPL", group: "Soccer" },
  { key: "soccer_usa_mls", title: "MLS", group: "Soccer" },
  { key: "mma_mixed_martial_arts", title: "MMA", group: "Mixed Martial Arts" },
].map((s) => ({ ...s, supportsProps: sportSupportsProps(s.key) }));

// The Odds API /sports endpoint is free (it does not consume the request
// quota), but the in-season set changes slowly, so cache it to avoid needless
// round-trips on every picker open.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
let cache: { data: SupportedSport[]; expires: number } | null = null;

/**
 * The sports the picker offers: every in-season, game-level sport the Odds API
 * currently lists. Futures / outright-only markets (championship winners,
 * elections, etc.) are excluded because the edge scanner works on per-game
 * h2h/spreads/totals markets, not outrights.
 */
export async function getSupportedSports(): Promise<SupportedSport[]> {
  if (cache && cache.expires > Date.now()) return cache.data;

  try {
    const raw = await fetchSports();
    const list = raw
      .filter((s) => s.active && !s.has_outrights)
      .map((s) => ({ key: s.key, title: s.title, group: s.group, supportsProps: sportSupportsProps(s.key) }))
      .sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title));

    if (list.length > 0) {
      cache = { data: list, expires: Date.now() + CACHE_TTL_MS };
      return list;
    }
  } catch (err) {
    logger.warn({ err }, "sports: live lookup failed; using fallback list");
  }

  return cache?.data ?? FALLBACK_SPORTS;
}

export async function isSupportedSport(key: string): Promise<boolean> {
  const list = await getSupportedSports();
  return list.some((s) => s.key === key);
}
