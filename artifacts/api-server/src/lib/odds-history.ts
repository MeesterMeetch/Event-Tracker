/**
 * Turning raw odds payloads into stored history, and reading that history back
 * as line movement. Pure functions here; the database write path lives in
 * odds-recorder.ts.
 *
 * Three questions this makes answerable that previously were not:
 *
 *   Where did the line open and how has it moved? Opening price is the single
 *     most useful reference point after the close, and it is only knowable if
 *     something wrote it down at the time.
 *   Which books lead? Without a true sharp book in the feed, the closest
 *     available proxy is watching who moves first and who follows. A book that
 *     consistently moves before the market is carrying information.
 *   Would a rule have worked? Backtesting needs prices as they were, not
 *     prices as they ended up.
 */

import type { OddsEvent } from "./odds";
import { isSharpBook } from "./odds-math";

export interface SnapshotRow {
  sport: string;
  gameId: string;
  commenceTime: Date;
  homeTeam: string;
  awayTeam: string;
  market: string;
  selection: string;
  point: number | null;
  player: string | null;
  book: string;
  bookTitle: string;
  americanOdds: number;
  isSharp: boolean;
}

/**
 * Flattens an odds payload into one row per book per outcome.
 *
 * Every quoted price is kept, not just the ones that produced an edge. That is
 * the point: the prices that did *not* look like value are exactly what a
 * backtest needs in order to ask whether the filter was any good.
 */
export function snapshotRowsFromEvents(events: OddsEvent[], sport: string): SnapshotRow[] {
  const rows: SnapshotRow[] = [];

  for (const event of events) {
    const commenceTime = new Date(event.commence_time);
    for (const bookmaker of event.bookmakers) {
      const sharp = isSharpBook(bookmaker.key);
      for (const market of bookmaker.markets) {
        for (const outcome of market.outcomes) {
          if (typeof outcome.price !== "number" || !Number.isFinite(outcome.price)) continue;
          rows.push({
            sport,
            gameId: event.id,
            commenceTime,
            homeTeam: event.home_team,
            awayTeam: event.away_team,
            market: market.key,
            selection: outcome.name,
            point: outcome.point ?? null,
            // The Odds API carries the player name in `description` on prop
            // markets and omits it on team markets.
            player: outcome.description ?? null,
            book: bookmaker.key,
            bookTitle: bookmaker.title,
            americanOdds: outcome.price,
            isSharp: sharp,
          });
        }
      }
    }
  }

  return rows;
}

/** A stored snapshot, as read back for analysis. */
export interface StoredSnapshot {
  capturedAt: Date | string;
  book: string;
  bookTitle: string;
  americanOdds: number;
  point: number | null;
  isSharp: boolean;
}

export interface LineMovement {
  book: string;
  openedAt: Date;
  openOdds: number;
  openPoint: number | null;
  latestAt: Date;
  latestOdds: number;
  latestPoint: number | null;
  /** Change in American price. Sign is only meaningful within one side. */
  oddsDelta: number;
  /** Change in the line itself, for spreads/totals/props. */
  pointDelta: number | null;
  /** Number of distinct price changes observed. */
  moveCount: number;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Per-book open, latest, and how much moved in between.
 *
 * A "move" counts a change in either the price or the line, so a book that
 * holds -110 while walking a total from 8.5 to 9 is correctly seen as active
 * rather than static.
 */
export function lineMovementByBook(snapshots: StoredSnapshot[]): LineMovement[] {
  const byBook = new Map<string, StoredSnapshot[]>();
  for (const s of snapshots) {
    const list = byBook.get(s.book) ?? [];
    list.push(s);
    byBook.set(s.book, list);
  }

  const movements: LineMovement[] = [];
  for (const [book, list] of byBook) {
    const sorted = [...list].sort((a, b) => toDate(a.capturedAt).getTime() - toDate(b.capturedAt).getTime());
    const first = sorted[0];
    const last = sorted[sorted.length - 1];

    let moveCount = 0;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].americanOdds !== sorted[i - 1].americanOdds || sorted[i].point !== sorted[i - 1].point) {
        moveCount++;
      }
    }

    movements.push({
      book,
      openedAt: toDate(first.capturedAt),
      openOdds: first.americanOdds,
      openPoint: first.point,
      latestAt: toDate(last.capturedAt),
      latestOdds: last.americanOdds,
      latestPoint: last.point,
      oddsDelta: last.americanOdds - first.americanOdds,
      pointDelta: last.point != null && first.point != null ? last.point - first.point : null,
      moveCount,
    });
  }

  return movements.sort((a, b) => b.moveCount - a.moveCount);
}

export interface BookLeadership {
  book: string;
  /** Times this book moved before the market consensus followed. */
  leads: number;
  /** Times this book moved after others had already moved the same way. */
  follows: number;
  /** leads / (leads + follows); above 0.5 means it tends to move first. */
  leadRate: number;
  sampleSize: number;
}

/**
 * Estimates which books move first on a given outcome.
 *
 * Method: find each moment where the market's median price shifted materially,
 * then check which books moved further than the market did (leads) versus which
 * merely kept pace (follows). This is a proxy, not a proof: a book can move
 * first by being wrong as easily as by being informed, so trust it only across
 * a large sample. It is still the best available substitute when the feed
 * carries no genuinely sharp book.
 */
export function bookLeadership(snapshots: StoredSnapshot[], minMoveCents = 5): BookLeadership[] {
  const times = Array.from(new Set(snapshots.map((s) => toDate(s.capturedAt).getTime()))).sort((a, b) => a - b);
  if (times.length < 2) return [];

  const priceAt = new Map<string, Map<number, number>>();
  for (const s of snapshots) {
    const t = toDate(s.capturedAt).getTime();
    const inner = priceAt.get(s.book) ?? new Map<number, number>();
    inner.set(t, s.americanOdds);
    priceAt.set(s.book, inner);
  }

  const books = Array.from(priceAt.keys());
  const tally = new Map<string, { leads: number; follows: number }>();
  for (const b of books) tally.set(b, { leads: 0, follows: 0 });

  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  };

  const consensusAt = (t: number): number | null => {
    const prices = books.map((b) => priceAt.get(b)?.get(t)).filter((v): v is number => v != null);
    return prices.length >= 2 ? median(prices) : null;
  };

  let sampleSize = 0;

  for (let i = 1; i < times.length; i++) {
    const prev = consensusAt(times[i - 1]);
    const curr = consensusAt(times[i]);
    if (prev == null || curr == null) continue;
    const marketMove = curr - prev;
    if (Math.abs(marketMove) < minMoveCents) continue;
    sampleSize++;

    for (const book of books) {
      const before = priceAt.get(book)?.get(times[i - 1]);
      const after = priceAt.get(book)?.get(times[i]);
      if (before == null || after == null) continue;
      const bookMove = after - before;
      if (Math.sign(bookMove) === Math.sign(marketMove) && Math.abs(bookMove) >= minMoveCents) {
        // Moving further than the consensus did is the leadership signal.
        if (Math.abs(bookMove) > Math.abs(marketMove)) tally.get(book)!.leads++;
        else tally.get(book)!.follows++;
      }
    }
  }

  return books
    .map((book) => {
      const { leads, follows } = tally.get(book)!;
      const total = leads + follows;
      return { book, leads, follows, leadRate: total > 0 ? leads / total : 0, sampleSize };
    })
    .sort((a, b) => b.leadRate - a.leadRate);
}

/**
 * Decides which snapshot rows are worth keeping when pruning.
 *
 * Resolution matters most near game time, where the real information sits, and
 * least for a line that sat unchanged three days out. This keeps everything
 * inside `fullResolutionHours` of first pitch, plus a coarse sample of older
 * rows, plus every row where the price actually changed.
 */
export function shouldRetainSnapshot(
  snapshot: { capturedAt: Date | string; commenceTime: Date | string; americanOdds: number },
  previous: { americanOdds: number } | null,
  options: { fullResolutionHours?: number; coarseIntervalMinutes?: number } = {},
): boolean {
  const fullResolutionHours = options.fullResolutionHours ?? 6;
  const coarseIntervalMinutes = options.coarseIntervalMinutes ?? 60;

  // Always keep a genuine price change.
  if (previous != null && previous.americanOdds !== snapshot.americanOdds) return true;

  const captured = toDate(snapshot.capturedAt);
  const commence = toDate(snapshot.commenceTime);
  const hoursOut = (commence.getTime() - captured.getTime()) / 3_600_000;
  if (hoursOut <= fullResolutionHours) return true;

  // Otherwise keep one row per coarse interval.
  const minutes = Math.floor(captured.getTime() / 60_000);
  return minutes % coarseIntervalMinutes === 0;
}
