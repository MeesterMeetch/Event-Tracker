/**
 * Minimal Anthropic Messages API client for the game-analysis feature.
 *
 * Plain fetch rather than the SDK: one endpoint, one call shape, and no new
 * dependency to keep in step with the lockfile. The analysis used to go
 * through Replit's OpenAI-compatible AI integration, whose env vars don't
 * exist on Render, so every analysis there failed before reaching a model.
 */

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
/** Adaptive thinking at medium effort usually lands well under a minute. */
const REQUEST_TIMEOUT_MS = 120_000;

export const ANALYSIS_MODEL = "claude-opus-5-5";
export const ANALYSIS_EFFORT = "medium";
/** Hard cap on thinking plus response text for one analysis. */
const MAX_TOKENS = 16_000;

/**
 * The service isn't set up to call the model at all (no API key). Distinct
 * from a model or network failure so the route can say exactly what to fix
 * instead of a generic "try again shortly" that never resolves.
 */
export class AnalysisConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisConfigError";
  }
}

interface MessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
}

/** Sends one system + user turn and returns the concatenated text blocks. */
export async function createMessage(system: string, user: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AnalysisConfigError("ANTHROPIC_API_KEY is not set on the API service.");
  }

  const res = await fetch(MESSAGES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": API_VERSION,
    },
    body: JSON.stringify({
      model: ANALYSIS_MODEL,
      max_tokens: MAX_TOKENS,
      output_config: { effort: ANALYSIS_EFFORT },
      system,
      messages: [{ role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    if (res.status === 401 || res.status === 403) {
      throw new AnalysisConfigError(`Anthropic rejected the API key (${res.status}). ${detail}`);
    }
    throw new Error(`Anthropic API ${res.status}: ${detail}`);
  }

  const data = (await res.json()) as MessagesResponse;
  // Thinking blocks are skipped; only the answer text is returned.
  return (data.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("")
    .trim();
}
