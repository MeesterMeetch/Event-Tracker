import { describe, it, expect, afterEach } from "vitest";
import { isBettableBook, bettableBooks, describeBettableBooks } from "./bettable-books";

const original = process.env.BETTABLE_BOOKS;
afterEach(() => {
  if (original === undefined) delete process.env.BETTABLE_BOOKS;
  else process.env.BETTABLE_BOOKS = original;
});

describe("bettable book filtering", () => {
  it("defaults to the US books a Colorado bettor can actually use", () => {
    delete process.env.BETTABLE_BOOKS;
    expect(isBettableBook("draftkings")).toBe(true);
    expect(isBettableBook("fanduel")).toBe(true);
    expect(isBettableBook("betmgm")).toBe(true);
    expect(isBettableBook("betrivers")).toBe(true);
  });

  /**
   * The books that produced every above-1% edge in the all-books test. Two are
   * exchanges, whose prices are not comparable to a de-vigged book consensus,
   * and none will take a bet from Colorado.
   */
  it("excludes the exchanges and offshore books that produced the phantom edges", () => {
    delete process.env.BETTABLE_BOOKS;
    for (const book of ["onexbet", "matchbook", "betfair_ex_eu", "coolbet"]) {
      expect(isBettableBook(book)).toBe(false);
    }
  });

  it("excludes the European books that arrive with the EU region", () => {
    delete process.env.BETTABLE_BOOKS;
    // These all appeared in a real us,eu probe and none will open a US account.
    for (const book of ["winamax_de", "betclic_fr", "unibet_nl", "pmu_fr", "tipico_de", "nordicbet"]) {
      expect(isBettableBook(book)).toBe(false);
    }
  });

  it("excludes Pinnacle from best price while keeping it available elsewhere", () => {
    // Pinnacle is the reason for the EU region and must feed the consensus,
    // but a US bettor cannot place a wager there.
    delete process.env.BETTABLE_BOOKS;
    expect(isBettableBook("pinnacle")).toBe(false);
  });

  it("honours an explicit allowlist", () => {
    process.env.BETTABLE_BOOKS = "draftkings,caesars";
    expect(isBettableBook("draftkings")).toBe(true);
    expect(isBettableBook("caesars")).toBe(true);
    expect(isBettableBook("fanduel")).toBe(false);
  });

  it("normalizes case and whitespace", () => {
    process.env.BETTABLE_BOOKS = " DraftKings , FanDuel ";
    expect(isBettableBook("draftkings")).toBe(true);
    expect(isBettableBook("fanduel")).toBe(true);
  });

  it("disables filtering entirely on 'all'", () => {
    process.env.BETTABLE_BOOKS = "all";
    expect(bettableBooks()).toBeNull();
    expect(isBettableBook("winamax_de")).toBe(true);
    expect(isBettableBook("literally_anything")).toBe(true);
  });

  it("falls back to defaults on an empty value rather than filtering everything out", () => {
    // An empty set would silently produce zero edges, which is a miserable
    // thing to debug.
    process.env.BETTABLE_BOOKS = "   ";
    expect(isBettableBook("draftkings")).toBe(true);
  });

  it("picks up a changed setting rather than caching the first read", () => {
    process.env.BETTABLE_BOOKS = "draftkings";
    expect(isBettableBook("fanduel")).toBe(false);
    process.env.BETTABLE_BOOKS = "draftkings,fanduel";
    expect(isBettableBook("fanduel")).toBe(true);
  });

  it("describes the current setting for logs", () => {
    process.env.BETTABLE_BOOKS = "fanduel,draftkings";
    expect(describeBettableBooks()).toBe("draftkings, fanduel");
    process.env.BETTABLE_BOOKS = "all";
    expect(describeBettableBooks()).toMatch(/no filtering/);
  });
});
