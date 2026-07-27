/**
 * Fundamental pitcher-strikeout projection model. Pure math — no I/O — so it
 * can be reasoned about and tested in isolation. The MLB Stats API inputs are
 * gathered elsewhere (see mlb.ts) and fed in here.
 *
 * The model predicts a *distribution* of strikeouts, not a point estimate:
 *   1. Estimate a strikeout rate per batter faced (K/BF), regressing recent
 *      form toward a season+career baseline so a hot/cold few starts don't
 *      whipsaw the number.
 *   2. Adjust that rate for the opposing lineup's strikeout tendency versus the
 *      pitcher's throwing hand.
 *   3. Project how many batters the pitcher will face (volume).
 *   4. Feed the rate and a *distribution* over volume into a compound
 *      beta-binomial to get P(strikeouts = k), and from there P(over)/P(under)
 *      for any posted line. See k-distribution.ts for why the volume term is a
 *      distribution rather than a fixed count.
 */

import {
  bfDistributionFromSamples,
  compoundKPmf,
  lineProbabilitiesFromPmf,
  binomialPmf,
  pmfVariance,
  DEFAULT_CONCENTRATION,
  type BfDistribution,
  type LineProbabilities,
} from "./k-distribution";

export { binomialPmf };
export type { LineProbabilities };

export interface PitcherKInputs {
  throws: "L" | "R" | null;
  /** Strikeouts across the rolling window of recent starts. */
  rollingStrikeouts: number;
  /** Batters faced across the rolling window. */
  rollingBattersFaced: number;
  /** Number of starts in the rolling window. */
  rollingStarts: number;
  /** Average batters faced per start over the rolling window. */
  rollingBfPerStart: number | null;
  /**
   * Batters faced in each individual start of the rolling window. Supplies the
   * *shape* of the volume distribution (how often he gets chased early), which
   * a single average cannot. Optional: falls back to a discretized normal.
   */
  rollingBfPerStartSamples?: number[];
  /** Decimal innings pitched across the rolling window. Null when not available from the feed. */
  rollingInningsPitched: number | null;
  seasonStrikeouts: number | null;
  seasonBattersFaced: number | null;
  seasonGamesStarted: number | null;
  careerStrikeouts: number | null;
  careerBattersFaced: number | null;
}

export interface OpponentKInputs {
  /** Opponent lineup strikeouts / plate appearances vs LHP. */
  kPctVsLhp: number | null;
  /** Opponent lineup strikeouts / plate appearances vs RHP. */
  kPctVsRhp: number | null;
  /** Plate appearances behind kPctVsLhp, used to shrink small samples. */
  paVsLhp?: number | null;
  /** Plate appearances behind kPctVsRhp, used to shrink small samples. */
  paVsRhp?: number | null;
}

export interface KProjection {
  /** Final K/BF rate after the opponent adjustment. */
  ratePerBF: number;
  /** K/BF rate before the opponent adjustment (form regressed to baseline). */
  baseRatePerBF: number;
  /** Multiplier applied for the opposing lineup's handedness K tendency. */
  opponentFactor: number;
  /** Projected batters faced (volume). */
  projectedBattersFaced: number;
  /** Expected strikeouts = ratePerBF x projectedBattersFaced. */
  expectedStrikeouts: number;
  /** Batters faced in the rolling window (how much recent data backs this). */
  sampleBattersFaced: number;
  sampleStarts: number;
  /** Raw K/9 from the rolling window (strikeouts per 9 IP). Null when IP data was unavailable. */
  kPer9: number | null;
  /** Binomial trial count used for the distribution. */
  trials: number;
  /** Binomial success probability used for the distribution (= expectedK/trials). */
  perTrialProb: number;
  /** Distribution over batters faced that the strikeout pmf is marginalized across. */
  bfDistribution: BfDistribution;
  /** Beta-binomial concentration applied for per-batter rate heterogeneity. */
  concentration: number;
  /** Variance of the resulting strikeout distribution. */
  variance: number;
  /**
   * Variance a fixed-n binomial would have reported. The ratio against
   * `variance` is how much dispersion the old model was missing.
   */
  binomialVariance: number;
}

// ---- Tunable constants ----

/** League-average strikeout rate per plate appearance, used as a fallback. */
const LEAGUE_K_PER_PA = 0.22;
/** League-average team K% is ~ the same as league K/PA; opponent factor divides by it. */
const LEAGUE_TEAM_K_PCT = 0.22;
/** Pseudo-count (in batters faced) pulling a small season sample toward career norms. */
const CAREER_PRIOR_BF = 200;
/** Pseudo-count (in batters faced) pulling recent form toward the season+career baseline. */
const FORM_PRIOR_BF = 150;
/** Clamp the opponent handedness adjustment to a sane band. */
const OPP_FACTOR_MIN = 0.85;
const OPP_FACTOR_MAX = 1.2;
/**
 * Pseudo-count (in plate appearances) pulling a team's handedness K rate toward
 * the league mean. In April a team may have only a couple hundred PA against
 * left-handed pitching, and taking that at face value produces a wild opponent
 * factor. Shrinking by sample size does the regularization properly instead of
 * leaving it to the clamp.
 */
const OPP_PRIOR_PA = 600;
/** Clamp projected batters faced to a realistic starter workload. */
const MIN_PROJ_BF = 12;
const MAX_PROJ_BF = 30;
/** Fallback volume when no per-start data exists at all. */
const LEAGUE_BF_PER_START = 24;
/** Clamp the final per-BF rate away from degenerate 0/1 values. */
const MIN_RATE = 0.03;
const MAX_RATE = 0.55;

const DEFAULT_KELLY_MULTIPLIER = 0.25;
/** Cap the recommended stake so a thin edge on juicy odds can't suggest an absurd bet. */
const MAX_RECOMMENDED_UNITS = 3;

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

/**
 * Bill James log5: combines a pitcher rate and an opponent rate against a
 * league baseline on the odds scale. Bounded in (0, 1) by construction.
 */
export function log5(pitcherRate: number, opponentRate: number, leagueRate: number): number {
  if (leagueRate <= 0 || leagueRate >= 1) return pitcherRate;
  const odds = (r: number) => {
    const q = clamp(r, 1e-6, 1 - 1e-6);
    return q / (1 - q);
  };
  const combined = (odds(pitcherRate) * odds(opponentRate)) / odds(leagueRate);
  return combined / (1 + combined);
}

/** Projects a pitcher's strikeout distribution parameters from their inputs. */
export function projectPitcherK(pitcher: PitcherKInputs, opponent: OpponentKInputs | null): KProjection {
  const careerRate =
    pitcher.careerBattersFaced && pitcher.careerBattersFaced > 0 && pitcher.careerStrikeouts != null
      ? pitcher.careerStrikeouts / pitcher.careerBattersFaced
      : LEAGUE_K_PER_PA;

  // Baseline: regress the season rate toward the career rate.
  let baselineRate: number;
  if (pitcher.seasonBattersFaced && pitcher.seasonBattersFaced > 0 && pitcher.seasonStrikeouts != null) {
    baselineRate = (pitcher.seasonStrikeouts + CAREER_PRIOR_BF * careerRate) / (pitcher.seasonBattersFaced + CAREER_PRIOR_BF);
  } else {
    baselineRate = careerRate;
  }

  // Form: regress the rolling rate toward the baseline.
  let projRate: number;
  if (pitcher.rollingBattersFaced > 0) {
    projRate = (pitcher.rollingStrikeouts + FORM_PRIOR_BF * baselineRate) / (pitcher.rollingBattersFaced + FORM_PRIOR_BF);
  } else {
    projRate = baselineRate;
  }

  // Opponent adjustment: how strikeout-prone is the lineup vs this hand?
  const facingLefty = pitcher.throws === "L";
  const rawOppK = opponent ? (facingLefty ? opponent.kPctVsLhp : opponent.kPctVsRhp) : null;
  const oppPa = opponent ? (facingLefty ? opponent.paVsLhp : opponent.paVsRhp) : null;

  // Shrink the opponent rate toward league mean by its own sample size, the
  // same treatment the pitcher's rate gets.
  let oppK: number | null = null;
  if (rawOppK != null && rawOppK > 0) {
    if (oppPa != null && oppPa > 0) {
      oppK = (rawOppK * oppPa + LEAGUE_TEAM_K_PCT * OPP_PRIOR_PA) / (oppPa + OPP_PRIOR_PA);
    } else {
      oppK = rawOppK;
    }
  }

  // Log5 (odds-ratio) combination rather than a raw rate multiplier. Scaling a
  // rate directly can push past 1 for a high-K pitcher against a high-K lineup;
  // combining on the odds scale cannot, and it is the standard treatment for
  // merging two rates against a league baseline.
  let opponentFactor = 1;
  let combinedRate = projRate;
  if (oppK != null && oppK > 0) {
    combinedRate = log5(projRate, oppK, LEAGUE_TEAM_K_PCT);
    // Report the realized adjustment as a factor so the UI and stored
    // projections keep their existing meaning.
    opponentFactor = projRate > 0 ? combinedRate / projRate : 1;
    opponentFactor = clamp(opponentFactor, OPP_FACTOR_MIN, OPP_FACTOR_MAX);
    combinedRate = projRate * opponentFactor;
  }

  const ratePerBF = clamp(combinedRate, MIN_RATE, MAX_RATE);

  // Volume: blend recent workload with the season average, favouring recent.
  const seasonBfPerStart =
    pitcher.seasonBattersFaced && pitcher.seasonGamesStarted && pitcher.seasonGamesStarted > 0
      ? pitcher.seasonBattersFaced / pitcher.seasonGamesStarted
      : null;
  const recentBfPerStart = pitcher.rollingBfPerStart;
  let projBF: number;
  if (recentBfPerStart != null && seasonBfPerStart != null) {
    projBF = 0.6 * recentBfPerStart + 0.4 * seasonBfPerStart;
  } else {
    projBF = recentBfPerStart ?? seasonBfPerStart ?? LEAGUE_BF_PER_START;
  }
  projBF = clamp(projBF, MIN_PROJ_BF, MAX_PROJ_BF);

  const expectedStrikeouts = ratePerBF * projBF;

  // Volume is a distribution, not a number. Built from the pitcher's own logged
  // starts where available so the shape reflects how often he actually gets
  // chased, recentered onto the projected workload.
  const bfDistribution = bfDistributionFromSamples(
    pitcher.rollingBfPerStartSamples ?? [],
    projBF,
    MIN_PROJ_BF,
    MAX_PROJ_BF,
  );

  // Binomial parameters: keep the mean exact by deriving p from expectedK / n.
  const trials = Math.max(1, Math.round(projBF));
  const perTrialProb = clamp(expectedStrikeouts / trials, 1e-6, 1 - 1e-6);

  const concentration = DEFAULT_CONCENTRATION;
  const variance = pmfVariance(
    compoundKPmf({ bf: bfDistribution, perTrialProb: ratePerBF, concentration }),
  );
  const binomialVariance = trials * perTrialProb * (1 - perTrialProb);

  const kPer9 =
    pitcher.rollingInningsPitched != null && pitcher.rollingInningsPitched > 0
      ? (pitcher.rollingStrikeouts / pitcher.rollingInningsPitched) * 9
      : null;

  return {
    ratePerBF,
    baseRatePerBF: projRate,
    opponentFactor,
    projectedBattersFaced: projBF,
    expectedStrikeouts,
    sampleBattersFaced: pitcher.rollingBattersFaced,
    sampleStarts: pitcher.rollingStarts,
    kPer9,
    trials,
    perTrialProb,
    bfDistribution,
    concentration,
    variance,
    binomialVariance,
  };
}

/**
 * Over/under probabilities for a posted line, using the projection's compound
 * distribution. Integer lines can push; half-point lines cannot. The
 * conditional (push-adjusted) probabilities are what get compared against the
 * de-vigged market, which itself normalizes over the two resolving sides.
 */
export function projectionLineProbabilities(projection: KProjection, point: number): LineProbabilities {
  const pmf = compoundKPmf({
    bf: projection.bfDistribution,
    perTrialProb: projection.ratePerBF,
    concentration: projection.concentration,
  });
  return lineProbabilitiesFromPmf(pmf, point);
}

/**
 * Legacy fixed-n entry point, kept so callers and tests that only have
 * (trials, p) still work. Prefer projectionLineProbabilities: this one carries
 * the variance understatement described in k-distribution.ts.
 */
export function lineProbabilities(trials: number, perTrialProb: number, point: number): LineProbabilities {
  return lineProbabilitiesFromPmf(binomialPmf(trials, perTrialProb), point);
}

/**
 * Full-Kelly fraction of bankroll for a bet at the given win probability and
 * decimal odds. Returns 0 when the bet is not +EV (never stake a negative edge).
 */
export function kellyFraction(winProb: number, decimalOdds: number): number {
  const b = decimalOdds - 1;
  if (b <= 0) return 0;
  const f = (winProb * decimalOdds - 1) / b;
  return f > 0 ? f : 0;
}

/**
 * Recommended stake in units, where 1 unit = 1% of bankroll. Applies the Kelly
 * multiplier (quarter-Kelly by default while the model is unproven) and caps the
 * result so a thin edge on long odds can't suggest an oversized bet.
 */
export function recommendedKellyUnits(winProb: number, decimalOdds: number, multiplier = DEFAULT_KELLY_MULTIPLIER): number {
  const full = kellyFraction(winProb, decimalOdds);
  const units = full * multiplier * 100;
  return Math.round(clamp(units, 0, MAX_RECOMMENDED_UNITS) * 100) / 100;
}

export { DEFAULT_KELLY_MULTIPLIER, MAX_RECOMMENDED_UNITS };
