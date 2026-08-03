import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  collectOutcomes,
  fairUnder,
  evUnder,
  compareConstructions,
  describeFeed,
  interpretComparison,
  bookValueReport,
  collectPropOutcomes,
  CONSENSUS_SCHEMES,
} from "./consensus-weighting";
import type { OddsEvent } from "./odds";

/**
 * These lock in the mechanism the probe exists to measure: that a flat average
 * across every book lets a large bloc of recreational books outvote the one
 * sharp book in the feed, and that EV computed against that average is
 * therefore a different number from EV computed against the sharp price.
 *
 * The slate below is built so the two disagree by construction. Pinnacle prices
 * the game as a coin flip. Eight European books price the home side as a clear
 * favourite. The three US books you can actually bet sit in between. If the
 * flat average did not drift toward the European bloc, the whole concern would
 * be unfounded and these tests would fail.
 */

const original = process.env.BETTABLE_BOOKS;

beforeEach(() => {
  // vitest.setup.ts sets this to "all", which disables the allowlist entirely.
  // These tests are specifically about what the allowlist does, so it has to be
  // the real production default here.
  process.env.BETTABLE_BOOKS = "draftkings,fanduel,betmgm";
});

afterEach(() => {
  if (original === undefined) delete process.env.BETTABLE_BOOKS;
  else process.env.BETTABLE_BOOKS = original;
});

function book(key: string, title: string, home: number, away: number) {
  return {
    key,
    title,
    markets: [
      {
        key: "h2h",
        outcomes: [
          { name: "New York Yankees", price: home },
          { name: "Boston Red Sox", price: away },
        ],
      },
    ],
  };
}

/** Eight European recreational books, all pricing the Yankees as a favourite. */
const EURO_BLOC = [
  "winamax",
  "betclic",
  "unibet_nl",
  "pmu",
  "tipico",
  "leovegas",
  "nordicbet",
  "onexbet",
].map((k) => book(k, k, -140, 115));

function slate(): OddsEvent[] {
  return [
    {
      id: "evt-1",
      sport_key: "baseball_mlb",
      commence_time: "2026-08-03T23:06:00Z",
      home_team: "New York Yankees",
      away_team: "Boston Red Sox",
      bookmakers: [
        // Low vig, symmetric: a true coin flip after de-vigging.
        book("pinnacle", "Pinnacle", -105, -105),
        book("draftkings", "DraftKings", 100, -125),
        book("fanduel", "FanDuel", -102, -120),
        book("betmgm", "BetMGM", -105, -118),
        ...EURO_BLOC,
      ],
    },
  ] as unknown as OddsEvent[];
}

function yankees() {
  const outcomes = collectOutcomes(slate(), "shin");
  const o = outcomes.find((x) => x.selection === "New York Yankees");
  if (!o) throw new Error("fixture did not produce the outcome under test");
  return o;
}

describe("collectOutcomes", () => {
  it("keeps every book's opinion separately rather than pre-averaging", () => {
    const o = yankees();
    expect(o.fairByBook.size).toBe(12);
    expect(o.fairByBook.has("pinnacle")).toBe(true);
    expect(o.fairByBook.has("winamax")).toBe(true);
  });

  it("takes the best price only from books on the allowlist", () => {
    const o = yankees();
    // DraftKings at +100 is the best of the three bettable books. The European
    // books are never eligible to set this price even when they quote better.
    expect(o.bestBettable).toEqual({ americanOdds: 100, book: "DraftKings" });
  });

  it("de-vigs a symmetric market to an exact coin flip", () => {
    const o = yankees();
    expect(o.fairByBook.get("pinnacle")).toBeCloseTo(0.5, 10);
  });
});

describe("fairUnder", () => {
  it("reads the sharp price straight off Pinnacle", () => {
    expect(fairUnder(yankees(), "sharp")).toBeCloseTo(0.5, 10);
  });

  it("drifts toward the European bloc under a flat average", () => {
    const o = yankees();
    const sharp = fairUnder(o, "sharp")!;
    const all = fairUnder(o, "all")!;
    // This is the whole concern in one assertion: eight books that cannot be bet
    // pull the consensus away from the one book that prices sharply.
    expect(all).toBeGreaterThan(sharp);
    expect(all).toBeGreaterThan(0.53);
  });

  it("excludes sharp books from the non-sharp construction", () => {
    const o = yankees();
    expect(fairUnder(o, "non-sharp")).toBeGreaterThan(fairUnder(o, "all")!);
  });

  it("uses only the allowlist for the bettable construction", () => {
    const o = yankees();
    const bettable = fairUnder(o, "bettable")!;
    // Worth noting because it is not the intuitive ordering: the three US books
    // shade the Yankees *below* Pinnacle's coin flip, while the European bloc
    // pushes well above it. The bettable consensus is therefore the lowest of
    // the three, which is exactly why measuring the best US price against a
    // consensus the European books dominate produces a flattering number.
    expect(bettable).toBeLessThan(fairUnder(o, "sharp")!);
    expect(bettable).toBeLessThan(fairUnder(o, "non-sharp")!);
    expect(bettable).toBeCloseTo(0.479, 2);
  });

  it("puts the blend between the sharp price and the flat average", () => {
    const o = yankees();
    const blend = fairUnder(o, "blend")!;
    expect(blend).toBeGreaterThan(fairUnder(o, "sharp")!);
    expect(blend).toBeLessThan(fairUnder(o, "all")!);
  });

  it("returns null when a construction has no books to speak for it", () => {
    const noSharp: OddsEvent[] = [
      {
        id: "evt-2",
        sport_key: "baseball_mlb",
        commence_time: "2026-08-03T23:06:00Z",
        home_team: "New York Yankees",
        away_team: "Boston Red Sox",
        bookmakers: [book("draftkings", "DraftKings", -110, -110), ...EURO_BLOC],
      },
    ] as unknown as OddsEvent[];
    const o = collectOutcomes(noSharp, "shin").find((x) => x.selection === "New York Yankees")!;
    expect(fairUnder(o, "sharp")).toBeNull();
    // Falls back to the flat average rather than going null, so the blend still
    // scores outcomes Pinnacle happens not to quote.
    expect(fairUnder(o, "blend")).toBeCloseTo(fairUnder(o, "all")!, 10);
  });

  it("requires two books before calling anything a consensus", () => {
    const thin: OddsEvent[] = [
      {
        id: "evt-3",
        sport_key: "baseball_mlb",
        commence_time: "2026-08-03T23:06:00Z",
        home_team: "New York Yankees",
        away_team: "Boston Red Sox",
        bookmakers: [book("draftkings", "DraftKings", -110, -110)],
      },
    ] as unknown as OddsEvent[];
    const o = collectOutcomes(thin, "shin").find((x) => x.selection === "New York Yankees")!;
    expect(fairUnder(o, "all")).toBeNull();
    expect(fairUnder(o, "bettable")).toBeNull();
  });
});

describe("evUnder", () => {
  it("turns the same price into a very different edge depending on the anchor", () => {
    const o = yankees();
    // +100 against a coin flip is exactly break-even. Anything above zero here
    // is the European bloc talking, not an opportunity at DraftKings.
    expect(evUnder(o, "sharp")).toBeCloseTo(0, 6);
    expect(evUnder(o, "all")!).toBeGreaterThan(5);
  });
});

describe("compareConstructions", () => {
  it("scores every construction and counts what clears the floor", () => {
    const outcomes = collectOutcomes(slate(), "shin");
    const stats = compareConstructions(outcomes, 1);
    expect(stats.map((s) => s.scheme)).toEqual([...CONSENSUS_SCHEMES]);

    const all = stats.find((s) => s.scheme === "all")!;
    const sharp = stats.find((s) => s.scheme === "sharp")!;
    // The flat average finds an edge worth betting; the sharp anchor does not.
    expect(all.clearingFloor).toBeGreaterThan(0);
    expect(sharp.clearingFloor).toBe(0);
    expect(all.meanEvPercent!).toBeGreaterThan(sharp.meanEvPercent!);
  });
});

describe("describeFeed", () => {
  it("counts the books that neither anchor the price nor can be bet", () => {
    const outcomes = collectOutcomes(slate(), "shin");
    const feed = describeFeed(slate(), outcomes);
    expect(feed.distinctBooks).toBe(12);
    expect(feed.sharpBooks).toEqual(["pinnacle"]);
    expect(feed.bettableBooks).toEqual(["betmgm", "draftkings", "fanduel"]);
    // Eight of twelve books are dead weight in the average: unbettable and
    // unsharp. That ratio is the reason this module exists.
    expect(feed.neitherCount).toBe(8);
    expect(feed.medianBooksPerOutcome).toBe(12);
  });
});

describe("interpretComparison", () => {
  it("calls out the flat average as flattering when the sharp anchor is lower", () => {
    const stats = compareConstructions(collectOutcomes(slate(), "shin"), 1);
    const read = interpretComparison(stats, 1);
    expect(read).toContain("flattering");
    expect(read).toContain("Clearing 1%");
  });

  it("says so plainly when the two constructions basically agree", () => {
    const agreeing: OddsEvent[] = [
      {
        id: "evt-4",
        sport_key: "baseball_mlb",
        commence_time: "2026-08-03T23:06:00Z",
        home_team: "New York Yankees",
        away_team: "Boston Red Sox",
        bookmakers: [
          book("pinnacle", "Pinnacle", -105, -105),
          book("draftkings", "DraftKings", -105, -105),
          book("fanduel", "FanDuel", -105, -105),
          book("winamax", "winamax", -105, -105),
        ],
      },
    ] as unknown as OddsEvent[];
    const stats = compareConstructions(collectOutcomes(agreeing, "shin"), 1);
    expect(interpretComparison(stats, 1)).toContain("defensible");
  });
});

describe("bookValueReport", () => {
  /**
   * The question these lock in: given a scan you already paid for, which books
   * sitting in the feed would actually improve your prices if you could bet
   * them? A book quoting every outcome is worthless if it never beats what you
   * already have, and the report has to say that rather than rewarding volume.
   */
  const CURRENT = new Set(["draftkings", "fanduel", "betmgm"]);

  it("never proposes a book already on the allowlist", () => {
    const outcomes = collectOutcomes(slate(), "shin");
    const report = bookValueReport(outcomes, CURRENT, "all", 1);
    expect(report.currentAllowlist).toEqual(["betmgm", "draftkings", "fanduel"]);
    for (const c of report.candidates) {
      expect(CURRENT.has(c.book)).toBe(false);
    }
    // Pinnacle and the eight European books, and nothing else.
    expect(report.candidates.length).toBe(9);
  });

  it("scores a book by whether it improves the price, not by how much it quotes", () => {
    const withDud: OddsEvent[] = [
      {
        id: "evt-5",
        sport_key: "baseball_mlb",
        commence_time: "2026-08-03T23:06:00Z",
        home_team: "New York Yankees",
        away_team: "Boston Red Sox",
        bookmakers: [
          book("pinnacle", "Pinnacle", -105, -105),
          book("draftkings", "DraftKings", 100, -125),
          book("fanduel", "FanDuel", -102, -120),
          book("betmgm", "BetMGM", -105, -118),
          // Quotes both sides on every outcome and is worse than the allowlist
          // on both. Maximum volume, zero value.
          book("duddson", "Duddson", -150, -200),
        ],
      },
    ] as unknown as OddsEvent[];

    const report = bookValueReport(collectOutcomes(withDud, "shin"), CURRENT, "all", 1);
    const dud = report.candidates.find((c) => c.book === "duddson")!;

    expect(dud.outcomesQuoted).toBe(2);
    expect(dud.timesImproves).toBe(0);
    expect(dud.deltaPoints).toBeCloseTo(0, 10);
  });

  it("credits a book only on the side where it actually beats the allowlist", () => {
    const outcomes = collectOutcomes(slate(), "shin");
    const report = bookValueReport(outcomes, CURRENT, "all", 1);
    const euro = report.candidates.find((c) => c.book === "winamax")!;

    // Quotes both sides. DraftKings' +100 already beats its -140 on the Yankees,
    // but its +115 on the Red Sox beats BetMGM's -118 by a wide margin.
    expect(euro.outcomesQuoted).toBe(2);
    expect(euro.timesImproves).toBe(1);
    expect(euro.deltaPoints!).toBeGreaterThan(0);
  });

  it("ranks candidates by how far they move mean EV", () => {
    const report = bookValueReport(collectOutcomes(slate(), "shin"), CURRENT, "all", 1);
    const deltas = report.candidates.map((c) => c.deltaPoints ?? -Infinity);
    expect(deltas).toEqual([...deltas].sort((a, b) => b - a));
  });

  it("reports a ceiling that no single addition can beat", () => {
    const report = bookValueReport(collectOutcomes(slate(), "shin"), CURRENT, "all", 1);
    expect(report.ceilingMeanEvPercent!).toBeGreaterThanOrEqual(report.baselineMeanEvPercent!);
    for (const c of report.candidates) {
      expect(c.meanEvPercent!).toBeLessThanOrEqual(report.ceilingMeanEvPercent! + 1e-9);
    }
  });
});

describe("collectPropOutcomes", () => {
  /**
   * Props arrive as one flat array per book covering every player, so the
   * Over/Under pair the vig lives inside has to be rebuilt before anything can
   * be de-vigged. These lock in that reassembly, and in particular the refusal
   * to de-vig a pair that is not exactly one Over and one Under, which is where
   * a careless implementation invents edges out of alternate-line artifacts.
   */
  function propBook(
    key: string,
    title: string,
    rows: Array<{ player: string; name: string; price: number; point: number }>,
  ) {
    return {
      key,
      title,
      markets: [
        {
          key: "batter_hits",
          outcomes: rows.map((r) => ({
            name: r.name,
            price: r.price,
            point: r.point,
            description: r.player,
          })),
        },
      ],
    };
  }

  function judge(over: number, under: number, point = 1.5) {
    return [
      { player: "Aaron Judge", name: "Over", price: over, point },
      { player: "Aaron Judge", name: "Under", price: under, point },
    ];
  }

  function propEvent(bookmakers: unknown[]): OddsEvent {
    return {
      id: "evt-prop-1",
      sport_key: "baseball_mlb",
      commence_time: "2026-08-03T23:06:00Z",
      home_team: "New York Yankees",
      away_team: "Boston Red Sox",
      bookmakers,
    } as unknown as OddsEvent;
  }

  it("rebuilds the Over/Under pair and names the player in the selection", () => {
    const outcomes = collectPropOutcomes(
      propEvent([
        propBook("pinnacle", "Pinnacle", judge(-105, -105)),
        propBook("draftkings", "DraftKings", judge(110, -130)),
        propBook("fanduel", "FanDuel", judge(105, -125)),
      ]),
      "shin",
    );

    expect(outcomes.length).toBe(2);
    const over = outcomes.find((o) => o.selection === "Aaron Judge Over")!;
    expect(over).toBeDefined();
    expect(over.market).toBe("batter_hits");
    expect(over.point).toBe(1.5);
    expect(over.fairByBook.size).toBe(3);
    expect(over.fairByBook.get("pinnacle")).toBeCloseTo(0.5, 10);
  });

  it("takes the best price only from the allowlist, as game lines do", () => {
    const outcomes = collectPropOutcomes(
      propEvent([
        // Quotes the best Over price on the board and must still be ignored.
        propBook("winamax", "winamax", judge(150, -200)),
        propBook("draftkings", "DraftKings", judge(110, -130)),
        propBook("fanduel", "FanDuel", judge(105, -125)),
      ]),
      "shin",
    );
    const over = outcomes.find((o) => o.selection === "Aaron Judge Over")!;
    expect(over.bestBettable).toEqual({ americanOdds: 110, book: "DraftKings" });
    // The unbettable book still feeds the consensus, which is the whole point
    // of keeping the two roles separate.
    expect(over.fairByBook.has("winamax")).toBe(true);
  });

  it("refuses to de-vig anything that is not exactly one Over and one Under", () => {
    const outcomes = collectPropOutcomes(
      propEvent([
        propBook("draftkings", "DraftKings", [
          // One-sided quote: no Under to pair with, so no overround to remove.
          { player: "Anthony Volpe", name: "Over", price: 120, point: 0.5 },
          // Duplicate side from the same book at the same line.
          { player: "Trent Grisham", name: "Over", price: 100, point: 1.5 },
          { player: "Trent Grisham", name: "Over", price: 105, point: 1.5 },
          ...judge(110, -130),
        ]),
        propBook("fanduel", "FanDuel", judge(105, -125)),
      ]),
      "shin",
    );

    // Only Judge survives; the orphan and the duplicate pair are dropped.
    expect(new Set(outcomes.map((o) => o.selection))).toEqual(
      new Set(["Aaron Judge Over", "Aaron Judge Under"]),
    );
  });

  it("keeps separate lines on the same player separate", () => {
    const outcomes = collectPropOutcomes(
      propEvent([
        propBook("draftkings", "DraftKings", [...judge(110, -130, 1.5), ...judge(260, -320, 2.5)]),
        propBook("fanduel", "FanDuel", [...judge(105, -125, 1.5), ...judge(250, -310, 2.5)]),
      ]),
      "shin",
    );
    const points = outcomes.filter((o) => o.selection === "Aaron Judge Over").map((o) => o.point);
    expect(new Set(points)).toEqual(new Set([1.5, 2.5]));
  });

  it("ignores team-market rows that carry no player", () => {
    const outcomes = collectPropOutcomes(
      propEvent([
        {
          key: "draftkings",
          title: "DraftKings",
          markets: [
            {
              key: "h2h",
              outcomes: [
                { name: "New York Yankees", price: -110 },
                { name: "Boston Red Sox", price: -110 },
              ],
            },
          ],
        },
        propBook("fanduel", "FanDuel", judge(105, -125)),
      ]),
      "shin",
    );
    expect(outcomes.every((o) => o.selection.startsWith("Aaron Judge"))).toBe(true);
  });

  it("feeds the same reports game lines use", () => {
    const outcomes = collectPropOutcomes(
      propEvent([
        propBook("pinnacle", "Pinnacle", judge(-105, -105)),
        propBook("draftkings", "DraftKings", judge(110, -130)),
        propBook("fanduel", "FanDuel", judge(105, -125)),
        propBook("betmgm", "BetMGM", judge(100, -120)),
        propBook("caesars", "Caesars", judge(125, -145)),
      ]),
      "shin",
    );

    const stats = compareConstructions(outcomes, 1);
    expect(stats.map((s) => s.scheme)).toEqual([...CONSENSUS_SCHEMES]);

    const value = bookValueReport(outcomes, new Set(["draftkings", "fanduel", "betmgm"]), "all", 1);
    const caesars = value.candidates.find((c) => c.book === "caesars")!;
    // +125 beats DraftKings' +110 on the Over, so it earns its improvement.
    expect(caesars.timesImproves).toBe(1);
    expect(caesars.deltaPoints!).toBeGreaterThan(0);
  });
});
