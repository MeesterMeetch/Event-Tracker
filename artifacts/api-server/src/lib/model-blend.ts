/**
 * Blending the fundamental model with the de-vigged market. Pure math, no I/O.
 *
 * An independent fundamental model rarely beats a sharp prop market outright.
 * The market aggregates lineup news, weather, usage rumours, and sharp money
 * that a box-score model never sees. Treating the model as a full replacement
 * for the market throws all of that away; treating it as a *correction* to the
 * market keeps it.
 *
 * The blend runs on the log-odds scale rather than on raw probabilities. Linear
 * averaging of probabilities distorts near the extremes: averaging 0.95 and
 * 0.50 gives 0.725, which understates how much a confident disagreement should
 * move the number. Log-odds averaging is the standard treatment for pooling
 * two probabilistic opinions and behaves sensibly at the tails.
 *
 * The weight is not a matter of taste. Fit it against graded history: if the
 * fitted weight on the model comes out near zero, the model is adding nothing
 * over the market, and that is worth knowing.
 */

export interface BlendSample {
  modelProb: number;
  marketProb: number;
  won: boolean;
}

export interface BlendFit {
  /** Weight on the model, in [0, 1]. The market gets the remainder. */
  weight: number;
  /** Log loss at the fitted weight. */
  logLoss: number;
  /** Log loss using the market alone, for comparison. */
  marketOnlyLogLoss: number;
  /** Log loss using the model alone, for comparison. */
  modelOnlyLogLoss: number;
  sampleSize: number;
  interpretation: string;
}

const EPS = 1e-9;

function clampProb(p: number): number {
  return Math.min(Math.max(p, EPS), 1 - EPS);
}

function logit(p: number): number {
  const q = clampProb(p);
  return Math.log(q / (1 - q));
}

function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

/**
 * Pools the model and market probabilities on the log-odds scale.
 * weight = 1 returns the model unchanged; weight = 0 returns the market.
 */
export function blendProbabilities(modelProb: number, marketProb: number | null, weight: number): number {
  if (marketProb == null || !Number.isFinite(marketProb)) return modelProb;
  const w = Math.min(Math.max(weight, 0), 1);
  return sigmoid(w * logit(modelProb) + (1 - w) * logit(marketProb));
}

function logLossAt(samples: BlendSample[], weight: number): number {
  if (samples.length === 0) return NaN;
  let sum = 0;
  for (const s of samples) {
    const p = clampProb(blendProbabilities(s.modelProb, s.marketProb, weight));
    sum += s.won ? -Math.log(p) : -Math.log(1 - p);
  }
  return sum / samples.length;
}

/**
 * Grid-searches the blend weight that minimizes log loss on graded history.
 * A grid rather than a solver because the surface is one-dimensional, cheap to
 * evaluate, and this way the whole curve is inspectable if we ever want it.
 */
export function fitBlendWeight(samples: BlendSample[], steps = 101): BlendFit {
  const usable = samples.filter(
    (s) => Number.isFinite(s.modelProb) && Number.isFinite(s.marketProb),
  );

  if (usable.length === 0) {
    return {
      weight: 1,
      logLoss: NaN,
      marketOnlyLogLoss: NaN,
      modelOnlyLogLoss: NaN,
      sampleSize: 0,
      interpretation: "No graded trades with both a model and a market probability yet.",
    };
  }

  let bestWeight = 1;
  let bestLoss = Infinity;
  for (let i = 0; i < steps; i++) {
    const w = i / (steps - 1);
    const loss = logLossAt(usable, w);
    if (loss < bestLoss) {
      bestLoss = loss;
      bestWeight = w;
    }
  }

  const marketOnly = logLossAt(usable, 0);
  const modelOnly = logLossAt(usable, 1);

  return {
    weight: bestWeight,
    logLoss: bestLoss,
    marketOnlyLogLoss: marketOnly,
    modelOnlyLogLoss: modelOnly,
    sampleSize: usable.length,
    interpretation: interpret(usable.length, bestWeight, bestLoss, marketOnly),
  };
}

function interpret(sampleSize: number, weight: number, blendLoss: number, marketLoss: number): string {
  if (sampleSize < 50) {
    return "Sample is too small to trust a fitted weight. Keep collecting graded trades before you let this drive sizing.";
  }
  const improvement = marketLoss - blendLoss;
  if (weight <= 0.05) {
    return "The fit puts essentially no weight on the model: it is not beating the de-vigged market on this sample. Bet the market read, and treat the model as a screen rather than a price.";
  }
  if (weight >= 0.95) {
    return "The fit puts nearly all weight on the model. That is unusual against a sharp market, so check for leakage before believing it, such as a market probability captured after the model already saw the line move.";
  }
  if (improvement <= 0.001) {
    return `Fitted weight is ${weight.toFixed(2)}, but the blend barely improves on the market alone. The model is close to redundant here.`;
  }
  return `Fitted weight is ${weight.toFixed(2)} on the model, and the blend beats the market alone on log loss. Use the blended probability for edge and sizing.`;
}
