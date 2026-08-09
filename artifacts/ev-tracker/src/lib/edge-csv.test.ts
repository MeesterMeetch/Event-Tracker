import { describe, expect, it } from "vitest";
import { edgeColumns } from "./edge-csv";
import { toCsv } from "./csv";

/**
 * These columns are shared by Live Edges, Player Props and Top Plays. The point
 * of sharing them is that the three files line up when piled into one sheet, so
 * what is worth pinning is the header list itself and the fact that the same
 * definitions work whether the row is an edge or wraps one.
 */

function edge(over: Record<string, unknown> = {}) {
  return {
    gameId: "g1",
    sport: "baseball_mlb",
    commenceTime: "2026-08-08T23:05:00Z",
    homeTeam: "Los Angeles Dodgers",
    awayTeam: "San Francisco Giants",
    market: "h2h",
    selection: "Los Angeles Dodgers",
    point: null,
    player: null,
    americanOdds: -110,
    book: "DraftKings",
    dkOdds: -110,
    fairOdds: -104,
    marketProb: 50.9,
    evPercent: 2.4,
    sharpProb: 51.3,
    publicProb: 48.8,
    bookCount: 12,
    dispersionPercent: 1.2,
    confidenceTier: "solid",
    confidenceScore: 90,
    confidenceReasons: ["12 books quoting", "sharp books agree"],
    ...over,
  } as never;
}

describe("edgeColumns", () => {
  it("reads a bare edge", () => {
    const csv = toCsv([edge()], edgeColumns((e) => e));
    const [head, row] = csv.split("\r\n");
    expect(head.split(",")[0]).toBe("evPercent");
    expect(row.split(",")[0]).toBe("2.4");
  });

  /**
   * The same definitions have to serve a Top Play, which wraps its edge one
   * level down. Without the accessor the column list gets copied per page and
   * drifts, and a drifted export fails quietly: the files just stop aligning.
   */
  it("reads an edge nested inside another row", () => {
    const wrapped = { rank: 1, edge: edge() };
    const csv = toCsv([wrapped], edgeColumns((r: typeof wrapped) => r.edge));
    expect(csv.split("\r\n")[1].split(",")[0]).toBe("2.4");
  });

  it("joins confidence reasons into one field rather than breaking the row", () => {
    const cols = edgeColumns((e: never) => e);
    const csv = toCsv([edge()], cols);
    const cells = csv.split("\r\n")[1].split(",");
    // Semicolons rather than commas on purpose: the field needs no quoting, and
    // the row keeps exactly one cell per column instead of silently gaining one
    // and shifting every value after it.
    expect(cells).toHaveLength(cols.length);
    expect(cells[cols.findIndex((c) => c.header === "confidenceReasons")]).toBe(
      "12 books quoting; sharp books agree",
    );
  });

  it("keeps a null sharp price empty rather than writing the word null", () => {
    const csv = toCsv([edge({ sharpProb: null, player: null })], edgeColumns((e) => e));
    const cols = edgeColumns((e: never) => e).map((c) => c.header);
    const cells = csv.split("\r\n")[1].split(",");
    expect(cells[cols.indexOf("sharpProb")]).toBe("");
  });

  it("omits the scan stamp when none is given, and adds it when one is", () => {
    expect(edgeColumns((e: never) => e).some((c) => c.header === "scannedAt")).toBe(false);
    const stamped = edgeColumns((e: never) => e, "2026-08-08T15:00:00Z");
    expect(stamped[stamped.length - 1].header).toBe("scannedAt");
  });
});
