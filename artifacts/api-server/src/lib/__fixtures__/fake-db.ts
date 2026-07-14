import { vi } from "vitest";

/**
 * An in-memory stand-in for the `@workspace/db` drizzle handle, used by the
 * bet-tracking route/settlement tests. The real routes talk to Postgres via
 * drizzle's fluent builder; wiring a live database into a unit test would make
 * these tests slow, order-dependent, and destructive to the dev data. Instead
 * we replay the exact builder chains the routes use against plain arrays.
 *
 * Because we can't introspect a real drizzle `eq()`/`desc()` SQL object, the
 * companion `stubDrizzleOrm()` replaces those two helpers with plain
 * descriptors this fake understands. Only the chains the routes actually use
 * are supported:
 *   select().from(t)[.where(eq)][.orderBy(desc)]
 *   insert(t).values(v).returning()
 *   update(t).set(v).where(eq)[.returning()]
 *   delete(t).where(eq).returning()
 */

const BETS_COLS = [
  "id",
  "sport",
  "gameId",
  "commenceTime",
  "homeTeam",
  "awayTeam",
  "market",
  "selection",
  "point",
  "americanOdds",
  "units",
  "fairOdds",
  "evPercent",
  "book",
  "closingOdds",
  "clvPercent",
  "status",
  "pnl",
  "notes",
  "deletedAt",
  "createdAt",
] as const;

const PAPER_COLS = [
  "id",
  "sport",
  "gameId",
  "commenceTime",
  "homeTeam",
  "awayTeam",
  "pitcher",
  "pitcherId",
  "team",
  "opponent",
  "selection",
  "point",
  "book",
  "americanOdds",
  "modelProb",
  "marketProb",
  "edgePercent",
  "isFlagged",
  "expectedStrikeouts",
  "projectedBattersFaced",
  "recommendedUnits",
  "kellyMultiplier",
  "closingOdds",
  "closingProb",
  "clvPercent",
  "beatClose",
  "status",
  "deletedAt",
  "createdAt",
] as const;

type Row = Record<string, unknown>;
type Cond =
  | { __op: "eq"; col: string; val: unknown }
  | { __op: "ne"; col: string; val: unknown }
  | { __op: "isNull"; col: string }
  | { __op: "isNotNull"; col: string }
  | { __op: "lt"; col: string; val: unknown }
  | { __op: "lte"; col: string; val: unknown }
  | { __op: "gt"; col: string; val: unknown }
  | { __op: "gte"; col: string; val: unknown }
  | { __op: "inArray"; col: string; vals: unknown[] }
  | { __op: "and"; conds: Cond[] }
  | { __op: "or"; conds: Cond[] }
  | null;
type Order = { __op: "desc"; col: string } | null;

interface TableMarker {
  __table: string;
  [column: string]: string;
}

function marker(name: string, cols: readonly string[]): TableMarker {
  const m: TableMarker = { __table: name };
  for (const c of cols) m[c] = c;
  return m;
}

export interface FakeDbModule {
  db: unknown;
  betsTable: TableMarker;
  pitcherKPaperTradesTable: TableMarker;
  /** Live view of the backing arrays, keyed by SQL table name. */
  __stores: { bets: Row[]; pitcher_k_paper_trades: Row[] };
  /** Inserts a bet row, filling unset columns with null and assigning an id. */
  __seedBet: (row: Row) => Row;
  /** Inserts a paper-trade row, filling unset columns with null. */
  __seedPaperTrade: (row: Row) => Row;
  /** Empties both tables and resets the id sequence between tests. */
  __reset: () => void;
}

export function makeFakeDb(): FakeDbModule {
  const stores: { bets: Row[]; pitcher_k_paper_trades: Row[] } = {
    bets: [],
    pitcher_k_paper_trades: [],
  };
  const seq: Record<string, number> = { bets: 0, pitcher_k_paper_trades: 0 };
  const colsByTable: Record<string, readonly string[]> = {
    bets: BETS_COLS,
    pitcher_k_paper_trades: PAPER_COLS,
  };

  const nameOf = (t: TableMarker): string => t.__table;

  const matchesCond = (row: Row, cond: Cond): boolean => {
    if (!cond) return true;
    switch (cond.__op) {
      case "eq":
        return row[cond.col] === cond.val;
      case "ne":
        // SQL semantics: NULL <> x is never true.
        return row[cond.col] != null && cond.val != null && row[cond.col] !== cond.val;
      case "isNull":
        return row[cond.col] == null;
      case "isNotNull":
        return row[cond.col] != null;
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        // SQL semantics: comparisons against NULL are never true, so a null
        // column (or null bound) never matches.
        const rv = row[cond.col];
        if (rv == null || cond.val == null) return false;
        const a = rv instanceof Date ? rv.getTime() : (rv as number);
        const b = cond.val instanceof Date ? cond.val.getTime() : (cond.val as number);
        if (cond.__op === "lt") return a < b;
        if (cond.__op === "lte") return a <= b;
        if (cond.__op === "gt") return a > b;
        return a >= b;
      }
      case "inArray":
        return cond.vals.includes(row[cond.col]);
      case "and":
        return cond.conds.every((c) => matchesCond(row, c));
      case "or":
        return cond.conds.some((c) => matchesCond(row, c));
      default:
        return true;
    }
  };

  const applyWhere = (rows: Row[], cond: Cond): Row[] =>
    cond ? rows.filter((r) => matchesCond(r, cond)) : rows;

  const applyOrder = (rows: Row[], order: Order): Row[] => {
    if (!order || order.__op !== "desc") return rows;
    return [...rows].sort((a, b) => {
      const av = a[order.col];
      const bv = b[order.col];
      const an = av instanceof Date ? av.getTime() : (av as number);
      const bn = bv instanceof Date ? bv.getTime() : (bv as number);
      return an < bn ? 1 : an > bn ? -1 : 0;
    });
  };

  // A thenable so `await`-ing any builder step resolves to the computed rows.
  const thenable = <T>(compute: () => T) => ({
    then(resolve: (v: T) => void, reject: (e: unknown) => void) {
      try {
        resolve(compute());
      } catch (e) {
        reject(e);
      }
    },
  });

  const insertRow = (name: string, vals: Row): Row => {
    const row: Row = {};
    for (const c of colsByTable[name]) row[c] = c in vals ? vals[c] : null;
    row.id = vals.id ?? ++seq[name];
    row.createdAt = vals.createdAt ?? new Date();
    stores[name as keyof typeof stores].push(row);
    return row;
  };

  const db = {
    select() {
      return {
        from(table: TableMarker) {
          const name = nameOf(table);
          let cond: Cond = null;
          let order: Order = null;
          const resolve = () => applyOrder(applyWhere(stores[name as keyof typeof stores], cond), order);
          const step = {
            where(c: Cond) {
              cond = c;
              return step;
            },
            orderBy(o: Order) {
              order = o;
              return thenable(resolve);
            },
            then(res: (v: Row[]) => void, rej: (e: unknown) => void) {
              thenable(resolve).then(res, rej);
            },
          };
          return step;
        },
      };
    },
    insert(table: TableMarker) {
      const name = nameOf(table);
      return {
        values(vals: Row | Row[]) {
          const arr = Array.isArray(vals) ? vals : [vals];
          // Inserts run lazily (at await time) so an onConflictDoNothing call
          // chained after values() can register its target columns first —
          // mirroring Postgres, where the conflict check happens at execution.
          let conflictTarget: string[] | null = null;
          let done: Row[] | null = null;
          const run = () => {
            done ??= arr.flatMap((v) => {
              if (conflictTarget) {
                const clash = stores[name as keyof typeof stores].some((r) =>
                  conflictTarget!.every((c) => r[c] === (c in v ? v[c] : null)),
                );
                if (clash) return [];
              }
              return [insertRow(name, v)];
            });
            return done;
          };
          const step = {
            onConflictDoNothing(cfg?: { target?: unknown[] }) {
              conflictTarget = (cfg?.target ?? []).map((c) => String(c));
              return step;
            },
            returning() {
              return thenable(run);
            },
            then(res: (v: Row[]) => void, rej: (e: unknown) => void) {
              thenable(run).then(res, rej);
            },
          };
          return step;
        },
      };
    },
    update(table: TableMarker) {
      const name = nameOf(table);
      return {
        set(vals: Row) {
          return {
            where(cond: Cond) {
              const run = () => {
                const matched = applyWhere(stores[name as keyof typeof stores], cond);
                for (const row of matched) Object.assign(row, vals);
                return matched;
              };
              return {
                returning() {
                  return thenable(run);
                },
                then(res: (v: Row[]) => void, rej: (e: unknown) => void) {
                  thenable(run).then(res, rej);
                },
              };
            },
          };
        },
      };
    },
    delete(table: TableMarker) {
      const name = nameOf(table);
      return {
        where(cond: Cond) {
          const run = () => {
            const matched = applyWhere(stores[name as keyof typeof stores], cond);
            stores[name as keyof typeof stores] = stores[name as keyof typeof stores].filter(
              (r) => !matched.includes(r),
            );
            return matched;
          };
          return {
            returning() {
              return thenable(run);
            },
            then(res: (v: Row[]) => void, rej: (e: unknown) => void) {
              thenable(run).then(res, rej);
            },
          };
        },
      };
    },
  };

  return {
    db,
    betsTable: marker("bets", BETS_COLS),
    pitcherKPaperTradesTable: marker("pitcher_k_paper_trades", PAPER_COLS),
    __stores: stores,
    __seedBet: (row) => insertRow("bets", row),
    __seedPaperTrade: (row) => insertRow("pitcher_k_paper_trades", row),
    __reset() {
      stores.bets = [];
      stores.pitcher_k_paper_trades = [];
      seq.bets = 0;
      seq.pitcher_k_paper_trades = 0;
    },
  };
}

/**
 * Replaces drizzle's `eq`/`desc` with plain descriptors the fake db reads,
 * keeping every other drizzle-orm export intact. Call inside a test file's
 * `vi.mock("drizzle-orm", ...)` factory.
 */
export async function stubDrizzleOrm(): Promise<Record<string, unknown>> {
  const actual = await vi.importActual<Record<string, unknown>>("drizzle-orm");
  return {
    ...actual,
    eq: (col: string, val: unknown) => ({ __op: "eq", col, val }),
    ne: (col: string, val: unknown) => ({ __op: "ne", col, val }),
    isNull: (col: string) => ({ __op: "isNull", col }),
    isNotNull: (col: string) => ({ __op: "isNotNull", col }),
    lt: (col: string, val: unknown) => ({ __op: "lt", col, val }),
    lte: (col: string, val: unknown) => ({ __op: "lte", col, val }),
    gt: (col: string, val: unknown) => ({ __op: "gt", col, val }),
    gte: (col: string, val: unknown) => ({ __op: "gte", col, val }),
    inArray: (col: string, vals: unknown[]) => ({ __op: "inArray", col, vals }),
    and: (...conds: unknown[]) => ({ __op: "and", conds: conds.filter(Boolean) }),
    or: (...conds: unknown[]) => ({ __op: "or", conds: conds.filter(Boolean) }),
    desc: (col: string) => ({ __op: "desc", col }),
  };
}
