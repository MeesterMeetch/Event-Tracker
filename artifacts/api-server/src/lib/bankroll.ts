/**
 * Bankroll, drawdown, and the sizing throttle. Pure math, no I/O.
 *
 * A unit only means something relative to a bankroll. Sizing at one percent of
 * a number that was chosen months ago is not fractional Kelly, it is a fixed
 * stake wearing Kelly's clothes: too large after a losing stretch, too small
 * after a winning one. Kelly is defined against *current* capital, so the
 * bankroll has to be a live number.
 *
 * Balance is always derived here, never stored: deposits and withdrawals plus
 * realized profit and loss from settled bets. A stored balance is one more
 * thing that can silently disagree with the ledger.
 */

export interface BankrollEventLike {
  occurredAt: Date | string;
  /** Signed. Withdrawals negative. */
  amount: number;
}

export interface SettledBetLike {
  /** When the bet resolved. Falls back to creation time if not settled. */
  settledAt: Date | string | null;
  createdAt: Date | string;
  /** Realized profit or loss in currency. Null while pending. */
  pnl: number | null;
  status: string;
}

export interface BankrollPoint {
  at: Date;
  balance: number;
  /** Running maximum balance up to this point. */
  peak: number;
  /** Fractional distance below the peak, 0 to 1. */
  drawdown: number;
}

export interface BankrollSummary {
  currentBalance: number;
  peakBalance: number;
  /** Fractional distance below peak right now, 0 to 1. */
  currentDrawdown: number;
  /** Worst drawdown ever reached. */
  maxDrawdown: number;
  totalDeposited: number;
  totalWithdrawn: number;
  realizedPnl: number;
  /** Value of one unit at one percent of current balance. */
  unitValue: number;
  curve: BankrollPoint[];
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Builds the bankroll curve by replaying deposits, withdrawals and settled bet
 * results in chronological order. Pending bets are excluded: money at risk is
 * not yet a gain or a loss, and counting it either way distorts the drawdown.
 */
export function bankrollSummary(
  events: BankrollEventLike[],
  bets: SettledBetLike[],
  /** Fraction of bankroll one unit represents. Defaults to one percent. */
  unitFraction = 0.01,
): BankrollSummary {
  type Entry = { at: Date; delta: number; kind: "event" | "bet" };
  const entries: Entry[] = [];

  let totalDeposited = 0;
  let totalWithdrawn = 0;
  for (const e of events) {
    entries.push({ at: toDate(e.occurredAt), delta: e.amount, kind: "event" });
    if (e.amount >= 0) totalDeposited += e.amount;
    else totalWithdrawn += Math.abs(e.amount);
  }

  let realizedPnl = 0;
  for (const b of bets) {
    if (b.status === "pending" || b.pnl == null) continue;
    const at = toDate(b.settledAt ?? b.createdAt);
    entries.push({ at, delta: b.pnl, kind: "bet" });
    realizedPnl += b.pnl;
  }

  entries.sort((a, b) => a.at.getTime() - b.at.getTime());

  const curve: BankrollPoint[] = [];
  let balance = 0;
  let peak = 0;
  let maxDrawdown = 0;

  for (const entry of entries) {
    balance += entry.delta;
    // Peak tracks the high-water mark of capital, so a withdrawal does not
    // register as a loss the way a losing bet does.
    if (balance > peak) peak = balance;
    const drawdown = peak > 0 ? Math.max(0, (peak - balance) / peak) : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    curve.push({ at: entry.at, balance, peak, drawdown });
  }

  const currentDrawdown = peak > 0 ? Math.max(0, (peak - balance) / peak) : 0;

  return {
    currentBalance: balance,
    peakBalance: peak,
    currentDrawdown,
    maxDrawdown,
    totalDeposited,
    totalWithdrawn,
    realizedPnl,
    unitValue: balance * unitFraction,
    curve,
  };
}

export interface DrawdownThrottle {
  /** Drawdown below which sizing is untouched. */
  freeThreshold: number;
  /** Drawdown at which sizing reaches its floor. */
  fullThreshold: number;
  /** Smallest multiplier the throttle will apply. */
  floor: number;
}

/**
 * Defaults leave normal variance alone and only bite on a real drawdown. A ten
 * percent dip is an ordinary week and should not change behaviour; by thirty
 * percent something is wrong, and halving size buys time to find out whether it
 * is variance or a broken model.
 */
export const DEFAULT_THROTTLE: DrawdownThrottle = {
  freeThreshold: 0.1,
  fullThreshold: 0.3,
  floor: 0.5,
};

/**
 * Multiplier applied to position sizes given the current drawdown, ramping
 * linearly between the thresholds.
 *
 * Worth being honest about what this is. Strict Kelly already de-risks
 * automatically, because sizing a fraction of a shrinking bankroll means
 * smaller absolute stakes. This throttle goes further and cuts the *fraction*
 * too, which is not growth-optimal under a correctly specified model. It is
 * insurance against the model being wrong, which is the more likely
 * explanation for a deep drawdown than bad luck.
 */
export function drawdownScale(drawdown: number, throttle: DrawdownThrottle = DEFAULT_THROTTLE): number {
  if (!(drawdown > throttle.freeThreshold)) return 1;
  if (drawdown >= throttle.fullThreshold) return throttle.floor;
  const span = throttle.fullThreshold - throttle.freeThreshold;
  if (span <= 0) return throttle.floor;
  const progress = (drawdown - throttle.freeThreshold) / span;
  return 1 - progress * (1 - throttle.floor);
}

/** Converts units to currency at the current bankroll. */
export function unitsToCurrency(units: number, balance: number, unitFraction = 0.01): number {
  return Math.round(units * balance * unitFraction * 100) / 100;
}
