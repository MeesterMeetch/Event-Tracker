import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { computeEdges } from "./ev";
import type { OddsBookmaker, OddsEvent, OddsMarket, OddsOutcome } from "./odds";

/**
 * computeEdges is the heart of the tracker: it removes the vig from each book's
 * own line (devig over ALL outcomes, not just a 2-way pair), averages the fair
 * probabilities across books into a consensus, and flags any best-available
 * price that beats that consensus by the requested margin.
 *
 * The de-vig method is Shin (see devig.ts), not the proportional divide-by-the-
 * overround it used to be. Proportional removal overstates the longshot side and
 * manufactures phantom edges on lopsided markets, so several expected values
 * below moved when it was replaced, always by shrinking a plus-money edge and
 * growing the favourite's. For two-outcome markets Shin is arithmetically
 * identical to splitting the margin evenly, which is what makes these numbers
 * hand-checkable.
 *
 * Every expected number below is computed by hand from the inputs so a silent
 * math regression fails here loudly rather than surfacing a wrong edge in prod.
 */

function outcome(name: string, price: number, point?: number): OddsOutcome {
  return point === undefined ? { name, price } : { name, price, point };
}

function book(title: string, market: string, outcomes: OddsOutcome[]): OddsBookmaker {
  const m: OddsMarket = { key: market, outcomes };
  return { key: title.toLowerCase(), title, markets: [m] };
}

function event(bookmakers: OddsBookmaker[], id = "evt1"): OddsEvent {
  return {
    id,
    sport_key: "baseball_mlb",
    commence_time: "2026-07-12T18:00:00Z",
    home_team: "Home",
    away_team: "Away",
    bookmakers,
  };
}

describe("computeEdges — multi-book averaging (2-way h2h)", () => {
  // Book1 & Book2: A/B both +100 → no vig, fair 0.5/0.5 each.
  // Book3: A +150 (0.4), B -200 (0.6667); overround 1.06667. Shin splits that
  //   6.67% margin evenly, 0.03333 off each side → fairA 0.366667, fairB 0.633333.
  //   (Proportional would have given fairA 0.375 — more generous to the longshot.)
  //   A: avg fair = (0.5+0.5+0.366667)/3 = 0.455556; best price +150 (2.5)
  //      EV = 2.5*0.455556 - 1 = +13.89%; fair odds +120
  //   B: avg fair = (0.5+0.5+0.633333)/3 = 0.544444; best price +100 (2.0)
  //      EV = 2.0*0.544444 - 1 = +8.89%; fair odds -120
  const events = [
    event([
      book("Book1", "h2h", [outcome("Away", 100), outcome("Home", 100)]),
      book("Book2", "h2h", [outcome("Away", 100), outcome("Home", 100)]),
      book("Book3", "h2h", [outcome("Away", 150), outcome("Home", -200)]),
    ]),
  ];

  it("returns both positive-EV outcomes sorted by edge descending", () => {
    const edges = computeEdges(events, "baseball_mlb", 1);
    expect(edges.map((e) => e.selection)).toEqual(["Away", "Home"]);
    expect(edges[0].evPercent).toBeGreaterThan(edges[1].evPercent);
  });

  it("computes the underdog edge from the best price against the consensus", () => {
    const [away] = computeEdges(events, "baseball_mlb", 1);
    expect(away.selection).toBe("Away");
    expect(away.evPercent).toBeCloseTo(13.89, 2);
    // Best price came from Book3's +150, not the +100 books.
    expect(away.americanOdds).toBe(150);
    expect(away.book).toBe("Book3");
    expect(away.fairOdds).toBe(120);
    expect(away.market).toBe("h2h");
    expect(away.point).toBeNull();
    expect(away.player).toBeNull();
  });

  it("computes the favorite-side edge with its own best price", () => {
    const home = computeEdges(events, "baseball_mlb", 1).find((e) => e.selection === "Home")!;
    expect(home.evPercent).toBeCloseTo(8.89, 2);
    // -200 is a worse decimal than +100, so the best price is +100 from Book1/2.
    expect(home.americanOdds).toBe(100);
    expect(home.fairOdds).toBe(-120);
  });

  it("filters out everything below the minimum edge threshold", () => {
    // Home's edge is 8.89%, so a 10% floor drops it and keeps only Away (13.89%).
    const edges = computeEdges(events, "baseball_mlb", 10);
    expect(edges.map((e) => e.selection)).toEqual(["Away"]);
  });
});

describe("computeEdges — N-way market (3-way h2h)", () => {
  // A genuine 3-way (soccer-style) market. The devig MUST divide by the sum of
  // all three implied probabilities; a 2-way assumption would produce a
  // different (wrong) fair price.
  // This is where Shin and the equal-margin split diverge: with three outcomes
  // they are no longer the same computation, and Shin takes proportionally more
  // margin out of the longshot (B at +400) than out of the favourite.
  // Book1: A +100 (0.5), Draw +200 (0.3333), B +200 (0.3333); overround 1.16667
  // Book2: A -140 (0.583333), Draw +200 (0.3333), B +400 (0.2); overround 1.116667
  //   Shin fair B: 0.279958 (Book1) and 0.166192 (Book2)
  //   B: avg fair = (0.279958 + 0.166192)/2 = 0.223075; best price +400 (5.0)
  //      EV = 5.0*0.223075 - 1 = +11.54%; fair odds +348
  //   Under proportional this read +16.20%, a 4.7-point overstatement on a
  //   +400 longshot — the exact failure mode the method change fixes.
  //   A (-2.14%) and Draw (-13.72%) are both negative-EV → not returned.
  const events = [
    event([
      book("Book1", "h2h", [outcome("Away", 100), outcome("Draw", 200), outcome("Home", 200)]),
      book("Book2", "h2h", [outcome("Away", -140), outcome("Draw", 200), outcome("Home", 400)]),
    ]),
  ];

  it("devigs across all three outcomes and flags only the true edge", () => {
    const edges = computeEdges(events, "soccer_epl", 1);
    expect(edges).toHaveLength(1);
    const [home] = edges;
    expect(home.selection).toBe("Home");
    expect(home.evPercent).toBeCloseTo(11.54, 1);
    expect(home.americanOdds).toBe(400);
    expect(home.book).toBe("Book2");
    expect(home.fairOdds).toBe(348);
  });
});

describe("computeEdges — totals with points", () => {
  // Over/Under 8.5 across two books.
  // Book1: Over -110 (0.52381), Under -110 (0.52381); overround 1.047619 → fairOver 0.5
  // Book2: Over +130 (0.434783), Under -160 (0.615385); overround 1.050167.
  //   Shin takes 0.025084 off each side → fairOver 0.409699.
  //   Over: avg fair = (0.5 + 0.409699)/2 = 0.454849; best price +130 (2.3)
  //         EV = 2.3*0.454849 - 1 = +4.62%; fair odds +120
  //   Under: avg fair 0.545151, best -110 (1.909091) → +4.07%.
  // The floor is 4.5% here rather than 5%: under proportional this Over read
  // +5.11% and cleared a 5% bar, but that extra half point was the longshot
  // overstatement. The threshold is set between the two sides so the test still
  // checks exactly what it always did — Over surfaces, Under is filtered.
  const events = [
    event([
      book("Book1", "totals", [outcome("Over", -110, 8.5), outcome("Under", -110, 8.5)]),
      book("Book2", "totals", [outcome("Over", 130, 8.5), outcome("Under", -160, 8.5)]),
    ]),
  ];

  it("keys outcomes by point and surfaces the total line", () => {
    const edges = computeEdges(events, "baseball_mlb", 4.5);
    expect(edges).toHaveLength(1);
    const [over] = edges;
    expect(over.market).toBe("totals");
    expect(over.selection).toBe("Over");
    expect(over.point).toBe(8.5);
    expect(over.evPercent).toBeCloseTo(4.62, 2);
    expect(over.americanOdds).toBe(130);
    expect(over.fairOdds).toBe(120);
  });
});

describe("computeEdges — edge cases", () => {
  it("requires at least two books before trusting a price", () => {
    // A lone book offering a wild +2000 line must not masquerade as consensus.
    const events = [
      event([book("Solo", "h2h", [outcome("Away", 2000), outcome("Home", -5000)])]),
    ];
    expect(computeEdges(events, "baseball_mlb", 1)).toEqual([]);
  });

  it("skips a book's market that quotes fewer than two outcomes", () => {
    // A one-sided market can't be devigged and must be ignored, not crash.
    const events = [
      event([
        book("Book1", "h2h", [outcome("Away", 120)]),
        book("Book2", "h2h", [outcome("Away", 120)]),
      ]),
    ];
    expect(computeEdges(events, "baseball_mlb", 1)).toEqual([]);
  });

  it("skips a market whose prices imply zero overround", () => {
    // Zero/missing prices imply 0 probability → overround 0 → skip, no NaN edges.
    const events = [
      event([
        book("Book1", "h2h", [outcome("Away", 0), outcome("Home", 0)]),
        book("Book2", "h2h", [outcome("Away", 0), outcome("Home", 0)]),
      ]),
    ];
    expect(computeEdges(events, "baseball_mlb", 1)).toEqual([]);
  });

  it("returns nothing when no price beats the consensus", () => {
    // Identical -110/-110 across two books: every fair-priced side is negative EV.
    const events = [
      event([
        book("Book1", "h2h", [outcome("Away", -110), outcome("Home", -110)]),
        book("Book2", "h2h", [outcome("Away", -110), outcome("Home", -110)]),
      ]),
    ];
    expect(computeEdges(events, "baseball_mlb", 0)).toEqual([]);
  });

  it("returns nothing for an empty slate", () => {
    expect(computeEdges([], "baseball_mlb", 1)).toEqual([]);
  });
});

describe("computeEdges — sharp vs public split", () => {
  // LowVig is a sharp book (SHARP_BOOK_KEYS); Book1/Book2 are public.
  // LowVig: A +110 (0.47619), B -120 (0.545455); overround 1.021645
  //   → Shin fairA 0.465177, fairB 0.534823 → sharpProb A = 46.5%, B = 53.5%
  // Book1 & Book2: A/B both +100 → fair 0.5 each → publicProb 50%.
  const events = [
    event([
      book("Book1", "h2h", [outcome("Away", 100), outcome("Home", 100)]),
      book("Book2", "h2h", [outcome("Away", 100), outcome("Home", 100)]),
      { key: "lowvig", title: "LowVig.ag", markets: [{ key: "h2h", outcomes: [outcome("Away", 110), outcome("Home", -120)] }] },
    ]),
  ];

  it("reports the devigged consensus of sharp books and public books separately", () => {
    const edges = computeEdges(events, "baseball_mlb", 1);
    const away = edges.find((e) => e.selection === "Away");
    expect(away).toBeDefined();
    expect(away!.sharpProb).toBeCloseTo(46.5, 1);
    expect(away!.publicProb).toBeCloseTo(50, 1);
  });

  it("returns null for the sharp side when no sharp book quotes the market", () => {
    const publicOnly = [
      event([
        book("Book1", "h2h", [outcome("Away", 120), outcome("Home", -105)]),
        book("Book2", "h2h", [outcome("Away", 100), outcome("Home", 100)]),
      ]),
    ];
    const edges = computeEdges(publicOnly, "baseball_mlb", 1);
    expect(edges.length).toBeGreaterThan(0);
    for (const e of edges) {
      expect(e.sharpProb).toBeNull();
      expect(e.publicProb).not.toBeNull();
    }
  });
});

/**
 * The reason bettable-books.ts exists. Widening the odds fetch to the EU region
 * is the only way to reach Pinnacle, but it also drags in ~20 European books a
 * US bettor can never use. Without filtering, the best of those prices tops the
 * EV list with an edge that cannot be taken.
 */
describe("computeEdges — unbettable books cannot set the best price", () => {
  function marketWith(books: { key: string; title: string; away: number; home: number }[]): OddsEvent {
    return {
      id: "evt-books",
      sport_key: "baseball_mlb",
      commence_time: "2026-07-12T18:00:00Z",
      home_team: "Home Team",
      away_team: "Away Team",
      bookmakers: books.map((b) => ({
        key: b.key,
        title: b.title,
        markets: [
          { key: "h2h", outcomes: [{ name: "Away Team", price: b.away }, { name: "Home Team", price: b.home }] },
        ],
      })),
    };
  }

  // Winamax offers a far better Away price than DraftKings. Both feed the
  // consensus; only DraftKings may be quoted as the price to bet.
  const event = marketWith([
    { key: "draftkings", title: "DraftKings", away: 150, home: -180 },
    { key: "fanduel", title: "FanDuel", away: 145, home: -175 },
    { key: "winamax_de", title: "Winamax (DE)", away: 260, home: -320 },
  ]);

  const originalBettable = process.env.BETTABLE_BOOKS;
  afterEach(() => {
    // vitest.setup.ts sets "all" globally; restore that after each case here.
    process.env.BETTABLE_BOOKS = "all";
  });

  it("ignores an unbettable book's price when choosing the best available", () => {
    process.env.BETTABLE_BOOKS = "draftkings,fanduel";
    const edges = computeEdges([event], "baseball_mlb", -1000);
    const away = edges.find((e) => e.selection === "Away Team")!;
    expect(away.book).toBe("DraftKings");
    expect(away.americanOdds).toBe(150);
  });

  it("still counts the unbettable book in the fair-price consensus", () => {
    process.env.BETTABLE_BOOKS = "draftkings,fanduel";
    const withWinamax = computeEdges([event], "baseball_mlb", -1000).find((e) => e.selection === "Away Team")!;
    const withoutWinamax = computeEdges(
      [marketWith([
        { key: "draftkings", title: "DraftKings", away: 150, home: -180 },
        { key: "fanduel", title: "FanDuel", away: 145, home: -175 },
      ])],
      "baseball_mlb",
      -1000,
    ).find((e) => e.selection === "Away Team")!;

    // Winamax's very different line moves the consensus, proving it was not
    // simply discarded along with its price.
    expect(withWinamax.fairOdds).not.toBe(withoutWinamax.fairOdds);
  });

  it("would otherwise report the unactionable price, which is the bug this prevents", () => {
    process.env.BETTABLE_BOOKS = "all";
    const away = computeEdges([event], "baseball_mlb", -1000).find((e) => e.selection === "Away Team")!;
    expect(away.book).toBe("Winamax (DE)");
    expect(away.americanOdds).toBe(260);
  });

  it("drops an outcome entirely when no bettable book quotes it", () => {
    process.env.BETTABLE_BOOKS = "caesars";
    expect(computeEdges([event], "baseball_mlb", -1000)).toEqual([]);
  });

  afterAll(() => {
    if (originalBettable === undefined) delete process.env.BETTABLE_BOOKS;
    else process.env.BETTABLE_BOOKS = originalBettable;
  });
});
