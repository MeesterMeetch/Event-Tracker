import { describe, expect, it } from "vitest";
import { computeEdges } from "./ev";
import type { OddsBookmaker, OddsEvent, OddsMarket, OddsOutcome } from "./odds";

/**
 * computeEdges is the heart of the tracker: it removes the vig from each book's
 * own line (multiplicative devig over ALL outcomes, not just a 2-way pair),
 * averages the fair probabilities across books into a consensus, and flags any
 * best-available price that beats that consensus by the requested margin.
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
  // Book3: A +150 (0.4), B -200 (0.6667); overround 1.06667 → fairA 0.375, fairB 0.625.
  //   A: avg fair = (0.5+0.5+0.375)/3 = 0.458333; best price +150 (2.5)
  //      EV = 2.5*0.458333 - 1 = +14.58%; fair odds +118
  //   B: avg fair = (0.5+0.5+0.625)/3 = 0.541667; best price +100 (2.0)
  //      EV = 2.0*0.541667 - 1 = +8.33%; fair odds -118
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
    expect(away.evPercent).toBeCloseTo(14.58, 2);
    // Best price came from Book3's +150, not the +100 books.
    expect(away.americanOdds).toBe(150);
    expect(away.book).toBe("Book3");
    expect(away.fairOdds).toBe(118);
    expect(away.market).toBe("h2h");
    expect(away.point).toBeNull();
    expect(away.player).toBeNull();
  });

  it("computes the favorite-side edge with its own best price", () => {
    const home = computeEdges(events, "baseball_mlb", 1).find((e) => e.selection === "Home")!;
    expect(home.evPercent).toBeCloseTo(8.33, 2);
    // -200 is a worse decimal than +100, so the best price is +100 from Book1/2.
    expect(home.americanOdds).toBe(100);
    expect(home.fairOdds).toBe(-118);
  });

  it("filters out everything below the minimum edge threshold", () => {
    // Home's edge is 8.33%, so a 10% floor drops it and keeps only Away (14.58%).
    const edges = computeEdges(events, "baseball_mlb", 10);
    expect(edges.map((e) => e.selection)).toEqual(["Away"]);
  });
});

describe("computeEdges — N-way market (3-way h2h)", () => {
  // A genuine 3-way (soccer-style) market. The devig MUST divide by the sum of
  // all three implied probabilities; a 2-way assumption would produce a
  // different (wrong) fair price.
  // Book1: A +100 (0.5), Draw +200 (0.3333), B +200 (0.3333); overround 1.16667
  //   → fair A 0.428571, Draw 0.285714, B 0.285714
  // Book2: A -140 (0.583333), Draw +200 (0.3333), B +400 (0.2); overround 1.116667
  //   → fair A 0.522388, Draw 0.298507, B 0.179104
  //   B: avg fair = (0.285714 + 0.179104)/2 = 0.232409; best price +400 (5.0)
  //      EV = 5.0*0.232409 - 1 = +16.20%; fair odds +330
  //   A and Draw are both negative-EV → not returned.
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
    expect(home.evPercent).toBeCloseTo(16.2, 1);
    expect(home.americanOdds).toBe(400);
    expect(home.book).toBe("Book2");
    expect(home.fairOdds).toBe(330);
  });
});

describe("computeEdges — totals with points", () => {
  // Over/Under 8.5 across two books.
  // Book1: Over -110 (0.52381), Under -110 (0.52381); overround 1.047619 → fairOver 0.5
  // Book2: Over +130 (0.434783), Under -160 (0.615385); overround 1.050167 → fairOver 0.414012
  //   Over: avg fair = (0.5 + 0.414012)/2 = 0.457006; best price +130 (2.3)
  //         EV = 2.3*0.457006 - 1 = +5.11%; fair odds +119
  //   Under's edge (~3.68%) is below the 5% floor and is filtered out.
  const events = [
    event([
      book("Book1", "totals", [outcome("Over", -110, 8.5), outcome("Under", -110, 8.5)]),
      book("Book2", "totals", [outcome("Over", 130, 8.5), outcome("Under", -160, 8.5)]),
    ]),
  ];

  it("keys outcomes by point and surfaces the total line", () => {
    const edges = computeEdges(events, "baseball_mlb", 5);
    expect(edges).toHaveLength(1);
    const [over] = edges;
    expect(over.market).toBe("totals");
    expect(over.selection).toBe("Over");
    expect(over.point).toBe(8.5);
    expect(over.evPercent).toBeCloseTo(5.11, 2);
    expect(over.americanOdds).toBe(130);
    expect(over.fairOdds).toBe(119);
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
  //   → fairA 0.466103, fairB 0.533897 → sharpProb A = 46.6%, B = 53.4%
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
    expect(away!.sharpProb).toBeCloseTo(46.6, 1);
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
