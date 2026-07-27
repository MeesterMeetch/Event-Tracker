/**
 * Edge persistence measurement. Pure comparison logic, no I/O.
 *
 * A +EV scanner built on a polled odds feed has an uncomfortable failure mode:
 * some share of the "edges" it finds are not market inefficiencies at all, they
 * are prices that no longer exist at the book. The feed is a snapshot, books
 * move, and a stale quote sitting in a snapshot looks exactly like value.
 *
 * The distinguishing test is time. A real edge is a price a book is genuinely
 * offering, so it tends to persist for at least a short while. A stale quote
 * vanishes or corrects on the very next poll. So: flag edges, wait, scan the
 * same markets again, and see what is still there.
 *
 * The most diagnostic cut is persistence by EV size. If your 2 percent edges
 * survive but your 10 percent edges evaporate, the big numbers are feed
 * artifacts rather than opportunities, and the scanner's EV distribution has a
 * fat tail made of latency. That is the single most important thing this
 * measurement can tell you, and it is invisible in aggregate statistics.
 */

/** Identity of a single quoted side, stable across scans. */
export interface EdgeKey {
  gameId: string;
  market: string;
  selection: string;
  point: number | null;
  player: string | null;
  book: string;
}

export interface EdgeSnapshot extends EdgeKey {
  americanOdds: number;
  evPercent: number;
}

export type EdgeFate = "persisted" | "worsened" | "improved" | "vanished";

export interface EdgeComparison {
  before: EdgeSnapshot;
  after: EdgeSnapshot | null;
  fate: EdgeFate;
  /** Change in American price at the same book; null when the quote vanished. */
  priceDelta: number | null;
  /** Change in EV percent; null when the quote vanished. */
  evDelta: number | null;
}

export interface PersistenceBucket {
  label: string;
  lowerEv: number;
  upperEv: number;
  count: number;
  persisted: number;
  improved: number;
  worsened: number;
  vanished: number;
  /** Share whose price held or got better. */
  survivalRate: number;
  meanEvDelta: number | null;
}

export interface BookPersistence {
  book: string;
  count: number;
  survivalRate: number;
  vanishRate: number;
}

export interface DecayReport {
  totalEdges: number;
  matched: number;
  persisted: number;
  improved: number;
  worsened: number;
  vanished: number;
  overallSurvivalRate: number;
  meanEvDelta: number | null;
  byEvBucket: PersistenceBucket[];
  byBook: BookPersistence[];
  interpretation: string;
}

const DEFAULT_EV_EDGES = [0, 2, 5, 10, Infinity];

export function edgeKeyOf(edge: EdgeKey): string {
  return [edge.gameId, edge.market, edge.selection, edge.point ?? "", edge.player ?? "", edge.book].join("|");
}

/**
 * Compares two scans of the same markets. "Persisted" means the same book still
 * offers at least as good a price; the price is allowed to drift in the
 * bettor's favour without counting against it.
 */
export function compareScans(before: EdgeSnapshot[], after: EdgeSnapshot[]): EdgeComparison[] {
  const afterByKey = new Map(after.map((e) => [edgeKeyOf(e), e]));

  return before.map((b) => {
    const match = afterByKey.get(edgeKeyOf(b)) ?? null;
    if (!match) {
      return { before: b, after: null, fate: "vanished" as EdgeFate, priceDelta: null, evDelta: null };
    }
    const priceDelta = match.americanOdds - b.americanOdds;
    const evDelta = match.evPercent - b.evPercent;
    // Compare on EV rather than raw American odds, since American prices are
    // not linear and cross zero awkwardly.
    let fate: EdgeFate;
    if (evDelta > 0.01) fate = "improved";
    else if (evDelta < -0.01) fate = "worsened";
    else fate = "persisted";
    return { before: b, after: match, fate, priceDelta, evDelta };
  });
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function survived(c: EdgeComparison): boolean {
  return c.fate === "persisted" || c.fate === "improved";
}

export function decayReport(
  comparisons: EdgeComparison[],
  evEdges: number[] = DEFAULT_EV_EDGES,
): DecayReport {
  const total = comparisons.length;
  const persisted = comparisons.filter((c) => c.fate === "persisted").length;
  const improved = comparisons.filter((c) => c.fate === "improved").length;
  const worsened = comparisons.filter((c) => c.fate === "worsened").length;
  const vanished = comparisons.filter((c) => c.fate === "vanished").length;
  const matched = total - vanished;

  const byEvBucket: PersistenceBucket[] = [];
  for (let i = 0; i < evEdges.length - 1; i++) {
    const lowerEv = evEdges[i];
    const upperEv = evEdges[i + 1];
    const inBucket = comparisons.filter((c) => {
      const ev = c.before.evPercent;
      return ev >= lowerEv && (upperEv === Infinity ? true : ev < upperEv);
    });
    if (inBucket.length === 0) continue;
    byEvBucket.push({
      label: upperEv === Infinity ? `${lowerEv}%+` : `${lowerEv} to ${upperEv}%`,
      lowerEv,
      upperEv,
      count: inBucket.length,
      persisted: inBucket.filter((c) => c.fate === "persisted").length,
      improved: inBucket.filter((c) => c.fate === "improved").length,
      worsened: inBucket.filter((c) => c.fate === "worsened").length,
      vanished: inBucket.filter((c) => c.fate === "vanished").length,
      survivalRate: inBucket.filter(survived).length / inBucket.length,
      meanEvDelta: mean(inBucket.map((c) => c.evDelta).filter((v): v is number => v != null)),
    });
  }

  const bookMap = new Map<string, EdgeComparison[]>();
  for (const c of comparisons) {
    const list = bookMap.get(c.before.book) ?? [];
    list.push(c);
    bookMap.set(c.before.book, list);
  }
  const byBook: BookPersistence[] = Array.from(bookMap.entries())
    .map(([book, list]) => ({
      book,
      count: list.length,
      survivalRate: list.filter(survived).length / list.length,
      vanishRate: list.filter((c) => c.fate === "vanished").length / list.length,
    }))
    .sort((a, b) => a.survivalRate - b.survivalRate);

  return {
    totalEdges: total,
    matched,
    persisted,
    improved,
    worsened,
    vanished,
    overallSurvivalRate: total > 0 ? comparisons.filter(survived).length / total : NaN,
    meanEvDelta: mean(comparisons.map((c) => c.evDelta).filter((v): v is number => v != null)),
    byEvBucket,
    byBook,
    interpretation: interpret(total, comparisons, byEvBucket),
  };
}

function interpret(
  total: number,
  comparisons: EdgeComparison[],
  buckets: PersistenceBucket[],
): string {
  if (total === 0) return "No edges were flagged in the first scan, so there is nothing to measure.";
  if (total < 20) {
    return "Fewer than 20 edges in the sample. Run this across more sports or more rounds before drawing conclusions.";
  }

  const survival = comparisons.filter(survived).length / total;
  const lines: string[] = [];

  if (survival < 0.5) {
    lines.push(
      "Under half of flagged edges survived the re-scan. That is the signature of a latency artifact rather than genuine market inefficiency: you are largely measuring how stale the feed is.",
    );
  } else if (survival < 0.8) {
    lines.push(
      "Roughly half to four fifths of edges survived. Some real, some stale. Worth tightening the minimum edge threshold and favouring the books that hold their prices.",
    );
  } else {
    lines.push(
      "Most flagged edges were still there on the re-scan, which is what you want to see. The prices are real at the moment of the scan.",
    );
  }

  // The diagnostic cut: do bigger edges survive worse than smaller ones?
  const populated = buckets.filter((b) => b.count >= 5);
  if (populated.length >= 2) {
    const smallest = populated[0];
    const largest = populated[populated.length - 1];
    const drop = smallest.survivalRate - largest.survivalRate;
    if (drop >= 0.15) {
      lines.push(
        `Larger edges survive markedly worse than smaller ones (${(smallest.survivalRate * 100).toFixed(0)} percent at ${smallest.label} versus ${(largest.survivalRate * 100).toFixed(0)} percent at ${largest.label}). That means the fat right tail of your EV distribution is mostly stale quotes, and the biggest numbers on the screen are the least trustworthy.`,
      );
    } else if (drop <= -0.15) {
      lines.push(
        "Larger edges survive better than smaller ones, which is unusual and worth a look. It can happen when a book is genuinely slow to move on a real price.",
      );
    } else {
      lines.push("Survival is roughly flat across edge sizes, so big edges are no more suspect than small ones.");
    }
  }

  return lines.join(" ");
}
