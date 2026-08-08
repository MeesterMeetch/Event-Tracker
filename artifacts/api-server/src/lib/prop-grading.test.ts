import { describe, expect, it } from "vitest";
import { resolveSettlement, parsePaperTradeId } from "./prop-grading";

/**
 * Guards the two decisions that could put a wrong number in the ledger.
 *
 * A wrong settlement is silently wrong: it shows up as profit or loss that
 * never happened and nothing announces it. A late one is merely late. So every
 * ambiguous case here has to abstain rather than guess.
 */

describe("resolveSettlement", () => {
  const bet = { americanOdds: -110, units: 1 };

  it("abstains while the paper trade is ungraded", () => {
    // The normal state for tonight's board. Not an error, and not a warning.
    expect(resolveSettlement(bet, null)).toBeNull();
    expect(resolveSettlement(bet, undefined)).toBeNull();
  });

  it("abstains on an outcome it does not recognise", () => {
    expect(resolveSettlement(bet, "cancelled")).toBeNull();
    expect(resolveSettlement(bet, "")).toBeNull();
  });

  it("carries won and lost straight across", () => {
    expect(resolveSettlement(bet, "won")?.status).toBe("won");
    expect(resolveSettlement(bet, "lost")?.status).toBe("lost");
  });

  /**
   * A pitcher scratched from his start voids the prop at the book: stake back,
   * no action. Grading that as a loss would invent losses that never happened,
   * and they would compound quietly through ROI and CLV.
   */
  it("treats a voided trade as a push, not a loss", () => {
    const settled = resolveSettlement(bet, "void");
    expect(settled?.status).toBe("push");
    expect(settled?.pnl).toBe(0);
  });

  it("prices from the bet, not the trade", () => {
    // A promotion can be sized differently and the odds corrected afterwards,
    // so pnl must come from what was actually wagered.
    expect(resolveSettlement({ americanOdds: 150, units: 2 }, "won")?.pnl).toBe(3);
    expect(resolveSettlement({ americanOdds: -200, units: 2 }, "lost")?.pnl).toBe(-2);
  });
});

describe("parsePaperTradeId", () => {
  it("recovers the id from the note the promote button used to leave", () => {
    expect(parsePaperTradeId("Promoted from Strikeout Model paper trade #417")).toBe(417);
  });

  it("is not fooled by a note without one", () => {
    expect(parsePaperTradeId("logged by hand at the book")).toBeNull();
    expect(parsePaperTradeId(null)).toBeNull();
    expect(parsePaperTradeId(undefined)).toBeNull();
    expect(parsePaperTradeId("paper trade #")).toBeNull();
  });

  it("rejects a zero id rather than linking to nothing", () => {
    expect(parsePaperTradeId("paper trade #0")).toBeNull();
  });
});
