/**
 * Model validation report. Run with `pnpm model:report`.
 *
 * Pulls every graded pitcher-strikeout paper trade and answers three questions:
 *
 *   1. Is the model showing tail bias, i.e. does it get worse the further the
 *      posted line sits from its projection? That is the fingerprint of an
 *      understated variance term.
 *   2. Is the model calibrated? When it says 60 percent, does it win 60?
 *   3. Does the model beat the de-vigged market, and if so by how much?
 *
 * Questions two and three end in numbers you can paste into model-config.ts (or
 * set as environment variables) to switch the corrections on. Nothing here
 * writes to the database.
 */

import { isNull, isNotNull, and } from "drizzle-orm";
import { db, pitcherKPaperTradesTable } from "@workspace/db";
import { tailBiasReport, resolvedTrades, isTailSide, type GradedTrade } from "../src/lib/model-diagnostics";
import { calibrationReport, fitPlatt, applyPlatt, brierScore, type Prediction } from "../src/lib/calibration";
import { fitBlendWeight, type BlendSample } from "../src/lib/model-blend";
import { MIN_GRADED_FOR_CALIBRATION, MIN_GRADED_FOR_BLEND_WEIGHT } from "../src/lib/model-config";

function pct(x: number | null | undefined, digits = 1): string {
  if (x == null || !Number.isFinite(x)) return "n/a";
  return `${(x * 100).toFixed(digits)}%`;
}

function num(x: number | null | undefined, digits = 4): string {
  if (x == null || !Number.isFinite(x)) return "n/a";
  return x.toFixed(digits);
}

function heading(title: string): void {
  console.log("");
  console.log(title);
  console.log("=".repeat(title.length));
}

async function main(): Promise<void> {
  const rows = await db
    .select()
    .from(pitcherKPaperTradesTable)
    .where(and(isNull(pitcherKPaperTradesTable.deletedAt), isNotNull(pitcherKPaperTradesTable.outcome)));

  const trades: GradedTrade[] = rows.map((r) => ({
    selection: r.selection === "Under" ? "Under" : "Over",
    point: r.point,
    expectedStrikeouts: r.expectedStrikeouts,
    modelProb: r.modelProb,
    marketProb: r.marketProb,
    edgePercent: r.edgePercent,
    clvPercent: r.clvPercent,
    beatClose: r.beatClose,
    outcome: r.outcome,
    isFlagged: r.isFlagged,
  }));

  const resolved = resolvedTrades(trades);

  heading("Sample");
  console.log(`Graded rows found:        ${rows.length}`);
  console.log(`Resolved (won or lost):   ${resolved.length}`);
  console.log(`Excluded (push or void):  ${rows.length - resolved.length}`);
  if (resolved.length === 0) {
    console.log("");
    console.log("Nothing to analyze yet. Log some model flags and let them grade out.");
    return;
  }

  // ---- 1. Tail bias ----
  heading("1. Tail bias (line distance from projection)");
  const tail = tailBiasReport(trades);
  console.log("gap band      n     win%    model%   gap      avg CLV   beat close   tail-side");
  for (const b of tail.buckets) {
    console.log(
      `${b.label.padEnd(13)} ${String(b.count).padStart(3)}   ${pct(b.winRate).padStart(6)}  ` +
        `${pct(b.meanModelProb).padStart(6)}  ${pct(b.calibrationGap).padStart(7)}  ` +
        `${(b.avgClvPercent == null ? "n/a" : b.avgClvPercent.toFixed(2)).padStart(7)}   ` +
        `${pct(b.beatCloseRate).padStart(8)}     ${String(b.tailSideCount).padStart(3)}`,
    );
  }
  console.log("");
  console.log(`Spread (widest minus narrowest gap): ${pct(tail.spread)}`);
  console.log(tail.interpretation);
  const tailSideTotal = resolved.filter(isTailSide).length;
  console.log(
    `Bets taking the far-tail side: ${tailSideTotal} of ${resolved.length} (${pct(tailSideTotal / resolved.length)}). ` +
      "A very low share is itself evidence the old fixed-n distribution was under-pricing the tails.",
  );

  // ---- 2. Calibration ----
  heading("2. Calibration");
  const predictions: Prediction[] = resolved.map((t) => ({ prob: t.modelProb, won: t.outcome === "won" }));
  const report = calibrationReport(predictions);
  console.log(`Sample size:        ${report.sampleSize}`);
  console.log(`Mean predicted:     ${pct(report.meanPredicted)}`);
  console.log(`Actual win rate:    ${pct(report.actualRate)}`);
  console.log(`Brier score:        ${num(report.brierScore)}  (lower is better)`);
  console.log(`Base-rate Brier:    ${num(report.baseRateBrier)}  (beat this to add value)`);
  console.log(`Brier skill score:  ${num(report.brierSkillScore)}  (above 0 means the model beats the base rate)`);
  console.log(`Log loss:           ${num(report.logLoss)}`);
  console.log("");
  console.log("Reliability curve:");
  console.log("bucket        n     predicted   actual    gap");
  for (const b of report.buckets) {
    console.log(
      `${`${pct(b.lower, 0)}-${pct(b.upper, 0)}`.padEnd(13)} ${String(b.count).padStart(3)}   ` +
        `${pct(b.meanPredicted).padStart(8)}   ${pct(b.actualRate).padStart(6)}  ${pct(b.gap).padStart(7)}`,
    );
  }

  const platt = fitPlatt(predictions);
  const calibratedBrier = brierScore(predictions.map((p) => ({ prob: applyPlatt(p.prob, platt), won: p.won })));
  console.log("");
  console.log(`Fitted Platt scaling:  a = ${num(platt.a)},  b = ${num(platt.b)}`);
  console.log(`Brier after correction: ${num(calibratedBrier)} (was ${num(report.brierScore)})`);
  if (platt.a < 0.9) {
    console.log("Slope below 1 means the model is overconfident: it should be pulled toward the middle.");
  } else if (platt.a > 1.1) {
    console.log("Slope above 1 means the model is underconfident: its edges are real but understated.");
  } else {
    console.log("Slope near 1 means the model is reasonably calibrated already.");
  }
  if (report.sampleSize < MIN_GRADED_FOR_CALIBRATION) {
    console.log("Sample is small. Do not wire these coefficients in yet.");
  } else {
    console.log(`To apply: set MODEL_PLATT_A=${platt.a.toFixed(4)} and MODEL_PLATT_B=${platt.b.toFixed(4)}`);
  }

  // ---- 3. Model versus market ----
  heading("3. Model versus de-vigged market");
  const blendSamples: BlendSample[] = resolved
    .filter((t) => t.marketProb != null)
    .map((t) => ({ modelProb: t.modelProb, marketProb: t.marketProb as number, won: t.outcome === "won" }));
  const fit = fitBlendWeight(blendSamples);
  console.log(`Sample size (with market prob): ${fit.sampleSize}`);
  console.log(`Log loss, model only:   ${num(fit.modelOnlyLogLoss)}`);
  console.log(`Log loss, market only:  ${num(fit.marketOnlyLogLoss)}`);
  console.log(`Log loss, best blend:   ${num(fit.logLoss)}`);
  console.log(`Fitted weight on model: ${num(fit.weight, 2)}`);
  console.log(fit.interpretation);
  if (fit.sampleSize >= MIN_GRADED_FOR_BLEND_WEIGHT) {
    console.log(`To apply: set MODEL_BLEND_WEIGHT=${fit.weight.toFixed(2)}`);
  }

  // ---- 4. Closing line value ----
  heading("4. Closing line value");
  const withClv = resolved.filter((t) => t.clvPercent != null);
  if (withClv.length === 0) {
    console.log("No closing lines captured yet.");
  } else {
    const avgClv = withClv.reduce((a, t) => a + (t.clvPercent as number), 0) / withClv.length;
    const beat = withClv.filter((t) => t.beatClose === true).length;
    console.log(`Trades with a closing line: ${withClv.length}`);
    console.log(`Average CLV:                ${avgClv.toFixed(2)}%`);
    console.log(`Beat the close:             ${beat} (${pct(beat / withClv.length)})`);
    console.log("");
    console.log(
      "CLV is the lowest-variance read you have. If average CLV is positive but win rate is not, " +
        "keep going: the picks are good and the sample is short. If CLV is negative, the model is " +
        "behind the market regardless of what the win rate says.",
    );
  }

  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("model:report failed", err);
    process.exit(1);
  });
