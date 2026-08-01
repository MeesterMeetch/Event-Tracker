import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "./logger";
import type { ProbablePitcher } from "./mlb";

export const ANALYSIS_MODEL = "claude-sonnet-5";

function fmtOdds(american: number): string {
  const rounded = Math.round(american);
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}

export interface AnalysisEdge {
  market: string;
  selection: string;
  point: number | null;
  /** Player name for prop edges; null for team markets. */
  player: string | null;
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
  matchupAnalysis: string;
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

/** One edge rendered as a prompt line. */
function describeEdge(e: AnalysisInput["edges"][number]): string {
  const label = `${e.market.toUpperCase()} | ${e.player ? `${e.player} ` : ""}${e.selection}${
    e.point != null ? ` ${e.point}` : ""
  }`;
  // The sign has to come from the number. Hardcoding "+" printed "+-3.6%" on
  // the negative-EV rows that now reach this endpoint.
  const ev = `${e.evPercent >= 0 ? "+" : ""}${e.evPercent.toFixed(1)}%`;
  return `${label} @ ${fmtOdds(e.americanOdds)} (${e.book}); fair ${fmtOdds(e.fairOdds)}, ${ev} EV`;
}

function buildPrompt(input: AnalysisInput): string {
  // The client sends the bet the user actually clicked first. Without singling
  // it out, the model writes a general game preview and never addresses the
  // specific wager on screen, which is the one thing the user opened the dialog
  // to understand.
  const [focus, ...others] = input.edges;

  const focusSection = focus
    ? [
        "The bet to analyze:",
        `  ${describeEdge(focus)}`,
        "",
        "Explain THIS bet specifically. Why might this side hit or miss? Address the",
        "player and the number, not just the game. If the edge is small, negative, or",
        "rests on thin support, say so plainly rather than manufacturing a case for it.",
      ]
    : ["No specific bet was selected; give a general read on the game."];

  const contextLines =
    others.length > 0
      ? others.slice(0, 20).map((e) => `- ${describeEdge(e)}`).join("\n")
      : "- No other priced edges for this game.";

  const isBaseball = input.sport === "baseball_mlb";
  const isFootball = input.sport.startsWith("americanfootball_");

  const formSection = isBaseball
    ? [
        "Probable starting pitchers:",
        `${describePitcher("Home starter", input.homePitcher)}\n${describePitcher(
          "Away starter",
          input.awayPitcher,
        )}`,
      ]
    : isFootball
      ? [
          "Personnel / matchup notes:",
          "  Probable-starter feeds are MLB-only, so no roster data is provided here.",
          "  Reason from the matchup and the detected market edges: quarterback form and",
          "  volume, pace and total, matchup on the relevant side of the ball, and any",
          "  situational context implied by the line. Do not invent injuries or stat lines.",
        ]
      : [
          "Personnel / matchup notes:",
          "  No structured player feed is available for this sport. Reason from the",
          "  matchup and the detected market signals; never invent stats or injuries.",
        ];

  return [
    `Game: ${input.awayTeam} @ ${input.homeTeam}`,
    `Sport: ${input.sport}`,
    `Start (UTC): ${input.commenceTime}`,
    "",
    ...focusSection,
    "",
    "Other priced outcomes in this game, for context only (fair price derived by",
    "devigging the market consensus):",
    contextLines,
    "",
    ...formSection,
  ].join("\n");
}

const SYSTEM_PROMPT = `You are a sharp, disciplined sports betting analyst writing for a +EV bettor.
Analyze the specific game using ONLY the data provided; never invent stats, injuries, or lines you were not given.
Be concrete and concise. When probable starters or roster data are provided, weigh recent form heavily and reference specific numbers; when they are not, reason from the matchup and market signals without manufacturing detail.
When a specific bet is named, that bet is the subject. Say why that player might go over or under that exact number. A general game preview that never mentions the wager is a failed answer.
If a bet's edge looks thin or the sample is weak, say so — do not manufacture confidence.

Respond with a single JSON object with exactly these keys:
{
  "summary": string,            // 1-2 sentences framing the matchup and the sharpest angle
  "matchupAnalysis": string,    // 2-4 sentences on form and matchup impact — starting pitchers for MLB, quarterback/unit matchup and pace for football, general form otherwise
  "bettingAngle": string,       // 2-4 sentences on THE SPECIFIC BET being analyzed: the case for and against that exact side and number, and whether the price justifies it. Not a general game angle.
  "keyFactors": string[]        // 3-5 short bullet strings (each under ~15 words)
}
Output only the JSON object, no markdown fences.`;

/**
 * Raised when the model's output can't be parsed into a complete analysis
 * (non-JSON, or missing/wrong-typed required fields). The route catches this
 * and returns a 502 rather than serving — or caching — a half-empty report.
 */
export class AnalysisFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisFormatError";
  }
}

/**
 * Validate a parsed model response into a complete AnalysisContent, or throw
 * AnalysisFormatError. Every field is required: a missing or wrong-typed key
 * means the report would render half-empty, which we treat as a failure the
 * caller must surface — not something to paper over with empty strings/arrays.
 */
function coerceContent(raw: unknown): AnalysisContent {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AnalysisFormatError("model response was not a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  const missing: string[] = [];
  const reqStr = (key: keyof AnalysisContent): string => {
    const v = obj[key];
    if (typeof v !== "string" || v.trim() === "") {
      missing.push(key);
      return "";
    }
    return v;
  };

  const summary = reqStr("summary");
  const matchupAnalysis = reqStr("matchupAnalysis");
  const bettingAngle = reqStr("bettingAngle");

  const factors =
    Array.isArray(obj.keyFactors) &&
    obj.keyFactors.every((x): x is string => typeof x === "string");
  const keyFactors = factors ? (obj.keyFactors as string[]).filter((x) => x.trim() !== "") : [];
  if (!factors || keyFactors.length === 0) missing.push("keyFactors");

  if (missing.length > 0) {
    throw new AnalysisFormatError(
      `model response missing or invalid required field(s): ${missing.join(", ")}`,
    );
  }

  return { summary, matchupAnalysis, bettingAngle, keyFactors };
}

/**
 * Extra nudge appended to the system prompt on a retry, after a first attempt
 * came back malformed. Reiterates the strict JSON contract.
 */
const RETRY_NUDGE =
  "Your previous response could not be parsed. Respond with ONLY a single valid JSON object " +
  "containing exactly the required keys — no markdown, no prose, no code fences.";

/** One model call + parse/validate. Throws AnalysisFormatError on bad output. */
async function attemptAnalysis(input: AnalysisInput, retry: boolean): Promise<AnalysisContent> {
  const systemContent = retry ? `${SYSTEM_PROMPT}\n\n${RETRY_NUDGE}` : SYSTEM_PROMPT;
  const completion = await openai.chat.completions.create({
    model: ANALYSIS_MODEL,
    max_completion_tokens: 8192,
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: buildPrompt(input) },
    ],
  });

  const text = completion.choices[0]?.message?.content ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    logger.warn({ err, text: text.slice(0, 200) }, "analysis: model returned non-JSON");
    throw new AnalysisFormatError("model returned non-JSON output");
  }

  return coerceContent(parsed);
}

/**
 * Calls the LLM to produce a structured scouting/betting analysis for one game.
 * If the first attempt returns non-JSON or an incomplete object, retries once
 * (with a stricter JSON nudge) before giving up. Throws AnalysisFormatError if
 * the retry also fails, so the caller can fail loudly (502) instead of
 * surfacing/caching a partially-empty report.
 */
export async function generateAnalysis(input: AnalysisInput): Promise<AnalysisContent> {
  try {
    return await attemptAnalysis(input, false);
  } catch (err) {
    if (!(err instanceof AnalysisFormatError)) throw err;
    logger.warn({ err }, "analysis: first attempt malformed, retrying once");
    return await attemptAnalysis(input, true);
  }
}
