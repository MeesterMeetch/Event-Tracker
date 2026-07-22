import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

/**
 * Guards generateAnalysis, the lib that turns a raw LLM completion into the
 * structured scouting/betting report. This is a silent-failure surface: a bad
 * model response must fail loudly (throw) so the route returns a 502, rather
 * than surfacing — or caching — a half-empty analysis with an empty
 * matchupAnalysis/bettingAngle/keyFactors. These tests mock the AI client so
 * no real credits are spent and drive the parser with valid, non-JSON, and
 * incomplete-JSON completions.
 */

const mockCreate = vi.fn();
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create: mockCreate } } },
}));
vi.mock("./logger", () => ({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}));

let generateAnalysis: typeof import("./analysis").generateAnalysis;
let AnalysisFormatError: typeof import("./analysis").AnalysisFormatError;

const INPUT = {
  sport: "baseball_mlb",
  homeTeam: "New York Yankees",
  awayTeam: "Boston Red Sox",
  commenceTime: "2026-07-15T18:00:00Z",
  edges: [],
  homePitcher: null,
  awayPitcher: null,
};

/** A well-formed model payload with every required key present. */
const VALID = {
  summary: "Yankees hold a modest edge behind their probable starter.",
  matchupAnalysis: "Both starters have been sharp over their last three outings.",
  bettingAngle: "The moneyline carries the cleanest +EV; approach at a small unit size.",
  keyFactors: ["Home-field edge", "Rested bullpen", "Favorable recent form"],
};

/** Make the mocked client return `content` as the completion text. */
function returns(content: string): void {
  (mockCreate as Mock).mockResolvedValue({
    choices: [{ message: { content } }],
  });
}

/** Queue up per-call completion texts (first call, second call, ...). */
function returnsInSequence(...contents: string[]): void {
  for (const content of contents) {
    (mockCreate as Mock).mockResolvedValueOnce({
      choices: [{ message: { content } }],
    });
  }
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  ({ generateAnalysis, AnalysisFormatError } = await import("./analysis"));
});

describe("generateAnalysis — valid JSON", () => {
  it("parses a complete model response into structured content", async () => {
    returns(JSON.stringify(VALID));

    const content = await generateAnalysis(INPUT);

    expect(content).toEqual(VALID);
  });

  it("drops blank keyFactors entries but keeps the real ones", async () => {
    returns(JSON.stringify({ ...VALID, keyFactors: ["Real factor", "  ", ""] }));

    const content = await generateAnalysis(INPUT);

    expect(content.keyFactors).toEqual(["Real factor"]);
  });
});

describe("generateAnalysis — non-JSON output fails loudly", () => {
  it("throws AnalysisFormatError instead of dumping raw text into summary", async () => {
    returns("Sorry, I can't help with that.");

    await expect(generateAnalysis(INPUT)).rejects.toBeInstanceOf(AnalysisFormatError);
  });

  it("throws on an empty completion", async () => {
    returns("");

    await expect(generateAnalysis(INPUT)).rejects.toBeInstanceOf(AnalysisFormatError);
  });

  it("throws when JSON parses to a non-object (array)", async () => {
    returns(JSON.stringify(["not", "an", "object"]));

    await expect(generateAnalysis(INPUT)).rejects.toBeInstanceOf(AnalysisFormatError);
  });
});

describe("generateAnalysis — JSON missing required keys fails loudly", () => {
  it("throws when a required string field is absent", async () => {
    const { bettingAngle: _omit, ...partial } = VALID;
    returns(JSON.stringify(partial));

    await expect(generateAnalysis(INPUT)).rejects.toMatchObject({
      message: expect.stringMatching(/bettingAngle/),
    });
  });

  it("throws when a required string field is present but empty", async () => {
    returns(JSON.stringify({ ...VALID, summary: "   " }));

    await expect(generateAnalysis(INPUT)).rejects.toMatchObject({
      message: expect.stringMatching(/summary/),
    });
  });

  it("throws when keyFactors is missing entirely", async () => {
    const { keyFactors: _omit, ...partial } = VALID;
    returns(JSON.stringify(partial));

    await expect(generateAnalysis(INPUT)).rejects.toMatchObject({
      message: expect.stringMatching(/keyFactors/),
    });
  });

  it("throws when keyFactors is present but has no usable entries", async () => {
    returns(JSON.stringify({ ...VALID, keyFactors: ["", "  "] }));

    await expect(generateAnalysis(INPUT)).rejects.toMatchObject({
      message: expect.stringMatching(/keyFactors/),
    });
  });

  it("throws when keyFactors contains non-string entries", async () => {
    returns(JSON.stringify({ ...VALID, keyFactors: ["ok", 42, null] }));

    await expect(generateAnalysis(INPUT)).rejects.toBeInstanceOf(AnalysisFormatError);
  });

  it("reports every missing field at once", async () => {
    returns(JSON.stringify({ summary: "only this one" }));

    await expect(generateAnalysis(INPUT)).rejects.toMatchObject({
      message: expect.stringMatching(/matchupAnalysis.*bettingAngle.*keyFactors/),
    });
  });
});

describe("generateAnalysis — retries once on malformed output", () => {
  it("recovers when the first call is malformed and the second is valid", async () => {
    returnsInSequence("not json at all", JSON.stringify(VALID));

    const content = await generateAnalysis(INPUT);

    expect(content).toEqual(VALID);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("recovers when the first call is incomplete JSON and the second is valid", async () => {
    const { keyFactors: _omit, ...partial } = VALID;
    returnsInSequence(JSON.stringify(partial), JSON.stringify(VALID));

    const content = await generateAnalysis(INPUT);

    expect(content).toEqual(VALID);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("throws after retrying when both calls are malformed", async () => {
    returnsInSequence("still not json", "also not json");

    await expect(generateAnalysis(INPUT)).rejects.toBeInstanceOf(AnalysisFormatError);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("does not make a second call when the first attempt succeeds", async () => {
    returns(JSON.stringify(VALID));

    await generateAnalysis(INPUT);

    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
