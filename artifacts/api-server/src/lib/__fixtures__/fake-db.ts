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
  "expectedStrikeouts",
  "projectedBattersFaced",
  "recommendedUnits",
  "kellyMultiplier",
  "closingOdds",
  "closingProb",
  "clvPercent",
  "beatClose",
  "status",
  "createdAt",
] as const;

type Row = Record<string, unknown>;
type Cond = { __op: "eq"; col: string; val: unknown } | null;
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

  const applyWhere = (rows: Row[], cond: Cond): Row[] =>
    cond && cond.__op === "eq" ? rows.filter((r) => r[cond.col] === cond.val) : rows;

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
          const inserted = arr.map((v) => insertRow(name, v));
          return {
            returning() {
              return thenable(() => inserted);
            },
            then(res: (v: Row[]) => void, rej: (e: unknown) => void) {
              thenable(() => inserted).then(res, rej);
            },
          };
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
    desc: (col: string) => ({ __op: "desc", col }),
  };
}
