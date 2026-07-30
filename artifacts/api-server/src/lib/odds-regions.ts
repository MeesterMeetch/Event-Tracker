/**
 * Which bookmaker regions to request from the odds API.
 *
 * This is a budget control as much as a data setting, because The Odds API
 * charges markets multiplied by regions on every call. Adding a second region
 * doubles the cost of that request. The two call types have very different
 * economics, so they are configured separately rather than sharing one global
 * setting:
 *
 *   Game lines ask for three markets (h2h, spreads, totals) across a whole
 *     slate in one call. Three credits becomes six with a second region. Cheap,
 *     and it buys a sharp anchor on every moneyline, spread and total.
 *   Player props are charged per market per event. An eleven-market NFL request
 *     across a sixteen game slate is 176 credits in one region and 352 in two.
 *     That is where a careless region setting gets expensive.
 *
 * The reason to want EU at all is Pinnacle, which is an EU-region book. It is
 * the sharpest widely-available price and the only genuine sharp anchor
 * reachable through this feed, so a fair-odds consensus that includes it is
 * meaningfully better than one built from US soft books averaging each other.
 *
 * Defaults stay US-only so nothing changes cost without an explicit decision.
 * Set ODDS_REGIONS_LINES=us,eu to switch game lines on, which is the change
 * that pays for itself most easily.
 */

/** Regions understood by the odds API. */
const VALID_REGIONS = new Set(["us", "us2", "uk", "eu", "au"]);

function readRegions(envKey: string, fallback: string): string {
  const raw = process.env[envKey]?.trim().toLowerCase();
  if (!raw) return fallback;
  const parts = raw
    .split(",")
    .map((r) => r.trim())
    .filter((r) => VALID_REGIONS.has(r));
  // An unrecognized value would otherwise silently return no bookmakers at all,
  // which looks identical to a quiet slate. Fall back rather than break.
  return parts.length > 0 ? parts.join(",") : fallback;
}

/** Regions for bulk game-line scans. */
export function lineRegions(): string {
  return readRegions("ODDS_REGIONS_LINES", "us");
}

/** Regions for per-event player prop scans. Costs scale hardest here. */
export function propRegions(): string {
  return readRegions("ODDS_REGIONS_PROPS", "us");
}

/**
 * Credits a request will consume, for logging and for reasoning about budget.
 * The Odds API bills the number of markets multiplied by the number of regions.
 */
export function creditCost(marketCount: number, regions: string): number {
  const regionCount = regions.split(",").filter(Boolean).length;
  return Math.max(1, marketCount) * Math.max(1, regionCount);
}
