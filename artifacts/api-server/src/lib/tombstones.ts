import { lt } from "drizzle-orm";
import { db, pitcherKPaperTradesTable } from "@workspace/db";
import { logger } from "./logger";

/**
 * How long a soft-deleted paper trade stays restorable. The client undo window
 * is a few seconds; an hour of server-side slack keeps the affordance forgiving
 * (slow devices, brief offline) without letting invisible rows accumulate.
 */
export const RESTORE_GRACE_MS = 60 * 60 * 1000;

/**
 * Hard-deletes paper-trade tombstones (soft-deleted rows) whose restore grace
 * window has passed, freeing their unique pick slots. Returns how many rows
 * were purged.
 *
 * Called opportunistically on every delete AND on a timer (see
 * startTombstonePurge) — the timer is what guarantees the last tombstones are
 * cleaned up even if the user never deletes anything again.
 */
export async function purgeExpiredPaperTradeTombstones(): Promise<number> {
  const purged = await db
    .delete(pitcherKPaperTradesTable)
    .where(lt(pitcherKPaperTradesTable.deletedAt, new Date(Date.now() - RESTORE_GRACE_MS)))
    .returning();
  return purged.length;
}

const PURGE_INTERVAL_MS = 15 * 60 * 1000;

let running = false;

async function runPurge(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const purged = await purgeExpiredPaperTradeTombstones();
    if (purged > 0) logger.info({ purged }, "tombstones: purged expired paper-trade tombstones");
  } catch (err) {
    logger.error({ err }, "tombstones: purge failed");
  } finally {
    running = false;
  }
}

/**
 * Periodic safety net for tombstone cleanup. Deliberately its own scheduler
 * rather than piggybacking on the model-CLV job: that job never starts when
 * ODDS_API_KEY is missing, and tombstone hygiene must not depend on odds
 * access.
 */
export function startTombstonePurge(): void {
  setInterval(() => void runPurge(), PURGE_INTERVAL_MS);
  setTimeout(() => void runPurge(), 60 * 1000);
  logger.info({ intervalMinutes: PURGE_INTERVAL_MS / 60000 }, "tombstones: purge scheduler started");
}
