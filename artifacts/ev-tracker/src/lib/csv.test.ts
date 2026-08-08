import { describe, expect, it } from "vitest";
import { toCsv, csvFilename, type CsvColumn } from "./csv";

/**
 * The escaping is the whole job. Team names carry commas, rationales carry the
 * separator character, and a file that opens one column out of alignment is
 * worse than no export at all because the error is not obvious.
 */

interface Row {
  a: string;
  b: number | null;
  c?: boolean;
}

const cols: CsvColumn<Row>[] = [
  { header: "a", value: (r) => r.a },
  { header: "b", value: (r) => r.b },
  { header: "c", value: (r) => r.c },
];

describe("toCsv", () => {
  it("writes a header even with no rows", () => {
    expect(toCsv([], cols)).toBe("a,b,c\r\n");
  });

  it("quotes a field containing the separator", () => {
    const csv = toCsv([{ a: "Boston Red Sox, ML", b: 1 }], cols);
    expect(csv).toContain('"Boston Red Sox, ML"');
  });

  it("doubles embedded quotes rather than breaking the row", () => {
    const csv = toCsv([{ a: 'he said "value"', b: 1 }], cols);
    expect(csv).toContain('"he said ""value"""');
  });

  it("quotes a field containing a newline", () => {
    const csv = toCsv([{ a: "line one\nline two", b: 1 }], cols);
    expect(csv).toContain('"line one\nline two"');
  });

  it("writes null and undefined as empty rather than the words", () => {
    const csv = toCsv([{ a: "x", b: null }], cols);
    expect(csv.split("\r\n")[1]).toBe("x,,");
  });

  it("leaves an ordinary value unquoted", () => {
    expect(toCsv([{ a: "DraftKings", b: -110, c: true }], cols).split("\r\n")[1]).toBe(
      "DraftKings,-110,true",
    );
  });
});

describe("csvFilename", () => {
  it("stamps a name that sorts chronologically", () => {
    expect(csvFilename("top-plays", new Date(2026, 7, 7, 9, 5))).toBe(
      "top-plays-2026-08-07-0905.csv",
    );
  });
});
