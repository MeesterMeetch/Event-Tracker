import { describe, expect, it } from "vitest";
import { computeModelEdges, MODEL_SPORT_KEY, PITCHER_K_MARKET } from "./pitcher-k-scanner";
import { projectPitcherK, lineProbabilities } from "./pitcher-k-model";
import { americanToDecimal, americanToImpliedProb } from "./odds-math";
import type { OddsEvent } from "./odds";
import type { MatchupKInputs, PitcherKStats, PitcherKMatchupSide } from "./mlb";

/**
 * Guards the model consumer against projecting off empty/degraded K inputs.
 * When getMatchupKInputs degrades (MLB feed failure, unannounced starter) it
 * hands back a pitcher object with zeroed rolling stats and null season/career.
 * The model must abstain and surface insufficient data rather than dress the
 * league-average fallback up as a precise projection.
 */

function pitcher(overrides: Partial<PitcherKStats>): PitcherKStats {
  return {
    id: 1,
    name: "Test Pitcher",
    team: "Home Team",
    throws: "R",
    rollingStrikeouts: 0,
    rollingBattersFaced: 0,
    rollingStarts: 0,
    rollingBfPerStart: null,
    rollingInningsPitched: null,
    seasonStrikeouts: null,
    seasonBattersFaced: null,
    seasonGamesStarted: null,
    careerStrikeouts: null,
    careerBattersFaced: null,
    ...overrides,
  };
}

/** An event quoting an over/under strikeout line for the given pitcher name. */
function eventWithLine(pitcherName: string): OddsEvent {
  return {
    id: "evt1",
    sport_key: MODEL_SPORT_KEY,
    commence_time: "2025-07-02T02:10:00Z",
    home_team: "Home Team",
    away_team: "Away Team",
    bookmakers: [
      {
        key: "book_a",
        title: "Book A",
        markets: [
          {
            key: PITCHER_K_MARKET,
            outcomes: [
              { name: "Over", description: pitcherName, point: 5.5, price: -110 },
              { name: "Under", description: pitcherName, point: 5.5, price: -110 },
            ],
          },
        ],
      },
      {
        key: "book_b",
        title: "Book B",
        markets: [
          {
            key: PITCHER_K_MARKET,
            outcomes: [
              { name: "Over", description: pitcherName, point: 5.5, price: -105 },
              { name: "Under", description: pitcherName, point: 5.5, price: -115 },
            ],
          },
        ],
      },
    ],
  };
}

function inputs(home: PitcherKMatchupSide, away: PitcherKMatchupSide): MatchupKInputs {
  return { home, away };
}

describe("computeModelEdges — abstention on empty K inputs", () => {
  it("abstains and flags insufficient data when a side has no rolling/season/career sample", () => {
    const event = eventWithLine("Test Pitcher");
    const degraded = pitcher({ name: "Test Pitcher", throws: null });
    const result = computeModelEdges(
      event,
      MODEL_SPORT_KEY,
      inputs({ pitcher: degraded, opponent: null }, { pitcher: null, opponent: null }),
      1,
    );

    expect(result).toHaveLength(1);
    const proj = result[0];
    expect(proj.insufficientData).toBe(true);
    expect(proj.lines).toEqual([]);
    // No misleadingly precise numbers leak through.
    expect(proj.expectedStrikeouts).toBe(0);
    expect(proj.ratePerBF).toBe(0);
    expect(proj.pitcher).toBe("Test Pitcher");
  });

  it("still projects a side backed only by season data", () => {
    const event = eventWithLine("Test Pitcher");
    const seasonOnly = pitcher({
      name: "Test Pitcher",
      seasonStrikeouts: 180,
      seasonBattersFaced: 700,
      seasonGamesStarted: 28,
    });
    const result = computeModelEdges(
      event,
      MODEL_SPORT_KEY,
      inputs({ pitcher: seasonOnly, opponent: null }, { pitcher: null, opponent: null }),
      1,
    );

    expect(result).toHaveLength(1);
    const proj = result[0];
    expect(proj.insufficientData).toBe(false);
    expect(proj.lines.length).toBeGreaterThan(0);
    expect(proj.expectedStrikeouts).toBeGreaterThan(0);
  });

  it("projects a real rolling-window side and abstains on the degraded one in the same game", () => {
    const event: OddsEvent = {
      ...eventWithLine("Good Pitcher"),
    };
    // Add lines for the degraded pitcher too so the only reason it's surfaced is
    // the insufficient-data abstention, not the market.
    event.bookmakers = event.bookmakers.map((b) => ({
      ...b,
      markets: b.markets.map((m) => ({
        ...m,
        outcomes: [
          ...m.outcomes,
          { name: "Over", description: "Bad Pitcher", point: 4.5, price: -110 },
          { name: "Under", description: "Bad Pitcher", point: 4.5, price: -110 },
        ],
      })),
    }));

    const good = pitcher({
      name: "Good Pitcher",
      team: "Home Team",
      rollingStrikeouts: 60,
      rollingBattersFaced: 240,
      rollingStarts: 10,
      rollingBfPerStart: 24,
      seasonStrikeouts: 180,
      seasonBattersFaced: 700,
      seasonGamesStarted: 28,
    });
    const bad = pitcher({ name: "Bad Pitcher", team: "Away Team", throws: null });

    const result = computeModelEdges(
      event,
      MODEL_SPORT_KEY,
      inputs({ pitcher: good, opponent: null }, { pitcher: bad, opponent: null }),
      1,
    );

    expect(result).toHaveLength(2);
    const goodProj = result.find((p) => p.pitcher === "Good Pitcher");
    const badProj = result.find((p) => p.pitcher === "Bad Pitcher");
    expect(goodProj?.insufficientData).toBe(false);
    expect(goodProj?.lines.length).toBeGreaterThan(0);
    expect(badProj?.insufficientData).toBe(true);
    expect(badProj?.lines).toEqual([]);
  });
});

/**
 * Guards the market-consensus half of the scanner: de-vigging each book's
 * over/under pair multiplicatively, averaging the fair probabilities across
 * books, picking the best available price, and only flagging an edge when a
 * real 2+ book consensus backs it. A regression here would quietly compute EV
 * against a vig-inflated or single-book "consensus" and flag phantom edges.
 */
describe("computeModelEdges — de-vig consensus and edge flagging", () => {
  /** A pitcher with real rolling+season+career data so the model projects. */
  const ACE = pitcher({
    name: "Ace Pitcher",
    team: "Home Team",
    throws: "R",
    rollingStrikeouts: 70,
    rollingBattersFaced: 250,
    rollingStarts: 10,
    rollingBfPerStart: 25,
    seasonStrikeouts: 200,
    seasonBattersFaced: 720,
    seasonGamesStarted: 30,
    careerStrikeouts: 1500,
    careerBattersFaced: 5400,
  });

  interface BookQuote {
    key: string;
    title: string;
    /** American Over price, or null to omit the Over outcome for this book. */
    over: number | null;
    /** American Under price, or null to omit the Under outcome for this book. */
    under: number | null;
  }

  /** An event quoting one pitcher/point across the given books. */
  function consensusEvent(pitcherName: string, point: number, books: BookQuote[]): OddsEvent {
    return {
      id: "evt-consensus",
      sport_key: MODEL_SPORT_KEY,
      commence_time: "2025-07-02T02:10:00Z",
      home_team: "Home Team",
      away_team: "Away Team",
      bookmakers: books.map((b) => ({
        key: b.key,
        title: b.title,
        markets: [
          {
            key: PITCHER_K_MARKET,
            outcomes: [
              ...(b.over != null ? [{ name: "Over", description: pitcherName, point, price: b.over }] : []),
              ...(b.under != null ? [{ name: "Under", description: pitcherName, point, price: b.under }] : []),
            ],
          },
        ],
      })),
    };
  }

  /** The model probabilities the scanner should derive for ACE at a given point. */
  function aceProbs(point: number) {
    const projection = projectPitcherK(
      {
        throws: ACE.throws,
        rollingStrikeouts: ACE.rollingStrikeouts,
        rollingBattersFaced: ACE.rollingBattersFaced,
        rollingStarts: ACE.rollingStarts,
        rollingBfPerStart: ACE.rollingBfPerStart,
        rollingInningsPitched: ACE.rollingInningsPitched,
        seasonStrikeouts: ACE.seasonStrikeouts,
        seasonBattersFaced: ACE.seasonBattersFaced,
        seasonGamesStarted: ACE.seasonGamesStarted,
        careerStrikeouts: ACE.careerStrikeouts,
        careerBattersFaced: ACE.careerBattersFaced,
      },
      null,
    );
    return lineProbabilities(projection.trials, projection.perTrialProb, point);
  }

  /** Multiplicative (per-book) de-vig of one side of an over/under pair. */
  function devigFair(sidePrice: number, otherPrice: number): number {
    const side = americanToImpliedProb(sidePrice);
    const other = americanToImpliedProb(otherPrice);
    return side / (side + other);
  }

  it("averages the multiplicatively de-vigged fair probability across books", () => {
    // Book A: -110/-110 (fair Over = 0.5). Book B: +120/-140 (fair Over < 0.5).
    const event = consensusEvent("Ace Pitcher", 5.5, [
      { key: "book_a", title: "Book A", over: -110, under: -110 },
      { key: "book_b", title: "Book B", over: 120, under: -140 },
    ]);
    const result = computeModelEdges(
      event,
      MODEL_SPORT_KEY,
      inputs({ pitcher: ACE, opponent: null }, { pitcher: null, opponent: null }),
      1,
    );

    const over = result[0].lines.find((l) => l.selection === "Over")!;
    const under = result[0].lines.find((l) => l.selection === "Under")!;

    const expectedOver = (devigFair(-110, -110) + devigFair(120, -140)) / 2;
    const expectedUnder = (devigFair(-110, -110) + devigFair(-140, 120)) / 2;
    expect(over.marketProb).toBeCloseTo(expectedOver, 10);
    expect(under.marketProb).toBeCloseTo(expectedUnder, 10);
    // De-vigged consensus removes the vig: the two sides sum to 1, not >1.
    expect(over.marketProb! + under.marketProb!).toBeCloseTo(1, 10);
  });

  it("quotes the best available price per side and computes EV against it", () => {
    const event = consensusEvent("Ace Pitcher", 5.5, [
      { key: "book_a", title: "Book A", over: -110, under: -110 },
      { key: "book_b", title: "Book B", over: 120, under: -140 },
    ]);
    const result = computeModelEdges(
      event,
      MODEL_SPORT_KEY,
      inputs({ pitcher: ACE, opponent: null }, { pitcher: null, opponent: null }),
      1,
    );

    const over = result[0].lines.find((l) => l.selection === "Over")!;
    // +120 (decimal 2.2) beats -110 (decimal 1.909) → Book B is the best Over.
    expect(over.americanOdds).toBe(120);
    expect(over.book).toBe("Book B");

    const probs = aceProbs(5.5);
    const bestDecimal = americanToDecimal(120);
    const expectedEdge = Math.round((bestDecimal * probs.condOver - 1) * 100 * 100) / 100;
    expect(over.edgePercent).toBe(expectedEdge);
    expect(over.modelProb).toBe(Math.round(probs.condOver * 1e4) / 1e4);

    // Under's best price is -110 (Book A) since Book B posts -140.
    const under = result[0].lines.find((l) => l.selection === "Under")!;
    expect(under.americanOdds).toBe(-110);
    expect(under.book).toBe("Book A");
  });

  it("flags a side only when the edge clears the threshold AND 2+ books quote it", () => {
    const event = consensusEvent("Ace Pitcher", 5.5, [
      { key: "book_a", title: "Book A", over: -110, under: -110 },
      { key: "book_b", title: "Book B", over: 120, under: -140 },
    ]);
    const over = (minEdge: number) =>
      computeModelEdges(
        event,
        MODEL_SPORT_KEY,
        inputs({ pitcher: ACE, opponent: null }, { pitcher: null, opponent: null }),
        minEdge,
      )[0].lines.find((l) => l.selection === "Over")!;

    const edge = over(1).edgePercent!;
    // A threshold just under the actual edge flags; just over it does not.
    expect(over(edge - 0.5).isFlagged).toBe(true);
    expect(over(edge + 0.5).isFlagged).toBe(false);
  });

  it("never flags a one-book line and reports a null consensus for it", () => {
    // Only Book A quotes the line → books.size < 2, so no consensus.
    const event = consensusEvent("Ace Pitcher", 5.5, [
      { key: "book_a", title: "Book A", over: 400, under: -600 },
    ]);
    const result = computeModelEdges(
      event,
      MODEL_SPORT_KEY,
      inputs({ pitcher: ACE, opponent: null }, { pitcher: null, opponent: null }),
      // A very low threshold: the fat +400 price is a big edge, but a single
      // book must never be treated as a consensus, so it stays unflagged.
      -1000,
    );

    const over = result[0].lines.find((l) => l.selection === "Over")!;
    expect(over.marketProb).toBeNull();
    expect(over.isFlagged).toBe(false);
    // The price/edge are still reported — only the consensus + flag are withheld.
    expect(over.americanOdds).toBe(400);
    expect(over.edgePercent).not.toBeNull();
  });

  it("ignores a book that quotes only one side of the pair for the consensus", () => {
    // Book A posts a full pair; Book B posts only an Over (no Under) → Book B's
    // unpaired quote can't be de-vigged, so it contributes to neither side.
    const event = consensusEvent("Ace Pitcher", 5.5, [
      { key: "book_a", title: "Book A", over: -110, under: -110 },
      { key: "book_b", title: "Book B", over: 120, under: null },
    ]);
    const result = computeModelEdges(
      event,
      MODEL_SPORT_KEY,
      inputs({ pitcher: ACE, opponent: null }, { pitcher: null, opponent: null }),
      1,
    );

    const over = result[0].lines.find((l) => l.selection === "Over")!;
    // Only Book A's paired quote counts, and Book B's unpaired +120 never even
    // sets the best price → the line is Book A's -110, with just one usable book.
    expect(over.americanOdds).toBe(-110);
    expect(over.book).toBe("Book A");
    // One usable book → no consensus → null marketProb → never flagged.
    expect(over.marketProb).toBeNull();
    expect(over.isFlagged).toBe(false);
  });

  it("produces one Over and one Under line for every distinct point quoted", () => {
    const event = consensusEvent("Ace Pitcher", 5.5, [
      { key: "book_a", title: "Book A", over: -110, under: -110 },
      { key: "book_b", title: "Book B", over: -105, under: -115 },
    ]);
    // Add a second point (6.5) quoted by both books.
    event.bookmakers = event.bookmakers.map((b) => ({
      ...b,
      markets: b.markets.map((m) => ({
        ...m,
        outcomes: [
          ...m.outcomes,
          { name: "Over", description: "Ace Pitcher", point: 6.5, price: 110 },
          { name: "Under", description: "Ace Pitcher", point: 6.5, price: -130 },
        ],
      })),
    }));

    const result = computeModelEdges(
      event,
      MODEL_SPORT_KEY,
      inputs({ pitcher: ACE, opponent: null }, { pitcher: null, opponent: null }),
      1,
    );

    const lines = result[0].lines;
    // Two points × two sides = four lines, sorted by point then selection.
    expect(lines.map((l) => `${l.point}|${l.selection}`)).toEqual([
      "5.5|Over",
      "5.5|Under",
      "6.5|Over",
      "6.5|Under",
    ]);
  });
});
