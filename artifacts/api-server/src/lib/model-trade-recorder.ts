import { logger } from "./logger";
import type { ModelPitcherProjection } from "./pitcher-k-scanner";

/**
 * Records every measured strikeout line from a slate scan as a paper trade, so
 * the model can eventually be calibrated against its own history.
 *
 * This exists because the calibration loop has every part except its first
 * step. The table, the thirty-minute outcome grader, the model report that
 * fits Platt coefficients and a blend weight, and the config that reads them
 * are all built and working. What was missing is that logging was a button
 * somebody had to press, so the table stayed empty, so the corrections were
 * never fitted, so MODEL_CALIBRATION.blendWeight sat at its default of 1, which
 * means "ignore the market and trust the model". That default is why a scan can
 * flag fifty four of fifty four lines against a liquid market.
 *
 * Everything measured is recorded, not only what the model flagged. A
 * reliability curve needs an unbiased sample across the whole probability
 * range: if only the confident or only the appealing picks are logged, the
 * fitted correction describes the selection rather than the model, and it will
 * be wrong in a way that is very hard to see afterwards. `isFlagged` is stored
 * on each row so the flagged-only view remains available at analysis time.
 */

/**
 * The db package throws at import time when DATABASE_URL is unset, so this must
 * not be imported eagerly. Loading it lazily keeps every test that merely
 * mounts the slate route from having to provision a database.
 */
async function loadDb() {
  const mod = await import("@workspace/db");
  return { db: mod.db, pitcherKPaperTradesTable: mod.pitcherKPaperTradesTable };
}

/**
 * How many logged predictions have graded out. This is the number standing
 * between the model as it is now and a model anyone should size a bet from, so
 * it belongs on screen rather than in a shell script nobody runs.
 *
 * Returns null rather than zero when the database cannot be reached, because
 * "no database" and "no graded trades yet" are different facts and a countdown
 * that silently reads zero on an outage would be a lie in the reassuring
 * direction.
 */
export async function gradedTradeCount(): Promise<number | null> {
  // Same guard as the writer, for the same reason: this is a read, but it is a
  // read against whatever database the shell happens to point at.
  if (process.env.VITEST != null || process.env.NODE_ENV === "test") return null;
  if (!process.env.DATABASE_URL) return null;
  try {
    const { db, pitcherKPaperTradesTable } = await loadDb();
    const { and, isNull, isNotNull, count } = await import("drizzle-orm");
    const rows = await db
      .select({ n: count() })
      .from(pitcherKPaperTradesTable)
      .where(
        and(isNull(pitcherKPaperTradesTable.deletedAt), isNotNull(pitcherKPaperTradesTable.outcome)),
      );
    return rows[0]?.n ?? 0;
  } catch (err) {
    logger.warn({ err }, "model-autolog: could not count graded trades");
    return null;
  }
}

/**
 * On unless explicitly switched off, which is a deliberate departure from
 * ODDS_HISTORY_ENABLED. That one ships off because it writes thousands of rows
 * per scan and belongs to a database bill. This writes tens, and the entire
 * point is to close a loop that has been open since the project started.
 *
 * Never on under a test runner, and that guard is load-bearing rather than
 * belt-and-braces. The DATABASE_URL check below was originally the only gate,
 * on the reasoning that tests run without a database. That holds in CI and in a
 * clean sandbox and is false on a developer machine, where DATABASE_URL is
 * routinely exported for unrelated work. Observed in practice: a local test run
 * opened a connection to an entirely different production database and tried to
 * insert fixture rows into it, and was stopped only by the table not existing
 * there. Pointed at the real database it would have written Blake Snell and
 * Logan Webb into the calibration set this whole feature exists to keep clean.
 *
 * The env is a parameter so this predicate can be tested without the runner's
 * own variables making every case return false.
 */
export function modelAutologEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VITEST != null || env.NODE_ENV === "test") return false;
  if (env.MODEL_AUTOLOG_ENABLED?.trim().toLowerCase() === "false") return false;
  return Boolean(env.DATABASE_URL);
}

export interface PaperTradeRow {
  sport: string;
  gameId: string;
  commenceTime: Date;
  homeTeam: string;
  awayTeam: string;
  pitcher: string;
  team: string;
  opponent: string;
  selection: string;
  point: number;
  book: string;
  americanOdds: number;
  modelProb: number;
  marketProb: number | null;
  edgePercent: number | null;
  isFlagged: boolean;
  expectedStrikeouts: number;
  projectedBattersFaced: number;
  recommendedUnits: number;
  kellyMultiplier: number;
}

/**
 * Flattens projections into insertable rows.
 *
 * Pure and exported so the shaping can be tested without a database.
 *
 * Two exclusions, both matching what the slate route ranks. Starters whose rate
 * inputs were missing or degraded are skipped, because a projection built off
 * the league average is not a prediction and would poison the calibration it is
 * supposed to inform. Lines without a de-vigged market consensus are skipped,
 * because there is nothing to measure the model against.
 */
export function paperTradeRowsFrom(
  projections: ModelPitcherProjection[],
  sport: string,
  kellyMultiplier: number,
): PaperTradeRow[] {
  const rows: PaperTradeRow[] = [];
  for (const p of projections) {
    if (p.insufficientData) continue;
    for (const line of p.lines) {
      if (line.marketProb == null) continue;
      rows.push({
        sport,
        gameId: p.gameId,
        commenceTime: new Date(p.commenceTime),
        homeTeam: p.homeTeam,
        awayTeam: p.awayTeam,
        pitcher: p.pitcher,
        team: p.team,
        opponent: p.opponent,
        selection: line.selection,
        point: line.point,
        book: line.book,
        americanOdds: line.americanOdds,
        modelProb: line.modelProb,
        marketProb: line.marketProb,
        edgePercent: line.edgePercent,
        isFlagged: line.isFlagged,
        expectedStrikeouts: p.expectedStrikeouts,
        projectedBattersFaced: p.projectedBattersFaced,
        recommendedUnits: line.recommendedUnits,
        kellyMultiplier,
      });
    }
  }
  return rows;
}

/**
 * Writes one scan's worth of predictions. Returns rows inserted, or 0 when
 * disabled or on failure.
 *
 * Conflicts are ignored rather than updated. The unique index already covers
 * game, pitcher, selection, point and book, so a rescan of the same slate is a
 * no-op. First observation wins on purpose: a prediction that gets rewritten
 * every time the page is refreshed is no longer a prediction, and ignoring the
 * conflict also means an automatic scan can never overwrite a pick logged by
 * hand.
 */
export async function recordModelPaperTrades(
  projections: ModelPitcherProjection[],
  sport: string,
  kellyMultiplier: number,
): Promise<number> {
  if (!modelAutologEnabled()) return 0;

  const rows = paperTradeRowsFrom(projections, sport, kellyMultiplier);
  if (rows.length === 0) return 0;

  try {
    const { db, pitcherKPaperTradesTable } = await loadDb();
    const inserted = await db
      .insert(pitcherKPaperTradesTable)
      .values(rows)
      .onConflictDoNothing()
      .returning({ id: pitcherKPaperTradesTable.id });
    logger.info(
      { sport, measured: rows.length, inserted: inserted.length },
      "model-autolog: recorded model predictions",
    );
    return inserted.length;
  } catch (err) {
    logger.error({ err, sport, rows: rows.length }, "model-autolog: failed to record");
    return 0;
  }
}

/**
 * Fire-and-forget wrapper. Recording history must never slow down or fail the
 * scan the user actually asked for.
 */
export function recordModelPaperTradesInBackground(
  projections: ModelPitcherProjection[],
  sport: string,
  kellyMultiplier: number,
): void {
  void recordModelPaperTrades(projections, sport, kellyMultiplier).catch(() => {});
}
