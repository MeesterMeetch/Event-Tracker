/**
 * Overdispersed strikeout distribution. Pure math, no I/O.
 *
 * The original model treated batters faced as a fixed count and drew from a
 * plain Binomial(n, p). That understates variance in two ways:
 *
 *   1. Batters faced is random. A starter projected for 24 might face 18 on a
 *      night he gets knocked around or 28 when he cruises. By the law of total
 *      variance, Var(K) = E[n]p(1-p) + p^2 Var(n), and a fixed-n binomial has
 *      only the first term.
 *   2. The per-batter strikeout probability is not constant within a start.
 *      Lineups are heterogeneous and the third time through the order is a real
 *      penalty, so trials are neither identical nor independent.
 *
 * Understating variance compresses the tails, which biases the model toward
 * whichever side sits between the line and the projection. That is the "bet the
 * inside of the line" failure mode, and it is systematically the wrong side.
 *
 * This module fixes both terms: it marginalizes the binomial over an empirical
 * distribution of batters faced, and replaces the binomial with a beta-binomial
 * whose concentration parameter controls how much extra dispersion to allow.
 */

/** A discrete distribution over batters faced: support plus matching weights. */
export interface BfDistribution {
  outcomes: number[];
  weights: number[];
}

export interface CompoundKParams {
  bf: BfDistribution;
  /** Per-batter strikeout probability. */
  perTrialProb: number;
  /**
   * Beta-binomial concentration. Higher means closer to a plain binomial;
   * null disables overdispersion entirely (pure binomial per n).
   */
  concentration: number | null;
}

export interface LineProbabilities {
  pOver: number;
  pUnder: number;
  pPush: number;
  condOver: number;
  condUnder: number;
}

/**
 * Beta-binomial concentration used by default. Chosen so the variance
 * inflation factor (n + k) / (1 + k) is about 1.10 at a typical 24 batters
 * faced, i.e. roughly ten percent extra variance from rate heterogeneity
 * before the batters-faced term is added on top.
 */
export const DEFAULT_CONCENTRATION = 230;

/**
 * Standard deviation of batters faced per start, used only when a pitcher has
 * too few logged starts to build an empirical distribution. Starters cluster
 * tightly around their workload until they get chased, which is what makes the
 * left tail fatter than the right; a symmetric fallback is a deliberate
 * simplification for the low-data case.
 */
export const FALLBACK_BF_SD = 4;

/** Lanczos log-gamma. Accurate to ~15 significant digits for x > 0. */
const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];

export function logGamma(x: number): number {
  if (x < 0.5) {
    // Reflection formula keeps the series in its accurate range.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let a = 0.99999999999980993;
  const t = z + 7.5;
  for (let i = 0; i < LANCZOS.length; i++) a += LANCZOS[i] / (z + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

function logBinomialCoefficient(n: number, k: number): number {
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/** Binomial pmf over k = 0..n, computed iteratively. */
export function binomialPmf(n: number, p: number): number[] {
  const pmf = new Array<number>(n + 1).fill(0);
  if (p <= 0) {
    pmf[0] = 1;
    return pmf;
  }
  if (p >= 1) {
    pmf[n] = 1;
    return pmf;
  }
  pmf[0] = Math.pow(1 - p, n);
  const ratio = p / (1 - p);
  for (let k = 1; k <= n; k++) {
    pmf[k] = pmf[k - 1] * ((n - k + 1) / k) * ratio;
  }
  return pmf;
}

/**
 * Beta-binomial pmf over k = 0..n with mean n*p. The concentration parameter
 * splits into alpha = p*concentration and beta = (1-p)*concentration, giving
 * variance n*p*(1-p) * (n + concentration) / (1 + concentration).
 */
export function betaBinomialPmf(n: number, p: number, concentration: number): number[] {
  const alpha = p * concentration;
  const beta = (1 - p) * concentration;
  const logNorm = logGamma(alpha + beta) - logGamma(alpha) - logGamma(beta);
  const pmf = new Array<number>(n + 1).fill(0);
  let total = 0;
  for (let k = 0; k <= n; k++) {
    const logP =
      logBinomialCoefficient(n, k) +
      logGamma(k + alpha) +
      logGamma(n - k + beta) -
      logGamma(n + alpha + beta) +
      logNorm;
    const value = Math.exp(logP);
    pmf[k] = value;
    total += value;
  }
  // Renormalize against accumulated floating-point drift.
  if (total > 0) for (let k = 0; k <= n; k++) pmf[k] /= total;
  return pmf;
}

/**
 * Builds a batters-faced distribution from a pitcher's own logged starts,
 * recentered so its mean matches the model's projected volume. Recentering
 * matters because projectedBattersFaced blends recent and season workload and
 * is clamped, so the raw sample mean and the projection generally differ; we
 * want the sample's *shape* (how often he gets chased early) without letting it
 * override the projection's *level*.
 *
 * Falls back to a discretized normal when there are too few starts to have a
 * meaningful shape.
 */
export function bfDistributionFromSamples(
  samples: number[],
  projectedBf: number,
  minBf: number,
  maxBf: number,
): BfDistribution {
  const usable = samples.filter((s) => Number.isFinite(s) && s > 0);

  if (usable.length < 3) {
    return discretizedNormalBf(projectedBf, FALLBACK_BF_SD, minBf, maxBf);
  }

  const mean = usable.reduce((a, b) => a + b, 0) / usable.length;
  const shift = projectedBf - mean;

  // Each shifted sample generally lands between two integers. Rounding it to
  // the nearer one would bias the whole distribution whenever the fractional
  // parts share a direction, which they do here because every sample gets the
  // same shift. Splitting the sample's mass between the neighbouring integers
  // in proportion to the fraction preserves the mean exactly instead.
  const counts = new Map<number, number>();
  const add = (outcome: number, weight: number) => {
    if (weight <= 0) return;
    counts.set(outcome, (counts.get(outcome) ?? 0) + weight);
  };

  for (const sample of usable) {
    const shifted = clamp(sample + shift, minBf, maxBf);
    const lower = Math.floor(shifted);
    const upper = Math.ceil(shifted);
    if (lower === upper) {
      add(lower, 1);
    } else {
      const upperShare = shifted - lower;
      add(lower, 1 - upperShare);
      add(upper, upperShare);
    }
  }

  const outcomes = Array.from(counts.keys()).sort((a, b) => a - b);
  const total = outcomes.reduce((a, o) => a + (counts.get(o) ?? 0), 0);
  const weights = outcomes.map((o) => (counts.get(o) ?? 0) / total);
  return { outcomes, weights };
}

/** Discretized normal over batters faced, clamped to a realistic workload band. */
export function discretizedNormalBf(
  mean: number,
  sd: number,
  minBf: number,
  maxBf: number,
): BfDistribution {
  const lo = Math.max(1, Math.round(clamp(mean - 2 * sd, minBf, maxBf)));
  const hi = Math.max(lo, Math.round(clamp(mean + 2 * sd, minBf, maxBf)));
  const outcomes: number[] = [];
  const raw: number[] = [];
  for (let n = lo; n <= hi; n++) {
    outcomes.push(n);
    const z = (n - mean) / sd;
    raw.push(Math.exp(-0.5 * z * z));
  }
  const total = raw.reduce((a, b) => a + b, 0);
  const weights = total > 0 ? raw.map((w) => w / total) : raw.map(() => 1 / raw.length);
  return { outcomes, weights };
}

/**
 * Marginalizes the per-start strikeout distribution over the batters-faced
 * distribution, producing a pmf indexed by strikeout count.
 */
export function compoundKPmf(params: CompoundKParams): number[] {
  const { bf, perTrialProb, concentration } = params;
  const maxN = bf.outcomes.length > 0 ? Math.max(...bf.outcomes) : 0;
  const pmf = new Array<number>(maxN + 1).fill(0);

  for (let i = 0; i < bf.outcomes.length; i++) {
    const n = bf.outcomes[i];
    const weight = bf.weights[i];
    if (!(weight > 0) || n <= 0) continue;
    const conditional =
      concentration && concentration > 0
        ? betaBinomialPmf(n, perTrialProb, concentration)
        : binomialPmf(n, perTrialProb);
    for (let k = 0; k <= n; k++) pmf[k] += weight * conditional[k];
  }

  const total = pmf.reduce((a, b) => a + b, 0);
  if (total > 0) for (let k = 0; k < pmf.length; k++) pmf[k] /= total;
  return pmf;
}

/** Mean of a pmf indexed by outcome value. */
export function pmfMean(pmf: number[]): number {
  let mean = 0;
  for (let k = 0; k < pmf.length; k++) mean += k * pmf[k];
  return mean;
}

/** Variance of a pmf indexed by outcome value. */
export function pmfVariance(pmf: number[]): number {
  const mean = pmfMean(pmf);
  let variance = 0;
  for (let k = 0; k < pmf.length; k++) variance += pmf[k] * (k - mean) * (k - mean);
  return variance;
}

/**
 * Over/under probabilities for a posted line given any strikeout pmf. Integer
 * lines can push; half-point lines cannot. The conditional probabilities are
 * what get compared against the de-vigged market, which itself normalizes over
 * the two resolving sides.
 */
export function lineProbabilitiesFromPmf(pmf: number[], point: number): LineProbabilities {
  const cumulative = (k: number): number => {
    let sum = 0;
    const upper = Math.min(k, pmf.length - 1);
    for (let i = 0; i <= upper; i++) sum += pmf[i];
    return sum;
  };

  let pOver: number;
  let pUnder: number;
  let pPush: number;

  if (Number.isInteger(point)) {
    pPush = point >= 0 && point < pmf.length ? pmf[point] : 0;
    pUnder = point <= 0 ? 0 : cumulative(point - 1);
    pOver = Math.max(0, 1 - pUnder - pPush);
  } else {
    pUnder = cumulative(Math.floor(point));
    pOver = Math.max(0, 1 - pUnder);
    pPush = 0;
  }

  const denom = pOver + pUnder;
  return {
    pOver,
    pUnder,
    pPush,
    condOver: denom > 0 ? pOver / denom : 0,
    condUnder: denom > 0 ? pUnder / denom : 0,
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}
