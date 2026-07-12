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
 *   4. Feed (rate x volume) into a binomial(n = batters faced, p = K/BF) to get
 *      P(strikeouts = k), and from there P(over)/P(under) for any posted line.
 */

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
  /** Binomial trial count used for the distribution. */
  trials: number;
  /** Binomial success probability used for the distribution (= expectedK/trials). */
  perTrialProb: number;
}

export interface LineProbabilities {
  /** P(strikeouts > line). */
  pOver: number;
  /** P(strikeouts < line). */
  pUnder: number;
  /** P(strikeouts == line); non-zero only for integer lines. */
  pPush: number;
  /** Push-adjusted (conditional on the bet resolving) over probability. */
  condOver: number;
  /** Push-adjusted (conditional on the bet resolving) under probability. */
  condUnder: number;
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
  const oppK = opponent ? (pitcher.throws === "L" ? opponent.kPctVsLhp : opponent.kPctVsRhp) : null;
  let opponentFactor = 1;
  if (oppK != null && oppK > 0) {
    opponentFactor = clamp(oppK / LEAGUE_TEAM_K_PCT, OPP_FACTOR_MIN, OPP_FACTOR_MAX);
  }

  const ratePerBF = clamp(projRate * opponentFactor, MIN_RATE, MAX_RATE);

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

  // Binomial parameters: keep the mean exact by deriving p from expectedK / n.
  const trials = Math.max(1, Math.round(projBF));
  const perTrialProb = clamp(expectedStrikeouts / trials, 1e-6, 1 - 1e-6);

  return {
    ratePerBF,
    baseRatePerBF: projRate,
    opponentFactor,
    projectedBattersFaced: projBF,
    expectedStrikeouts,
    sampleBattersFaced: pitcher.rollingBattersFaced,
    sampleStarts: pitcher.rollingStarts,
    trials,
    perTrialProb,
  };
}

/** Binomial probability mass function values for k = 0..n, computed iteratively. */
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
 * Over/under probabilities for a strikeout line given binomial parameters.
 * Integer lines (e.g. 6) can push; half-point lines (e.g. 5.5) cannot. The
 * conditional (push-adjusted) probabilities are what get compared against the
 * de-vigged market, which itself normalizes over the two resolving sides.
 */
export function lineProbabilities(trials: number, perTrialProb: number, point: number): LineProbabilities {
  const pmf = binomialPmf(trials, perTrialProb);
  const cumulative = (k: number): number => {
    let sum = 0;
    const upper = Math.min(k, trials);
    for (let i = 0; i <= upper; i++) sum += pmf[i];
    return sum;
  };

  let pOver: number;
  let pUnder: number;
  let pPush: number;

  if (Number.isInteger(point)) {
    pPush = point >= 0 && point <= trials ? pmf[point] : 0;
    pUnder = point <= 0 ? 0 : cumulative(point - 1);
    pOver = Math.max(0, 1 - pUnder - pPush);
  } else {
    const floor = Math.floor(point);
    pUnder = cumulative(floor);
    pOver = Math.max(0, 1 - pUnder);
    pPush = 0;
  }

  const denom = pOver + pUnder;
  const condOver = denom > 0 ? pOver / denom : 0;
  const condUnder = denom > 0 ? pUnder / denom : 0;

  return { pOver, pUnder, pPush, condOver, condUnder };
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
