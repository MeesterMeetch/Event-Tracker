/**
 * How much to trust an edge, as distinct from how large it is.
 *
 * EV alone is a misleading way to rank bets, and it is misleading in a
 * specific, costly direction: the biggest numbers on the screen are usually the
 * least real. A twelve percent edge on a liquid market almost never means the
 * market is wrong. It usually means one book's price is stale, a player is
 * scratched and the feed has not caught up, or the line being compared is not
 * the line you think it is. Meanwhile the unglamorous two-to-four percent edges
 * across a deep, agreeing market are the ones that survive contact with a
 * re-scan.
 *
 * So this scores the things that make an edge believable rather than large:
 *
 *   Depth. How many books quote the outcome. A consensus of three books is one
 *     stale quote away from being fiction; fifteen books is a market.
 *   Agreement. How tightly those books cluster once vig is removed. Wide
 *     disagreement means somebody is wrong, and it is not necessarily them.
 *   Sharp alignment. Whether the sharp books, Pinnacle chief among them, agree
 *     with the edge or contradict it. An edge Pinnacle disagrees with is
 *     usually your error rather than their mispricing.
 *   Plausibility. Whether the size of the edge is credible at all for a market
 *     of that depth.
 *
 * The output is deliberately a tier rather than a single number, because a
 * score invites false precision and a tier invites a decision.
 */

export type ConfidenceTier = "solid" | "playable" | "fragile" | "suspect";

export interface ConfidenceInputs {
  /** Distinct books quoting this outcome. */
  bookCount: number;
  /** EV percent of the best available price against consensus. */
  evPercent: number;
  /** Standard deviation of de-vigged fair probabilities across books, in points. */
  dispersionPercent: number | null;
  /** De-vigged consensus among sharp books, as a percent; null when none quote it. */
  sharpProb: number | null;
  /** De-vigged consensus among public books, as a percent; null when none quote it. */
  publicProb: number | null;
  /** Implied win probability of the price being bet, as a percent. */
  impliedProbPercent: number;
}

export interface ConfidenceAssessment {
  tier: ConfidenceTier;
  /** Ordering hint: higher is more trustworthy. Not a probability. */
  score: number;
  /** Short reasons, suitable for a tooltip or a column. */
  reasons: string[];
  /** True when the sharp books actively disagree with this side. */
  sharpDisagrees: boolean;
}

/**
 * Edge sizes above this on a deep market are treated as implausible rather than
 * excellent. Real inefficiencies in a liquid market are small; large ones are
 * nearly always artifacts. The threshold is looser on thin markets, where a
 * genuine outlier price is more believable.
 */
const IMPLAUSIBLE_EV_DEEP = 8;
const IMPLAUSIBLE_EV_THIN = 15;
const DEEP_MARKET_BOOKS = 8;

export function assessConfidence(input: ConfidenceInputs): ConfidenceAssessment {
  const reasons: string[] = [];
  let score = 50;

  // --- Depth ---
  if (input.bookCount >= 12) {
    score += 20;
    reasons.push(`${input.bookCount} books quoting`);
  } else if (input.bookCount >= 6) {
    score += 10;
    reasons.push(`${input.bookCount} books quoting`);
  } else if (input.bookCount >= 4) {
    score += 0;
    reasons.push(`only ${input.bookCount} books`);
  } else {
    score -= 20;
    reasons.push(`thin market, ${input.bookCount} books`);
  }

  // --- Sharp alignment ---
  // The single most informative signal now that Pinnacle is in the feed. If the
  // sharp consensus is below the price's implied probability, the sharps think
  // this side is worse than you are being paid for, which contradicts the edge.
  let sharpDisagrees = false;
  if (input.sharpProb != null) {
    const sharpEdge = input.sharpProb - input.impliedProbPercent;
    if (sharpEdge >= 2) {
      score += 25;
      reasons.push("sharp books agree");
    } else if (sharpEdge >= 0) {
      score += 10;
      reasons.push("sharp books neutral");
    } else if (sharpEdge >= -2) {
      score -= 10;
      reasons.push("sharp books slightly against");
    } else {
      score -= 30;
      sharpDisagrees = true;
      reasons.push("sharp books disagree");
    }
  } else {
    score -= 5;
    reasons.push("no sharp price");
  }

  // --- Agreement ---
  if (input.dispersionPercent != null) {
    if (input.dispersionPercent <= 1) {
      score += 15;
      reasons.push("books tightly agree");
    } else if (input.dispersionPercent <= 3) {
      score += 5;
    } else if (input.dispersionPercent <= 6) {
      score -= 5;
      reasons.push("books disagree");
    } else {
      score -= 15;
      reasons.push("books wildly disagree");
    }
  }

  // --- Plausibility ---
  const deep = input.bookCount >= DEEP_MARKET_BOOKS;
  const implausibleAt = deep ? IMPLAUSIBLE_EV_DEEP : IMPLAUSIBLE_EV_THIN;
  if (input.evPercent >= implausibleAt) {
    score -= 25;
    reasons.push(
      deep
        ? "edge too large for a liquid market, likely stale"
        : "very large edge, verify the line is live",
    );
  }

  // A wide sharp-versus-public gap usually means the public books have not
  // moved yet. That is a real opportunity, but a short-lived one.
  if (input.sharpProb != null && input.publicProb != null) {
    const gap = Math.abs(input.sharpProb - input.publicProb);
    if (gap >= 4) reasons.push("sharp and public diverge, line may be moving");
  }

  score = Math.max(0, Math.min(100, score));

  let tier: ConfidenceTier;
  if (sharpDisagrees) {
    // Overrides everything else. An edge the sharps contradict is usually a
    // mistake in your own numbers, not a market error.
    tier = "suspect";
  } else if (score >= 75) {
    tier = "solid";
  } else if (score >= 55) {
    tier = "playable";
  } else if (score >= 35) {
    tier = "fragile";
  } else {
    tier = "suspect";
  }

  // A two- or three-book market cannot be better than fragile no matter how
  // favourable everything else looks. With that few quotes the "consensus" is
  // one stale price away from being fiction, and a sharp book agreeing with a
  // number nobody else is posting is not the confirmation it appears to be.
  if (input.bookCount < 4 && TIER_ORDER[tier] < TIER_ORDER.fragile) {
    tier = "fragile";
  }

  return { tier, score, reasons, sharpDisagrees };
}

/** Sort helper: solid first, then playable, fragile, suspect. */
export const TIER_ORDER: Record<ConfidenceTier, number> = {
  solid: 0,
  playable: 1,
  fragile: 2,
  suspect: 3,
};

/** One-line explanation of what a tier means, for UI copy. */
export function describeTier(tier: ConfidenceTier): string {
  switch (tier) {
    case "solid":
      return "Deep market, books agree, sharps on side. The kind of edge worth betting repeatedly.";
    case "playable":
      return "Reasonable support. Worth taking, but not a standout.";
    case "fragile":
      return "Thin coverage or meaningful disagreement. Small stake or skip.";
    case "suspect":
      return "Sharps disagree, or the edge is too large to be credible. Usually a stale price rather than an opportunity.";
  }
}
