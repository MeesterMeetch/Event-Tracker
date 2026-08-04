import type { PlattCoefficients } from "./calibration";

/**
 * Post-processing applied to raw model probabilities before they become edges
 * and stake sizes.
 *
 * Both corrections ship as identity transforms on purpose. A calibration curve
 * or blend weight fitted on a handful of graded trades is worse than no
 * correction at all, because it hard-codes noise into every future price. Run
 * `pnpm model:report` once you have a meaningful graded sample, then paste the
 * fitted values in here (or set the environment variables) to switch them on.
 *
 * Rough guidance on "meaningful": the report will refuse to interpret a
 * calibration below about 30 graded trades and a blend weight below about 50,
 * and those are floors rather than targets. Several hundred is where these
 * numbers start to be stable.
 */
export interface ModelCalibrationConfig {
  /**
   * Platt scaling coefficients correcting model over/under-confidence.
   * Null means "use the model's raw probability".
   */
  platt: PlattCoefficients | null;
  /**
   * Weight on the model when pooling with the de-vigged market, in [0, 1].
   * 1 means "ignore the market and trust the model", which is the historical
   * behaviour and the default. Lower it only once a fit justifies it.
   */
  blendWeight: number;
}

function envNumber(name: string): number | null {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function loadPlatt(): PlattCoefficients | null {
  const a = envNumber("MODEL_PLATT_A");
  const b = envNumber("MODEL_PLATT_B");
  if (a == null || b == null) return null;
  return { a, b };
}

function loadBlendWeight(): number {
  const w = envNumber("MODEL_BLEND_WEIGHT");
  if (w == null) return 1;
  return Math.min(Math.max(w, 0), 1);
}

/**
 * Sample sizes below which a fit is noise rather than a correction. Shared with
 * scripts/model-report.ts so the countdown shown in the UI and the thresholds
 * the report actually enforces cannot drift apart.
 */
export const MIN_GRADED_FOR_CALIBRATION = 30;
export const MIN_GRADED_FOR_BLEND_WEIGHT = 50;

export const MODEL_CALIBRATION: ModelCalibrationConfig = {
  platt: loadPlatt(),
  blendWeight: loadBlendWeight(),
};
