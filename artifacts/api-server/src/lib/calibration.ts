/**
 * Probability calibration for the strikeout model. Pure math, no I/O.
 *
 * A model can rank bets correctly and still be badly miscalibrated: if the
 * picks it calls 60 percent only win 53 percent of the time, every downstream
 * number built on that probability is wrong. Edge is overstated, and Kelly
 * sizing (which is a function of the probability, not the ranking) overbets.
 *
 * These helpers measure that gap against graded history and fit a correction.
 */

export interface Prediction {
  /** Model probability that the bet wins, in (0, 1). */
  prob: number;
  /** Realized outcome. Pushes and voids must be excluded before calling. */
  won: boolean;
}

export interface ReliabilityBucket {
  lower: number;
  upper: number;
  count: number;
  /** Mean predicted probability inside the bucket. */
  meanPredicted: number;
  /** Realized win rate inside the bucket. */
  actualRate: number;
  /** actualRate minus meanPredicted. Negative means overconfident. */
  gap: number;
}

export interface CalibrationReport {
  sampleSize: number;
  brierScore: number;
  logLoss: number;
  /** Brier score of always predicting the base rate. Beat this to add value. */
  baseRateBrier: number;
  /** 1 - brier/baseRateBrier. Positive means the model beats the base rate. */
  brierSkillScore: number;
  meanPredicted: number;
  actualRate: number;
  buckets: ReliabilityBucket[];
}

export interface PlattCoefficients {
  /** Slope on the logit. Below 1 means the model is overconfident. */
  a: number;
  b: number;
}

const EPS = 1e-9;

function clampProb(p: number): number {
  return Math.min(Math.max(p, EPS), 1 - EPS);
}

export function logit(p: number): number {
  const q = clampProb(p);
  return Math.log(q / (1 - q));
}

export function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

/** Mean squared error between predicted probability and outcome. Lower is better. */
export function brierScore(predictions: Prediction[]): number {
  if (predictions.length === 0) return NaN;
  let sum = 0;
  for (const p of predictions) {
    const actual = p.won ? 1 : 0;
    sum += (p.prob - actual) * (p.prob - actual);
  }
  return sum / predictions.length;
}

/** Negative log likelihood per prediction. Punishes confident mistakes hard. */
export function logLoss(predictions: Prediction[]): number {
  if (predictions.length === 0) return NaN;
  let sum = 0;
  for (const p of predictions) {
    const q = clampProb(p.prob);
    sum += p.won ? -Math.log(q) : -Math.log(1 - q);
  }
  return sum / predictions.length;
}

/**
 * Groups predictions into equal-width probability buckets and compares
 * predicted to realized rates. Empty buckets are dropped so a sparse sample
 * doesn't produce a table full of NaNs.
 */
export function reliabilityBuckets(predictions: Prediction[], bucketCount = 10): ReliabilityBucket[] {
  const buckets: ReliabilityBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const lower = i / bucketCount;
    const upper = (i + 1) / bucketCount;
    const inBucket = predictions.filter((p) => {
      const q = p.prob;
      return i === bucketCount - 1 ? q >= lower && q <= upper : q >= lower && q < upper;
    });
    if (inBucket.length === 0) continue;
    const meanPredicted = inBucket.reduce((a, p) => a + p.prob, 0) / inBucket.length;
    const actualRate = inBucket.filter((p) => p.won).length / inBucket.length;
    buckets.push({
      lower,
      upper,
      count: inBucket.length,
      meanPredicted,
      actualRate,
      gap: actualRate - meanPredicted,
    });
  }
  return buckets;
}

export function calibrationReport(predictions: Prediction[], bucketCount = 10): CalibrationReport {
  const sampleSize = predictions.length;
  const actualRate = sampleSize > 0 ? predictions.filter((p) => p.won).length / sampleSize : NaN;
  const meanPredicted = sampleSize > 0 ? predictions.reduce((a, p) => a + p.prob, 0) / sampleSize : NaN;
  const brier = brierScore(predictions);
  // Reference model: always predict the observed base rate.
  const baseRateBrier = sampleSize > 0 ? actualRate * (1 - actualRate) : NaN;
  return {
    sampleSize,
    brierScore: brier,
    logLoss: logLoss(predictions),
    baseRateBrier,
    brierSkillScore: baseRateBrier > 0 ? 1 - brier / baseRateBrier : NaN,
    meanPredicted,
    actualRate,
    buckets: reliabilityBuckets(predictions, bucketCount),
  };
}

/**
 * Fits Platt scaling: a logistic regression of the outcome on the logit of the
 * model's probability, giving calibrated = sigmoid(a * logit(p) + b).
 *
 * Solved with Newton-Raphson, which converges in a handful of iterations on a
 * two-parameter problem. A slope below 1 is the signature of an overconfident
 * model and is the expected result for an uncalibrated fundamental model.
 */
export function fitPlatt(predictions: Prediction[], iterations = 100): PlattCoefficients {
  if (predictions.length < 2) return { a: 1, b: 0 };

  const xs = predictions.map((p) => logit(p.prob));
  const ys = predictions.map((p) => (p.won ? 1 : 0));

  let a = 1;
  let b = 0;

  for (let iter = 0; iter < iterations; iter++) {
    let g0 = 0;
    let g1 = 0;
    let h00 = 0;
    let h01 = 0;
    let h11 = 0;

    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      const pred = sigmoid(a * x + b);
      const err = pred - ys[i];
      const w = pred * (1 - pred);
      g0 += err * x;
      g1 += err;
      h00 += w * x * x;
      h01 += w * x;
      h11 += w;
    }

    // Ridge term keeps the Hessian invertible on separable or tiny samples.
    const ridge = 1e-6;
    h00 += ridge;
    h11 += ridge;

    const det = h00 * h11 - h01 * h01;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) break;

    const da = (h11 * g0 - h01 * g1) / det;
    const db = (h00 * g1 - h01 * g0) / det;
    a -= da;
    b -= db;

    if (Math.abs(da) < 1e-10 && Math.abs(db) < 1e-10) break;
  }

  if (!Number.isFinite(a) || !Number.isFinite(b)) return { a: 1, b: 0 };
  return { a, b };
}

/** Applies fitted Platt coefficients to a raw model probability. */
export function applyPlatt(prob: number, coefficients: PlattCoefficients): number {
  return sigmoid(coefficients.a * logit(prob) + coefficients.b);
}
