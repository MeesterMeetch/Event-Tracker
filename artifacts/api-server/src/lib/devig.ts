/**
 * Vig removal. Pure math, no I/O.
 *
 * Every edge this app surfaces depends on turning a bookmaker's priced market
 * into fair probabilities, so the method used here is the single most
 * load-bearing piece of math in the codebase.
 *
 * The obvious approach is proportional (multiplicative) de-vigging: divide each
 * side's implied probability by the overround so they sum to one. It is simple
 * and it is biased. Bookmakers do not spread their margin evenly across a
 * market; they load disproportionately more of it onto the longshot, which is
 * the well-documented favourite-longshot bias. Removing margin proportionally
 * therefore hands back too much probability to the plus-money side and too
 * little to the favourite.
 *
 * That bias is not academic for a +EV scanner. Overstating the longshot's fair
 * probability manufactures phantom edges on exactly the side where the real
 * margin is heaviest, so a scanner using proportional de-vig will systematically
 * point at plus-money outcomes on lopsided markets and call them value.
 *
 * Worked example, an Over priced at -250 against an Under at +190:
 *
 *   raw implied     Over 0.7143   Under 0.3448   (overround 1.0591)
 *   proportional    Over 0.6744   Under 0.3256
 *   power           Over 0.6903   Under 0.3097
 *
 * Proportional credits the underdog with roughly 1.6 extra points of
 * probability. At those odds that is the difference between a bet that looks
 * like value and one that is not.
 *
 * Three better methods are implemented here:
 *
 *   additive  Splits the margin equally in absolute terms. That is a large
 *             relative haircut on a longshot and a small one on a favourite,
 *             which is the correction direction the bias calls for.
 *   power     Finds the exponent k where the implied probabilities raised to k
 *             sum to one. The most aggressive longshot correction of the three.
 *   shin      Models the margin as compensation for informed bettors and solves
 *             for the implied share of insider money. The literature standard,
 *             and the default here.
 *
 * Worth knowing before choosing: for a TWO-outcome market, Shin's method is
 * mathematically identical to the additive method. This was verified here
 * against an independent brute-force solve of Shin's constraint, agreeing to
 * eight decimal places across a range of overrounds. Since every prop, total,
 * and spread in this app is two-way, "shin" and "additive" will produce exactly
 * the same fair prices for almost everything you scan; they diverge only on
 * three-way markets such as soccer h2h. The genuinely distinct choice for
 * two-way markets is proportional versus power, with shin/additive between.
 *
 * On the same -250 / +190 market the three corrections rank:
 *
 *   proportional  dog 0.3256   (most generous to the longshot)
 *   shin/additive dog 0.3153
 *   power         dog 0.3096   (least generous)
 *
 * Which is closest to truth is an empirical question your own closing-line data
 * can settle, which is why the method is switchable via the DEVIG_METHOD
 * environment variable rather than hard-coded.
 */

export type DevigMethod = "proportional" | "additive" | "power" | "shin";

export const DEVIG_METHODS: readonly DevigMethod[] = ["proportional", "additive", "power", "shin"];

/** The method used when none is specified. */
export const DEFAULT_DEVIG_METHOD: DevigMethod = "shin";

function normalize(probs: number[]): number[] {
  const sum = probs.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return probs.map(() => 1 / probs.length);
  return probs.map((p) => p / sum);
}

/** Divide by the overround. Simple, and biased toward longshots. */
export function devigProportional(implied: number[]): number[] {
  return normalize(implied);
}

/**
 * Subtract the margin equally from each outcome. Guards against producing a
 * non-positive probability on a heavy favourite/longshot pair by falling back
 * to proportional, which cannot go negative.
 */
export function devigAdditive(implied: number[]): number[] {
  const n = implied.length;
  const overround = implied.reduce((a, b) => a + b, 0);
  const perOutcome = (overround - 1) / n;
  const adjusted = implied.map((p) => p - perOutcome);
  if (adjusted.some((p) => p <= 0)) return devigProportional(implied);
  return normalize(adjusted);
}

/**
 * Solves for the exponent k such that the implied probabilities raised to k sum
 * to one, by bisection. Monotone in k, so bisection is both safe and fast.
 */
export function devigPower(implied: number[]): number[] {
  const overround = implied.reduce((a, b) => a + b, 0);
  if (!(overround > 0)) return normalize(implied);
  // No margin to remove (or an arb): proportional is the right answer.
  if (Math.abs(overround - 1) < 1e-12) return implied.slice();

  const sumAt = (k: number) => implied.reduce((a, p) => a + Math.pow(p, k), 0);

  let lo = 1e-6;
  let hi = 1;
  // Raising to a higher power shrinks probabilities (each is below 1), so an
  // overround above 1 needs k > 1 and an arb needs k < 1. Expand the bracket
  // until it straddles a sum of one.
  if (overround > 1) {
    lo = 1;
    hi = 2;
    let guard = 0;
    while (sumAt(hi) > 1 && guard++ < 200) hi *= 2;
  } else {
    let guard = 0;
    while (sumAt(lo) < 1 && guard++ < 200) lo /= 2;
    hi = 1;
  }

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (sumAt(mid) > 1) lo = mid;
    else hi = mid;
  }
  const k = (lo + hi) / 2;
  return normalize(implied.map((p) => Math.pow(p, k)));
}

/**
 * Shin's method. Treats the bookmaker's margin as protection against bettors
 * with superior information and solves for z, the implied proportion of
 * informed money. Fair probability for outcome i is
 *
 *   p_i = ( sqrt( z^2 + 4(1-z) * pi_i^2 / PI ) - z ) / ( 2(1-z) )
 *
 * where pi_i is the raw implied probability and PI the overround. z is found by
 * bisection on the constraint that the fair probabilities sum to one.
 */
export function devigShin(implied: number[]): number[] {
  const overround = implied.reduce((a, b) => a + b, 0);
  if (!(overround > 0)) return normalize(implied);
  if (overround <= 1 + 1e-12) return normalize(implied);

  const fairFor = (z: number): number[] => {
    const denom = 2 * (1 - z);
    if (Math.abs(denom) < 1e-12) return normalize(implied);
    return implied.map((pi) => {
      const inner = z * z + (4 * (1 - z) * pi * pi) / overround;
      return (Math.sqrt(Math.max(inner, 0)) - z) / denom;
    });
  };

  const sumAt = (z: number) => fairFor(z).reduce((a, b) => a + b, 0);

  let lo = 0;
  let hi = 0.5;
  // z = 0 reproduces proportional (sum above 1 for a real market); increasing z
  // pulls the sum down. Guard in case the bracket does not straddle.
  if (sumAt(hi) > 1) {
    let guard = 0;
    while (sumAt(hi) > 1 && hi < 0.999 && guard++ < 100) hi = (hi + 1) / 2;
  }

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (sumAt(mid) > 1) lo = mid;
    else hi = mid;
  }

  const result = fairFor((lo + hi) / 2);
  if (result.some((p) => !Number.isFinite(p) || p <= 0)) return normalize(implied);
  return normalize(result);
}

/**
 * Removes vig from a set of raw implied probabilities for one bookmaker's view
 * of one market. Input need not sum to one; output always does.
 *
 * Falls back to proportional whenever a method cannot produce a valid result,
 * so a strange quote degrades to the old behaviour rather than throwing.
 */
export function devig(implied: number[], method: DevigMethod = DEFAULT_DEVIG_METHOD): number[] {
  if (implied.length === 0) return [];
  if (implied.length === 1) return [1];
  if (implied.some((p) => !Number.isFinite(p) || p <= 0)) return normalize(implied.map((p) => (p > 0 ? p : 1e-9)));

  let result: number[];
  switch (method) {
    case "additive":
      result = devigAdditive(implied);
      break;
    case "power":
      result = devigPower(implied);
      break;
    case "shin":
      result = devigShin(implied);
      break;
    case "proportional":
    default:
      result = devigProportional(implied);
      break;
  }

  if (result.some((p) => !Number.isFinite(p) || p <= 0 || p >= 1)) {
    return devigProportional(implied);
  }
  return result;
}

function isDevigMethod(value: string): value is DevigMethod {
  return (DEVIG_METHODS as readonly string[]).includes(value);
}

/**
 * Method used by the live scanners. Override with the DEVIG_METHOD environment
 * variable to A/B against historical results without a code change.
 */
export function configuredDevigMethod(): DevigMethod {
  const raw = process.env.DEVIG_METHOD?.trim().toLowerCase();
  if (raw && isDevigMethod(raw)) return raw;
  return DEFAULT_DEVIG_METHOD;
}
