/**
 * Pure outcome-grading math for pitcher-strikeout paper trades. No I/O — the
 * actual strikeout total is fetched elsewhere (see k-outcomes.ts) and fed in
 * here, mirroring the grading-math.ts / grading.ts split for game lines.
 */

export type KOutcome = "won" | "lost" | "push";

/**
 * Grades an Over/Under strikeout selection against the pitcher's actual
 * strikeout total. Integer lines can push; half-point lines cannot.
 */
export function gradeKOutcome(selection: "Over" | "Under", point: number, actualStrikeouts: number): KOutcome {
  if (actualStrikeouts === point) return "push";
  const overHit = actualStrikeouts > point;
  return (selection === "Over") === overHit ? "won" : "lost";
}
