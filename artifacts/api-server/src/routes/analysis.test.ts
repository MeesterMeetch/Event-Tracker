import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Express, type Request } from "express";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

/**
 * Guards POST /analysis, the AI scouting/betting write-up the user reads per
 * game. A regression here wouldn't crash — it would quietly surface an empty,
 * malformed, or stale report: caching the wrong game, serving an expired
 * analysis, accepting a bad payload, or swallowing an AI failure. These tests
 * exercise the real route with the MLB feed and AI client mocked (so no real
 * credits are spent and no live Stats API is hit); the request itself uses
 * node:http, mirroring the harness in bets.test.ts.
 *
 * The module is reset before each test so the route's in-memory cache starts
 * empty and tests stay isolated.
 */

vi.mock("../lib/mlb", () => ({
  getMatchupPitchers: vi.fn(),
}));

const ANALYSIS_MODEL = "test-analysis-model";
vi.mock("../lib/analysis", () => ({
  generateAnalysis: vi.fn(),
  ANALYSIS_MODEL,
}));

let mockGenerate: Mock;
let mockGetPitchers: Mock;

/** A well-formed AI analysis payload the mocked client returns by default. */
const CONTENT = {
  summary: "Yankees hold a modest edge behind their probable starter.",
  matchupAnalysis: "Both starters have been sharp over their last three outings.",
  bettingAngle: "The moneyline carries the cleanest +EV; approach at a small unit size.",
  keyFactors: ["Home-field edge", "Rested bullpen", "Favorable recent form"],
};

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mockGetPitchers = vi.mocked((await import("../lib/mlb")).getMatchupPitchers);
  mockGenerate = vi.mocked((await import("../lib/analysis")).generateAnalysis);
  mockGetPitchers.mockResolvedValue({ home: null, away: null });
  mockGenerate.mockResolvedValue(CONTENT);
});

async function buildApp(): Promise<Express> {
  const { default: analysisRouter } = await import("./analysis");
  const app = express();
  app.use(express.json());
  // Production attaches req.log via pino-http; the route logs on failure, so
  // give it a no-op logger here to mirror that contract.
  app.use((req: Request, _res, next) => {
    (req as unknown as { log: unknown }).log = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };
    next();
  });
  app.use("/api", analysisRouter);
  return app;
}

async function request(
  app: Express,
  method: "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path,
          method,
          headers: payload
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {},
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null }),
          );
        },
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const GAME = {
  sport: "baseball_mlb",
  gameId: "evt-mlb-1",
  homeTeam: "New York Yankees",
  awayTeam: "Boston Red Sox",
  commenceTime: "2026-07-15T18:00:00Z",
};

/** A complete edge belonging to GAME; override fields to break integrity. */
function edge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gameId: GAME.gameId,
    sport: GAME.sport,
    commenceTime: GAME.commenceTime,
    homeTeam: GAME.homeTeam,
    awayTeam: GAME.awayTeam,
    market: "h2h",
    selection: "New York Yankees",
    point: null,
    player: null,
    americanOdds: 150,
    book: "draftkings",
    fairOdds: 130,
    evPercent: 3.2,
    ...overrides,
  };
}

const VALID_BODY = { ...GAME, edges: [edge()] };

describe("POST /analysis — well-formed output", () => {
  it("returns a complete analysis for a valid game", async () => {
    const app = await buildApp();

    const { status, body } = await request(app, "POST", "/api/analysis", VALID_BODY);

    expect(status).toBe(200);
    const a = body as Record<string, unknown>;
    expect(a.gameId).toBe(GAME.gameId);
    expect(a.model).toBe(ANALYSIS_MODEL);
    expect(a.summary).toBe(CONTENT.summary);
    expect(a.matchupAnalysis).toBe(CONTENT.matchupAnalysis);
    expect(a.bettingAngle).toBe(CONTENT.bettingAngle);
    expect(a.keyFactors).toEqual(CONTENT.keyFactors);
    expect(typeof a.generatedAt).toBe("string");
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it("skips the MLB feed for non-MLB sports", async () => {
    const app = await buildApp();

    const nfl = {
      ...GAME,
      sport: "americanfootball_nfl",
      edges: [edge({ sport: "americanfootball_nfl" })],
    };
    const { status } = await request(app, "POST", "/api/analysis", nfl);

    expect(status).toBe(200);
    expect(mockGetPitchers).not.toHaveBeenCalled();
  });
});

describe("POST /analysis — caching", () => {
  it("serves the cached analysis within the TTL, then refreshes after it expires", async () => {
    const base = new Date("2026-07-15T12:00:00Z").getTime();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      const app = await buildApp();

      mockGenerate.mockResolvedValueOnce({ ...CONTENT, summary: "FIRST" });
      const r1 = await request(app, "POST", "/api/analysis", VALID_BODY);
      expect(r1.status).toBe(200);
      expect((r1.body as Record<string, unknown>).summary).toBe("FIRST");
      expect(mockGenerate).toHaveBeenCalledTimes(1);

      // Within the 30-minute window: served from cache, AI not called again.
      mockGenerate.mockResolvedValueOnce({ ...CONTENT, summary: "SECOND" });
      nowSpy.mockReturnValue(base + 20 * 60 * 1000);
      const r2 = await request(app, "POST", "/api/analysis", VALID_BODY);
      expect((r2.body as Record<string, unknown>).summary).toBe("FIRST");
      expect(mockGenerate).toHaveBeenCalledTimes(1);

      // Past the window: regenerated, no longer stale.
      nowSpy.mockReturnValue(base + 31 * 60 * 1000);
      const r3 = await request(app, "POST", "/api/analysis", VALID_BODY);
      expect((r3.body as Record<string, unknown>).summary).toBe("SECOND");
      expect(mockGenerate).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("caches game-line and player-prop analyses separately for the same game", async () => {
    const app = await buildApp();

    await request(app, "POST", "/api/analysis", VALID_BODY);
    const propsBody = {
      ...GAME,
      edges: [edge({ market: "batter_strikeouts", player: "Aaron Judge", point: 1.5 })],
    };
    await request(app, "POST", "/api/analysis", propsBody);

    // Different edge sets (lines vs props) must not share a cache slot.
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });
});

describe("POST /analysis — validation rejects bad input with a 400", () => {
  it("rejects a malformed body (missing required fields) and never calls the AI", async () => {
    const app = await buildApp();

    const { status } = await request(app, "POST", "/api/analysis", { sport: "baseball_mlb" });

    expect(status).toBe(400);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("rejects a payload whose edges belong to a different game", async () => {
    const app = await buildApp();

    const mixed = { ...GAME, edges: [edge({ gameId: "some-other-game" })] };
    const { status, body } = await request(app, "POST", "/api/analysis", mixed);

    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/edges must match/i);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("rejects an oversized edge payload", async () => {
    const app = await buildApp();

    const many = { ...GAME, edges: Array.from({ length: 51 }, () => edge()) };
    const { status, body } = await request(app, "POST", "/api/analysis", many);

    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/too many edges/i);
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});

describe("POST /analysis — AI failures surface, never silently succeed", () => {
  it("returns a 502 (not an empty 200) when the AI call throws", async () => {
    mockGenerate.mockRejectedValue(new Error("model unavailable"));
    const app = await buildApp();

    const { status, body } = await request(app, "POST", "/api/analysis", VALID_BODY);

    expect(status).toBe(502);
    expect((body as { error: string }).error).toMatch(/failed to generate/i);
  });

  it("does not cache a failure — a later working call still generates fresh output", async () => {
    mockGenerate.mockRejectedValueOnce(new Error("transient"));
    const app = await buildApp();

    const fail = await request(app, "POST", "/api/analysis", VALID_BODY);
    expect(fail.status).toBe(502);

    const ok = await request(app, "POST", "/api/analysis", VALID_BODY);
    expect(ok.status).toBe(200);
    expect((ok.body as Record<string, unknown>).summary).toBe(CONTENT.summary);
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });
});
