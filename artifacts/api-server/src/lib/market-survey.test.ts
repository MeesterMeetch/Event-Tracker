import { describe, it, expect } from "vitest";
import { surveyMarkets, interpretSurvey } from "./market-survey";
import type { OddsEvent } from "./odds";

type Outcome = { name: string; price: number; point?: number; description?: string };

function event(id: string, books: { key: string; markets: { key: string; outcomes: Outcome[] }[] }[]): OddsEvent {
  return {
    id,
    sport_key: "test_sport",
    commence_time: "2026-09-12T18:00:00Z",
    home_team: "Home",
    away_team: "Away",
    bookmakers: books.map((b) => ({ key: b.key, title: b.key, markets: b.markets })),
  };
}

/** Same market quoted by n books, all at identical prices. */
function agreeingBooks(marketKey: string, over: number, under: number, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    key: `book${i}`,
    markets: [{ key: marketKey, outcomes: [{ name: "Over", price: over }, { name: "Under", price: under }] }],
  }));
}

describe("surveyMarkets", () => {
  it("reports the bookmaker margin as overround above a fair book", () => {
    // -110 / -110 is a 4.76 percent overround.
    const rows = surveyMarkets([event("e1", agreeingBooks("totals", -110, -110, 4))], "test");
    expect(rows[0].meanOverroundPercent).toBeCloseTo(4.76, 1);
  });

  it("reports zero dispersion when every book posts the same number", () => {
    const rows = surveyMarkets([event("e1", agreeingBooks("totals", -110, -110, 5))], "test");
    expect(rows[0].meanDispersionPercent).toBeCloseTo(0, 6);
  });

  it("separates disagreement from margin, which is the whole point", () => {
    // Market A: fat vig, perfect agreement. Expensive but not beatable.
    const expensiveButEfficient = event("e1", agreeingBooks("marketA", -130, -130, 5));
    // Market B: same fat vig, but books disagree wildly on which side is favoured.
    const expensiveAndSloppy = event("e2", [
      { key: "book0", markets: [{ key: "marketB", outcomes: [{ name: "Over", price: -200 }, { name: "Under", price: 150 }] }] },
      { key: "book1", markets: [{ key: "marketB", outcomes: [{ name: "Over", price: 150 }, { name: "Under", price: -200 }] }] },
      { key: "book2", markets: [{ key: "marketB", outcomes: [{ name: "Over", price: -110 }, { name: "Under", price: -120 }] }] },
    ]);

    const rows = surveyMarkets([expensiveButEfficient, expensiveAndSloppy], "test");
    const a = rows.find((r) => r.market === "marketA")!;
    const b = rows.find((r) => r.market === "marketB")!;

    // Both carry real margin, but only B is actually exploitable.
    expect(b.meanDispersionPercent).toBeGreaterThan(a.meanDispersionPercent);
    expect(b.meanBestPriceEdgePercent).toBeGreaterThan(a.meanBestPriceEdgePercent);
  });

  it("finds no edge worth taking when books agree, even at high vig", () => {
    const rows = surveyMarkets([event("e1", agreeingBooks("totals", -130, -130, 5))], "test");
    // Best price equals every price, so there is nothing to shop for.
    expect(rows[0].meanBestPriceEdgePercent).toBeLessThan(0);
    expect(rows[0].shareAboveTwoPercent).toBe(0);
  });

  it("keys the vig to each player and line rather than the whole market", () => {
    // One prop market carrying two different players. If these were de-vigged
    // together the overround would read as roughly double the real margin.
    const twoPlayers = event("e1", [
      {
        key: "book0",
        markets: [
          {
            key: "player_pass_yds",
            outcomes: [
              { name: "Over", price: -110, point: 250.5, description: "QB One" },
              { name: "Under", price: -110, point: 250.5, description: "QB One" },
              { name: "Over", price: -110, point: 199.5, description: "QB Two" },
              { name: "Under", price: -110, point: 199.5, description: "QB Two" },
            ],
          },
        ],
      },
      {
        key: "book1",
        markets: [
          {
            key: "player_pass_yds",
            outcomes: [
              { name: "Over", price: -110, point: 250.5, description: "QB One" },
              { name: "Under", price: -110, point: 250.5, description: "QB One" },
              { name: "Over", price: -110, point: 199.5, description: "QB Two" },
              { name: "Under", price: -110, point: 199.5, description: "QB Two" },
            ],
          },
        ],
      },
    ]);
    const rows = surveyMarkets([twoPlayers], "test");
    expect(rows[0].meanOverroundPercent).toBeCloseTo(4.76, 1);
    // Two players, two sides each.
    expect(rows[0].outcomes).toBe(4);
  });

  it("ignores outcomes quoted by too few books to form a consensus", () => {
    const lonely = event("e1", [
      { key: "solo", markets: [{ key: "totals", outcomes: [{ name: "Over", price: 400 }, { name: "Under", price: -600 }] }] },
    ]);
    expect(surveyMarkets([lonely], "test", { minBooks: 2 })).toEqual([]);
  });

  it("skips a book quoting only one side, which cannot be de-vigged", () => {
    const halfQuote = event("e1", [
      ...agreeingBooks("totals", -110, -110, 2),
      { key: "partial", markets: [{ key: "totals", outcomes: [{ name: "Over", price: 5000 }] }] },
    ]);
    const rows = surveyMarkets([halfQuote], "test");
    // The absurd one-sided 5000 must not become the "best price".
    expect(rows[0].medianBookCount).toBe(2);
    expect(rows[0].meanBestPriceEdgePercent).toBeLessThan(1);
  });

  it("counts distinct events and ranks markets by exploitability", () => {
    const rows = surveyMarkets(
      [
        event("e1", agreeingBooks("tight", -110, -110, 4)),
        event("e2", agreeingBooks("tight", -110, -110, 4)),
        event("e3", [
          { key: "b0", markets: [{ key: "loose", outcomes: [{ name: "Over", price: -200 }, { name: "Under", price: 160 }] }] },
          { key: "b1", markets: [{ key: "loose", outcomes: [{ name: "Over", price: 160 }, { name: "Under", price: -200 }] }] },
        ]),
      ],
      "test",
    );
    expect(rows.find((r) => r.market === "tight")!.events).toBe(2);
    // Sorted most exploitable first.
    expect(rows[0].market).toBe("loose");
  });

  it("returns nothing for an empty slate rather than throwing", () => {
    expect(surveyMarkets([], "test")).toEqual([]);
  });
});

describe("interpretSurvey", () => {
  it("says plainly when there was nothing to measure", () => {
    expect(interpretSurvey([])[0]).toMatch(/nothing to measure|no markets/i);
  });

  it("names the most exploitable market", () => {
    const rows = surveyMarkets(
      [
        event("e1", agreeingBooks("tight", -110, -110, 4)),
        event("e2", [
          { key: "b0", markets: [{ key: "loose", outcomes: [{ name: "Over", price: -200 }, { name: "Under", price: 160 }] }] },
          { key: "b1", markets: [{ key: "loose", outcomes: [{ name: "Over", price: 160 }, { name: "Under", price: -200 }] }] },
        ]),
      ],
      "test",
    );
    expect(interpretSurvey(rows).join(" ")).toMatch(/loose/);
  });

  it("warns about the book-count bias in the headline metric", () => {
    const rows = surveyMarkets([event("e1", agreeingBooks("totals", -110, -110, 4))], "test");
    expect(interpretSurvey(rows).join(" ")).toMatch(/book count/i);
  });

  it("flags thinly covered markets as fragile", () => {
    const rows = surveyMarkets(
      [
        event("e1", [
          { key: "b0", markets: [{ key: "thin", outcomes: [{ name: "Over", price: -110 }, { name: "Under", price: -110 }] }] },
          { key: "b1", markets: [{ key: "thin", outcomes: [{ name: "Over", price: -115 }, { name: "Under", price: -105 }] }] },
        ]),
      ],
      "test",
    );
    expect(interpretSurvey(rows).join(" ")).toMatch(/three or fewer books/i);
  });
});
