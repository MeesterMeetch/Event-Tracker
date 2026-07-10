import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "./logger";
import type { ProbablePitcher } from "./mlb";

export const ANALYSIS_MODEL = "gpt-5.4-mini";

function fmtOdds(american: number): string {
  const rounded = Math.round(american);
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}

export interface AnalysisEdge {
  market: string;
  selection: string;
  point: number | null;
  book: string;
  americanOdds: number;
  fairOdds: number;
  evPercent: number;
}

export interface AnalysisInput {
  sport: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  edges: AnalysisEdge[];
  homePitcher: ProbablePitcher | null;
  awayPitcher: ProbablePitcher | null;
}

export interface AnalysisContent {
  summary: string;
  pitchingAnalysis: string;
  bettingAngle: string;
  keyFactors: string[];
}

function describePitcher(role: string, p: ProbablePitcher | null): string {
  if (!p) return `${role}: probable starter not announced / unavailable.`;
  const lines: string[] = [];
  lines.push(
    `${role}: ${p.name} (${p.team}) — ${p.seasonRecord ?? "?-?"}, ` +
      `${p.seasonEra ?? "?"} ERA, ${p.seasonWhip ?? "?"} WHIP, ` +
      `${p.seasonStrikeouts ?? "?"} K over ${p.inningsPitched ?? "?"} IP ` +
      `(${p.gamesStarted ?? "?"} starts).`,
  );
  if (p.recentStarts.length > 0) {
    lines.push("  Recent starts (most recent first):");
    for (const s of p.recentStarts) {
      lines.push(
        `    ${s.date} vs ${s.opponent}: ${s.inningsPitched} IP, ${s.earnedRuns} ER, ` +
          `${s.strikeOuts} K, ${s.walks} BB, ${s.hits} H (${s.decision}).`,
      );
    }
  } else {
    lines.push("  No recent start logs available.");
  }
  return lines.join("\n");
}

function buildPrompt(input: AnalysisInput): string {
  const edgeLines =
    input.edges.length > 0
      ? input.edges
          .map(
            (e) =>
              `- ${e.market.toUpperCase()} | ${e.selection}${
                e.point != null ? ` ${e.point}` : ""
              } @ ${fmtOdds(e.americanOdds)} (${e.book}); fair ${fmtOdds(
                e.fairOdds,
              )}, +${e.evPercent.toFixed(1)}% EV`,
          )
          .join("\n")
      : "- No standout +EV edges detected for this game right now.";

  const pitching =
    input.sport === "baseball_mlb"
      ? `${describePitcher("Home starter", input.homePitcher)}\n${describePitcher(
          "Away starter",
          input.awayPitcher,
        )}`
      : "Probable-starter data is only available for MLB. Focus on the matchup and market signals.";

  return [
    `Game: ${input.awayTeam} @ ${input.homeTeam}`,
    `Sport: ${input.sport}`,
    `Start (UTC): ${input.commenceTime}`,
    "",
    "Detected +EV betting edges (fair price derived by devigging the market consensus):",
    edgeLines,
    "",
    "Probable starting pitchers:",
    pitching,
  ].join("\n");
}

const SYSTEM_PROMPT = `You are a sharp, disciplined sports betting analyst writing for a +EV bettor.
Analyze the specific game using ONLY the data provided; never invent stats, injuries, or lines you were not given.
Be concrete and concise. When probable pitchers are provided, weigh their recent-start form heavily and reference specific numbers.
If a bet's edge looks thin or the sample is weak, say so — do not manufacture confidence.

Respond with a single JSON object with exactly these keys:
{
  "summary": string,            // 1-2 sentences framing the matchup and the sharpest angle
  "pitchingAnalysis": string,   // 2-4 sentences on the probable starters' recent form and matchup impact (for non-MLB, discuss form/matchup generally)
  "bettingAngle": string,       // 2-4 sentences tying the analysis to the detected +EV edges and how you'd approach them
  "keyFactors": string[]        // 3-5 short bullet strings (each under ~15 words)
}
Output only the JSON object, no markdown fences.`;

function coerceContent(raw: unknown): AnalysisContent {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const asStr = (v: unknown, fallback = ""): string =>
    typeof v === "string" ? v : fallback;
  const factors = Array.isArray(obj.keyFactors)
    ? obj.keyFactors.filter((x): x is string => typeof x === "string")
    : [];
  return {
    summary: asStr(obj.summary),
    pitchingAnalysis: asStr(obj.pitchingAnalysis),
    bettingAngle: asStr(obj.bettingAngle),
    keyFactors: factors,
  };
}

/** Calls the LLM to produce a structured scouting/betting analysis for one game. */
export async function generateAnalysis(input: AnalysisInput): Promise<AnalysisContent> {
  const completion = await openai.chat.completions.create({
    model: ANALYSIS_MODEL,
    max_completion_tokens: 8192,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildPrompt(input) },
    ],
  });

  const text = completion.choices[0]?.message?.content ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    logger.warn({ err, text: text.slice(0, 200) }, "analysis: model returned non-JSON");
    // Fall back to putting the raw text in the summary so the user still sees something.
    return {
      summary: text || "Analysis could not be generated.",
      pitchingAnalysis: "",
      bettingAngle: "",
      keyFactors: [],
    };
  }

  return coerceContent(parsed);
}
