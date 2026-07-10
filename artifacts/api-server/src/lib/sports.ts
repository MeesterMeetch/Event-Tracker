export interface SupportedSport {
  key: string;
  title: string;
  group: string;
}

/**
 * Static list of commonly-traded sports (Odds API sport keys). Kept static
 * rather than fetched live so the sport picker never costs an API credit.
 */
export const SUPPORTED_SPORTS: SupportedSport[] = [
  { key: "americanfootball_nfl", title: "NFL", group: "Football" },
  { key: "americanfootball_ncaaf", title: "NCAAF", group: "Football" },
  { key: "basketball_nba", title: "NBA", group: "Basketball" },
  { key: "basketball_ncaab", title: "NCAAB", group: "Basketball" },
  { key: "baseball_mlb", title: "MLB", group: "Baseball" },
  { key: "icehockey_nhl", title: "NHL", group: "Ice Hockey" },
  { key: "soccer_epl", title: "EPL", group: "Soccer" },
  { key: "soccer_usa_mls", title: "MLS", group: "Soccer" },
  { key: "mma_mixed_martial_arts", title: "MMA", group: "MMA" },
];

export function isSupportedSport(key: string): boolean {
  return SUPPORTED_SPORTS.some((s) => s.key === key);
}
