import { describe, expect, it } from "vitest";
import { computePropEdges } from "./props";
import type { OddsBookmaker, OddsEvent, OddsOutcome } from "./odds";

/**
 * computePropEdges is the player-prop counterpart of computeEdges, and carries
 * the same silent-regression risk: it groups a book's prop outcomes into
 * (player, line) Over/Under pairs, removes the vig from each pair
 * multiplicatively, averages the fair probabilities across books quoting the
 * exact same (player, line), and flags any best price that beats that
 * consensus. A one-sided quote (a lone Over/Under/Yes) can't be devigged and
 * must be dropped so it never poisons the overround.
 *
 * Every expected number below is computed by hand from the inputs so a math or
 * keying regression fails here loudly instead of surfacing a wrong prop edge.
 */

function propOutcome(name: string, description: string, price: number, point: number): OddsOutcome {
  return { name, description, price, point };
}

function book(title: string, market: string, outcomes: OddsOutcome[]): OddsBookmaker {
  return { key: title.toLowerCase(), title, markets: [{ key: market, outcomes }] };
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

describe("computePropEdges — multi-book averaging", () => {
  // Aaron Judge total bases Over/Under 1.5, three books.
  // Book1 & Book2: Over/Under -110/-110 → overround 1.047619, fairOver/Under 0.5 each.
  // Book3: Over +150 (0.4), Under -200 (0.666667); overround 1.066667
  //   → fairOver 0.375, fairUnder 0.625.
  //   Over: avg fair = (0.5+0.5+0.375)/3 = 0.458333; best price +150 (2.5)
  //         EV = 2.5*0.458333 - 1 = +14.58%; fair odds +118
  //   Under: avg fair = (0.5+0.5+0.625)/3 = 0.541667; best price -110 (1.909091)
  //          EV = 1.909091*0.541667 - 1 = +3.41% → below a 5% floor.
  const evt = event([
    book("Book1", "batter_total_bases", [
      propOutcome("Over", "Aaron Judge", -110, 1.5),
      propOutcome("Under", "Aaron Judge", -110, 1.5),
    ]),
    book("Book2", "batter_total_bases", [
      propOutcome("Over", "Aaron Judge", -110, 1.5),
      propOutcome("Under", "Aaron Judge", -110, 1.5),
    ]),
    book("Book3", "batter_total_bases", [
      propOutcome("Over", "Aaron Judge", 150, 1.5),
      propOutcome("Under", "Aaron Judge", -200, 1.5),
    ]),
  ]);

  it("averages fair probs across books and surfaces the prop edge with player/point", () => {
    const edges = computePropEdges(evt, "baseball_mlb", 5);
    expect(edges).toHaveLength(1);
    const [over] = edges;
    expect(over.player).toBe("Aaron Judge");
    expect(over.market).toBe("batter_total_bases");
    expect(over.selection).toBe("Over");
    expect(over.point).toBe(1.5);
    expect(over.evPercent).toBeCloseTo(14.58, 2);
    // Best price is Book3's +150, not the -110 books.
    expect(over.americanOdds).toBe(150);
    expect(over.book).toBe("Book3");
    expect(over.fairOdds).toBe(118);
    expect(over.gameId).toBe("evt1");
    expect(over.sport).toBe("baseball_mlb");
  });

  it("drops the Under side when its edge is below the minimum threshold", () => {
    // Under's edge is only +3.41%, so a 5% floor keeps just the Over.
    const edges = computePropEdges(evt, "baseball_mlb", 5);
    expect(edges.map((e) => e.selection)).toEqual(["Over"]);
  });
});

describe("computePropEdges — (player, point) pairing and keying", () => {
  // Two players in the same market must be keyed independently — one book's
  // Player A line must never mix into Player B's consensus.
  // Player A (points 25.5):
  //   Book1 Over/Under -110/-110 → fairOver 0.5
  //   Book2 Over +130 (0.434783), Under -160 (0.615385); overround 1.050167
  //         → fairOver 0.414010
  //   Over: avg fair = (0.5 + 0.414010)/2 = 0.457005; best +130 (2.3)
  //         EV = 2.3*0.457005 - 1 = +5.11%; fair odds +119
  // Player B (points 5.5):
  //   Book1 Over -160 (0.615385), Under +130 (0.434783); overround 1.050167
  //         → fairUnder 0.414010
  //   Book2 Over/Under -110/-110 → fairUnder 0.5
  //   Under: avg fair = (0.414010 + 0.5)/2 = 0.457005; best +130 (2.3)
  //          EV = 2.3*0.457005 - 1 = +5.11%; fair odds +119
  const evt = event([
    book("Book1", "player_points", [
      propOutcome("Over", "Player A", -110, 25.5),
      propOutcome("Under", "Player A", -110, 25.5),
      propOutcome("Over", "Player B", -160, 5.5),
      propOutcome("Under", "Player B", 130, 5.5),
    ]),
    book("Book2", "player_points", [
      propOutcome("Over", "Player A", 130, 25.5),
      propOutcome("Under", "Player A", -160, 25.5),
      propOutcome("Over", "Player B", -110, 5.5),
      propOutcome("Under", "Player B", -110, 5.5),
    ]),
  ]);

  it("keeps each player's line separate and attributes the right side/point", () => {
    const edges = computePropEdges(evt, "basketball_nba", 5);
    expect(edges).toHaveLength(2);

    const a = edges.find((e) => e.player === "Player A")!;
    expect(a.selection).toBe("Over");
    expect(a.point).toBe(25.5);
    expect(a.americanOdds).toBe(130);
    expect(a.evPercent).toBeCloseTo(5.11, 2);
    expect(a.fairOdds).toBe(119);

    const b = edges.find((e) => e.player === "Player B")!;
    expect(b.selection).toBe("Under");
    expect(b.point).toBe(5.5);
    expect(b.americanOdds).toBe(130);
    expect(b.evPercent).toBeCloseTo(5.11, 2);
    expect(b.fairOdds).toBe(119);
  });
});

describe("computePropEdges — one-sided outcomes can't poison the devig", () => {
  it("ignores a lone Over (no Under) instead of letting it fabricate an edge", () => {
    // Book1/Book2 quote a real Over/Under 1.5 pair (fairOver 0.5 and 0.414010,
    // best +130). Book3 quotes ONLY a wild +5000 Over — no Under to devig
    // against — so it must be skipped entirely. If it leaked through, it would
    // become the best price (decimal 51) and manufacture a huge fake edge.
    const evt = event([
      book("Book1", "batter_hits", [
        propOutcome("Over", "Star Hitter", -110, 1.5),
        propOutcome("Under", "Star Hitter", -110, 1.5),
      ]),
      book("Book2", "batter_hits", [
        propOutcome("Over", "Star Hitter", 130, 1.5),
        propOutcome("Under", "Star Hitter", -160, 1.5),
      ]),
      book("Book3", "batter_hits", [propOutcome("Over", "Star Hitter", 5000, 1.5)]),
    ]);

    const edges = computePropEdges(evt, "baseball_mlb", 5);
    expect(edges).toHaveLength(1);
    const [over] = edges;
    // Best price stays Book2's +130 and only the two real books average in.
    expect(over.americanOdds).toBe(130);
    expect(over.book).toBe("Book2");
    expect(over.evPercent).toBeCloseTo(5.11, 2);
    expect(over.fairOdds).toBe(119);
  });

  it("skips outcomes with no player description and duplicate same-name rows", () => {
    // Book1: a proper pair PLUS a stray descriptionless row (skipped at parse).
    // Book2: two "Over" rows for the same (player, point) — length is 2 but the
    // names match, so it isn't a real Over/Under pair and must be dropped.
    const evt = event([
      book("Book1", "batter_hits", [
        propOutcome("Over", "Ghost", -110, 1.5),
        propOutcome("Under", "Ghost", -110, 1.5),
        { name: "Over", price: 200, point: 1.5 },
      ]),
      book("Book2", "batter_hits", [
        propOutcome("Over", "Ghost", 200, 1.5),
        propOutcome("Over", "Ghost", 300, 1.5),
      ]),
    ]);

    // Book1's pair is the only devig-able quote → Ghost has just 1 book of
    // consensus, which fails the 2-book guard → no edges.
    expect(computePropEdges(evt, "baseball_mlb", 1)).toEqual([]);
  });
});

describe("computePropEdges — edge cases", () => {
  it("requires at least two distinct books before trusting a prop line", () => {
    // A lone book's outlier pair must not masquerade as consensus.
    const evt = event([
      book("Solo", "batter_hits", [
        propOutcome("Over", "One Book Wonder", 200, 1.5),
        propOutcome("Under", "One Book Wonder", -260, 1.5),
      ]),
    ]);
    expect(computePropEdges(evt, "baseball_mlb", 1)).toEqual([]);
  });

  it("does not let duplicate rows from a single book fabricate a consensus", () => {
    // The same book listed with two markets both quoting the identical pair is
    // still one distinct book key → below the 2-book guard.
    const dupeMarket = {
      key: "solo",
      title: "Solo",
      markets: [
        { key: "batter_hits", outcomes: [propOutcome("Over", "Dup", 130, 1.5), propOutcome("Under", "Dup", -160, 1.5)] },
        { key: "batter_hits", outcomes: [propOutcome("Over", "Dup", 130, 1.5), propOutcome("Under", "Dup", -160, 1.5)] },
      ],
    } satisfies OddsBookmaker;
    expect(computePropEdges(event([dupeMarket]), "baseball_mlb", 1)).toEqual([]);
  });

  it("skips a pair whose prices imply zero overround", () => {
    // Zero/missing prices imply 0 probability → overround 0 → skip, no NaN edge.
    const evt = event([
      book("Book1", "batter_hits", [propOutcome("Over", "Zero", 0, 1.5), propOutcome("Under", "Zero", 0, 1.5)]),
      book("Book2", "batter_hits", [propOutcome("Over", "Zero", 0, 1.5), propOutcome("Under", "Zero", 0, 1.5)]),
    ]);
    expect(computePropEdges(evt, "baseball_mlb", 1)).toEqual([]);
  });

  it("returns nothing when no price beats the consensus", () => {
    // Identical -110/-110 across two books: every fair-priced side is negative EV.
    const evt = event([
      book("Book1", "batter_hits", [propOutcome("Over", "Fair", -110, 1.5), propOutcome("Under", "Fair", -110, 1.5)]),
      book("Book2", "batter_hits", [propOutcome("Over", "Fair", -110, 1.5), propOutcome("Under", "Fair", -110, 1.5)]),
    ]);
    expect(computePropEdges(evt, "baseball_mlb", 0)).toEqual([]);
  });

  it("returns nothing for an event with no bookmakers", () => {
    expect(computePropEdges(event([]), "baseball_mlb", 1)).toEqual([]);
  });

  it("sorts multiple edges by EV percent descending", () => {
    // Two players, one edge each, must come back best-first.
    // Big (points 1.5), 3 books: -110/-110, -110/-110, +150/-200
    //   → Over avg (0.5+0.5+0.375)/3 = 0.458333; best +150 (2.5); EV +14.58%.
    //     (Under avg 0.541667, best -110 → +3.41%, below the 5% floor.)
    // Small (points 2.5), 2 books: -110/-110, +130/-160
    //   → Over avg (0.5+0.414010)/2 = 0.457005; best +130 (2.3); EV +5.11%.
    //     (Under avg 0.542995, best -110 → +3.67%, below the 5% floor.)
    const evt = event([
      book("Book1", "batter_hits", [
        propOutcome("Over", "Big", -110, 1.5),
        propOutcome("Under", "Big", -110, 1.5),
        propOutcome("Over", "Small", -110, 2.5),
        propOutcome("Under", "Small", -110, 2.5),
      ]),
      book("Book2", "batter_hits", [
        propOutcome("Over", "Big", -110, 1.5),
        propOutcome("Under", "Big", -110, 1.5),
        propOutcome("Over", "Small", 130, 2.5),
        propOutcome("Under", "Small", -160, 2.5),
      ]),
      book("Book3", "batter_hits", [
        propOutcome("Over", "Big", 150, 1.5),
        propOutcome("Under", "Big", -200, 1.5),
      ]),
    ]);
    const edges = computePropEdges(evt, "baseball_mlb", 5);
    expect(edges.map((e) => e.player)).toEqual(["Big", "Small"]);
    expect(edges[0].evPercent).toBeGreaterThan(edges[1].evPercent);
    expect(edges[0].evPercent).toBeCloseTo(14.58, 2);
    expect(edges[1].evPercent).toBeCloseTo(5.11, 2);
  });
});
