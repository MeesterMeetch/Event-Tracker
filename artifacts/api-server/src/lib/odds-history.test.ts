import { describe, it, expect } from "vitest";
import {
  snapshotRowsFromEvents,
  lineMovementByBook,
  bookLeadership,
  shouldRetainSnapshot,
  type StoredSnapshot,
} from "./odds-history";
import type { OddsEvent } from "./odds";

function event(bookmakers: OddsEvent["bookmakers"]): OddsEvent {
  return {
    id: "evt1",
    sport_key: "baseball_mlb",
    commence_time: "2026-07-12T18:00:00Z",
    home_team: "Home",
    away_team: "Away",
    bookmakers,
  };
}

const SAMPLE = event([
  {
    key: "draftkings",
    title: "DraftKings",
    markets: [
      { key: "h2h", outcomes: [{ name: "Away", price: 120 }, { name: "Home", price: -140 }] },
      { key: "totals", outcomes: [{ name: "Over", price: -110, point: 8.5 }, { name: "Under", price: -110, point: 8.5 }] },
    ],
  },
  {
    key: "lowvig",
    title: "LowVig.ag",
    markets: [{ key: "h2h", outcomes: [{ name: "Away", price: 118 }, { name: "Home", price: -138 }] }],
  },
]);

function snap(minutes: number, book: string, odds: number, point: number | null = null): StoredSnapshot {
  return {
    capturedAt: new Date(Date.UTC(2026, 6, 12, 12, minutes)),
    book,
    bookTitle: book,
    americanOdds: odds,
    point,
    isSharp: book === "lowvig",
  };
}

describe("snapshotRowsFromEvents", () => {
  it("keeps every quoted price, not just the ones that looked like edges", () => {
    // 2 h2h + 2 totals from DK, 2 h2h from LowVig.
    expect(snapshotRowsFromEvents([SAMPLE], "baseball_mlb")).toHaveLength(6);
  });

  it("carries the line through for totals", () => {
    const rows = snapshotRowsFromEvents([SAMPLE], "baseball_mlb");
    const over = rows.find((r) => r.market === "totals" && r.selection === "Over")!;
    expect(over.point).toBe(8.5);
  });

  it("leaves point null on moneylines", () => {
    const rows = snapshotRowsFromEvents([SAMPLE], "baseball_mlb");
    expect(rows.find((r) => r.market === "h2h")!.point).toBeNull();
  });

  it("marks sharp books at capture time", () => {
    const rows = snapshotRowsFromEvents([SAMPLE], "baseball_mlb");
    expect(rows.find((r) => r.book === "lowvig")!.isSharp).toBe(true);
    expect(rows.find((r) => r.book === "draftkings")!.isSharp).toBe(false);
  });

  it("captures the player name on prop markets", () => {
    const props = event([
      {
        key: "draftkings",
        title: "DraftKings",
        markets: [
          {
            key: "pitcher_strikeouts",
            outcomes: [
              { name: "Over", price: -115, point: 5.5, description: "Ace Pitcher" },
              { name: "Under", price: -105, point: 5.5, description: "Ace Pitcher" },
            ],
          },
        ],
      },
    ]);
    const rows = snapshotRowsFromEvents([props], "baseball_mlb");
    expect(rows.every((r) => r.player === "Ace Pitcher")).toBe(true);
  });

  it("skips malformed prices rather than storing NaN", () => {
    const broken = event([
      {
        key: "book",
        title: "Book",
        markets: [{ key: "h2h", outcomes: [{ name: "Away", price: NaN }, { name: "Home", price: -140 }] }],
      },
    ]);
    expect(snapshotRowsFromEvents([broken], "baseball_mlb")).toHaveLength(1);
  });

  it("returns nothing for an empty payload", () => {
    expect(snapshotRowsFromEvents([], "baseball_mlb")).toEqual([]);
  });
});

describe("lineMovementByBook", () => {
  const history = [
    snap(0, "draftkings", -110, 8.5),
    snap(10, "draftkings", -115, 8.5),
    snap(20, "draftkings", -120, 9),
    snap(0, "fanduel", -110, 8.5),
    snap(20, "fanduel", -110, 8.5),
  ];

  it("reports the opening and latest price per book", () => {
    const moves = lineMovementByBook(history);
    const dk = moves.find((m) => m.book === "draftkings")!;
    expect(dk.openOdds).toBe(-110);
    expect(dk.latestOdds).toBe(-120);
    expect(dk.oddsDelta).toBe(-10);
  });

  it("tracks movement in the line itself", () => {
    const dk = lineMovementByBook(history).find((m) => m.book === "draftkings")!;
    expect(dk.openPoint).toBe(8.5);
    expect(dk.latestPoint).toBe(9);
    expect(dk.pointDelta).toBeCloseTo(0.5, 6);
  });

  it("counts a book that never moved as static", () => {
    const fd = lineMovementByBook(history).find((m) => m.book === "fanduel")!;
    expect(fd.moveCount).toBe(0);
    expect(fd.oddsDelta).toBe(0);
  });

  it("ranks the most active book first", () => {
    expect(lineMovementByBook(history)[0].book).toBe("draftkings");
  });

  it("orders by capture time regardless of input order", () => {
    const shuffled = [snap(20, "b", -120), snap(0, "b", -110), snap(10, "b", -115)];
    const move = lineMovementByBook(shuffled)[0];
    expect(move.openOdds).toBe(-110);
    expect(move.latestOdds).toBe(-120);
  });

  it("counts a line move even when the price holds", () => {
    const walked = [snap(0, "b", -110, 8.5), snap(10, "b", -110, 9)];
    expect(lineMovementByBook(walked)[0].moveCount).toBe(1);
  });

  it("handles a single observation", () => {
    const move = lineMovementByBook([snap(0, "b", -110)])[0];
    expect(move.moveCount).toBe(0);
    expect(move.openOdds).toBe(move.latestOdds);
  });
});

describe("bookLeadership", () => {
  it("identifies a book that moves further than the market", () => {
    // 'leader' jumps 40 cents while the others move 10, twice.
    const history = [
      snap(0, "leader", -110), snap(0, "slow1", -110), snap(0, "slow2", -110),
      snap(10, "leader", -150), snap(10, "slow1", -120), snap(10, "slow2", -120),
      snap(20, "leader", -190), snap(20, "slow1", -130), snap(20, "slow2", -130),
    ];
    const ranked = bookLeadership(history);
    expect(ranked[0].book).toBe("leader");
    expect(ranked[0].leads).toBeGreaterThan(0);
    expect(ranked[0].leadRate).toBeGreaterThan(0.5);
  });

  it("returns nothing when there is only one point in time", () => {
    expect(bookLeadership([snap(0, "a", -110), snap(0, "b", -110)])).toEqual([]);
  });

  it("ignores moves below the noise threshold", () => {
    const quiet = [
      snap(0, "a", -110), snap(0, "b", -110),
      snap(10, "a", -111), snap(10, "b", -111),
    ];
    expect(bookLeadership(quiet, 5).every((b) => b.leads === 0 && b.follows === 0)).toBe(true);
  });
});

describe("shouldRetainSnapshot", () => {
  const commence = new Date(Date.UTC(2026, 6, 12, 18));

  it("always keeps a genuine price change", () => {
    const far = { capturedAt: new Date(Date.UTC(2026, 6, 9, 3, 17)), commenceTime: commence, americanOdds: -115 };
    expect(shouldRetainSnapshot(far, { americanOdds: -110 })).toBe(true);
  });

  it("keeps everything close to game time", () => {
    const near = { capturedAt: new Date(Date.UTC(2026, 6, 12, 15, 17)), commenceTime: commence, americanOdds: -110 };
    expect(shouldRetainSnapshot(near, { americanOdds: -110 })).toBe(true);
  });

  it("thins out unchanged prices from days earlier", () => {
    const stale = { capturedAt: new Date(Date.UTC(2026, 6, 9, 3, 17)), commenceTime: commence, americanOdds: -110 };
    expect(shouldRetainSnapshot(stale, { americanOdds: -110 })).toBe(false);
  });

  it("keeps a coarse sample of old unchanged rows", () => {
    const onTheHour = { capturedAt: new Date(Date.UTC(2026, 6, 9, 3, 0)), commenceTime: commence, americanOdds: -110 };
    expect(shouldRetainSnapshot(onTheHour, { americanOdds: -110 })).toBe(true);
  });

  it("keeps the first observation, which has no predecessor", () => {
    const first = { capturedAt: new Date(Date.UTC(2026, 6, 9, 3, 17)), commenceTime: commence, americanOdds: -110 };
    expect(shouldRetainSnapshot(first, null, { fullResolutionHours: 999 })).toBe(true);
  });
});
