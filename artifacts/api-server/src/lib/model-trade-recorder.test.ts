import { afterEach, describe, expect, it } from "vitest";
import { paperTradeRowsFrom, modelAutologEnabled } from "./model-trade-recorder";
import type { ModelPitcherProjection, ModelKLine } from "./pitcher-k-scanner";

/**
 * Guards the shaping and the gate, not the insert.
 *
 * The property that matters most here is that unflagged lines are recorded.
 * Calibration needs an unbiased sample across the probability range; a table
 * containing only the model's confident picks produces a curve describing the
 * selection rather than the model, and that error is invisible once it is
 * baked into every future price.
 */

function line(over: Partial<ModelKLine> = {}): ModelKLine {
  return {
    point: 5.5,
    selection: "Over",
    americanOdds: -110,
    book: "draftkings",
    marketProb: 0.5,
    modelProb: 0.62,
    edgePercent: 18.3,
    fullKellyFraction: 0.1,
    recommendedUnits: 1,
    isFlagged: true,
    dkOdds: -110,
    ...over,
  } as ModelKLine;
}

function projection(over: Partial<ModelPitcherProjection> = {}): ModelPitcherProjection {
  return {
    gameId: "g1",
    sport: "baseball_mlb",
    commenceTime: "2026-08-05T23:05:00Z",
    homeTeam: "Los Angeles Dodgers",
    awayTeam: "San Francisco Giants",
    pitcher: "Blake Snell",
    team: "Los Angeles Dodgers",
    opponent: "San Francisco Giants",
    throws: "L",
    projectedBattersFaced: 23.4,
    expectedStrikeouts: 6.1,
    ratePerBF: 0.26,
    opponentFactor: 1.02,
    sampleStarts: 10,
    sampleBattersFaced: 230,
    kPer9: 10.8,
    opponentDataAvailable: true,
    insufficientData: false,
    lines: [line()],
    ...over,
  } as ModelPitcherProjection;
}

const origUrl = process.env.DATABASE_URL;
const origFlag = process.env.MODEL_AUTOLOG_ENABLED;

afterEach(() => {
  if (origUrl == null) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = origUrl;
  if (origFlag == null) delete process.env.MODEL_AUTOLOG_ENABLED;
  else process.env.MODEL_AUTOLOG_ENABLED = origFlag;
});

describe("paperTradeRowsFrom", () => {
  it("records unflagged lines too, so the calibration sample is unbiased", () => {
    const rows = paperTradeRowsFrom(
      [projection({ lines: [line({ isFlagged: true }), line({ point: 6.5, isFlagged: false })] })],
      "baseball_mlb",
      0.25,
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.isFlagged).sort()).toEqual([false, true]);
  });

  it("skips a starter whose rate inputs were missing or degraded", () => {
    const rows = paperTradeRowsFrom(
      [projection({ insufficientData: true })],
      "baseball_mlb",
      0.25,
    );
    // A projection built off the league average is not a prediction, and it
    // would poison the calibration it is meant to inform.
    expect(rows).toEqual([]);
  });

  it("skips a line with no de-vigged market to measure against", () => {
    const rows = paperTradeRowsFrom(
      [projection({ lines: [line({ marketProb: null })] })],
      "baseball_mlb",
      0.25,
    );
    expect(rows).toEqual([]);
  });

  it("carries the inputs the report needs, including the kelly multiplier", () => {
    const [row] = paperTradeRowsFrom([projection()], "baseball_mlb", 0.25);
    expect(row.kellyMultiplier).toBe(0.25);
    expect(row.projectedBattersFaced).toBe(23.4);
    expect(row.expectedStrikeouts).toBe(6.1);
    expect(row.modelProb).toBe(0.62);
    expect(row.marketProb).toBe(0.5);
    expect(row.commenceTime).toBeInstanceOf(Date);
  });
});

describe("modelAutologEnabled", () => {
  it("is off when there is no database, which is what keeps tests off Postgres", () => {
    delete process.env.DATABASE_URL;
    expect(modelAutologEnabled()).toBe(false);
  });

  it("is on by default once a database is configured", () => {
    process.env.DATABASE_URL = "postgres://example";
    delete process.env.MODEL_AUTOLOG_ENABLED;
    expect(modelAutologEnabled()).toBe(true);
  });

  it("can be switched off explicitly", () => {
    process.env.DATABASE_URL = "postgres://example";
    process.env.MODEL_AUTOLOG_ENABLED = "false";
    expect(modelAutologEnabled()).toBe(false);
  });
});
