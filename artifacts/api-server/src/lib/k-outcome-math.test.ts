import { describe, expect, it } from "vitest";
import { gradeKOutcome } from "./k-outcome-math";

describe("gradeKOutcome", () => {
  it("grades an Over win when actual clears the line", () => {
    expect(gradeKOutcome("Over", 5.5, 6)).toBe("won");
  });

  it("grades an Over loss when actual falls short", () => {
    expect(gradeKOutcome("Over", 5.5, 5)).toBe("lost");
  });

  it("grades an Under win when actual stays below the line", () => {
    expect(gradeKOutcome("Under", 6.5, 6)).toBe("won");
  });

  it("grades an Under loss when actual clears the line", () => {
    expect(gradeKOutcome("Under", 6.5, 7)).toBe("lost");
  });

  it("pushes on an exact integer line for both sides", () => {
    expect(gradeKOutcome("Over", 6, 6)).toBe("push");
    expect(gradeKOutcome("Under", 6, 6)).toBe("push");
  });

  it("never pushes on a half-point line", () => {
    expect(gradeKOutcome("Over", 5.5, 5)).toBe("lost");
    expect(gradeKOutcome("Under", 5.5, 6)).toBe("lost");
  });

  it("handles a zero-strikeout blowup start", () => {
    expect(gradeKOutcome("Under", 4.5, 0)).toBe("won");
    expect(gradeKOutcome("Over", 4.5, 0)).toBe("lost");
  });
});
