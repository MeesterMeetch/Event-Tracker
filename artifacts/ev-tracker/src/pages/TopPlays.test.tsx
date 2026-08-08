// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Guards the two things this page exists to get right.
 *
 * First, it must never scan on mount. A fan-out is one billed request per sport,
 * so a regression that fetches when the tab opens turns navigation into spend.
 *
 * Second, it must keep three states visually distinct that are easy to collapse
 * into one: a board where nothing cleared, a board that came back smaller
 * because some sports errored, and a scan that failed outright. They mean
 * completely different things to someone deciding whether to bet today, and an
 * empty list is only an answer in the first case.
 */

const { refetchMock, stateRef, paramsRef, analyzeMock } = vi.hoisted(() => ({
  refetchMock: vi.fn(),
  analyzeMock: vi.fn(),
  // Captures what the page asked the API for. The window is the whole point of
  // the feature, so "did it send one" is worth an assertion.
  paramsRef: { current: undefined as Record<string, string> | undefined },
  stateRef: {
    current: {
      data: undefined as unknown,
      isFetching: false,
      isError: false,
      error: undefined as unknown,
    },
  },
}));

vi.mock("@workspace/api-client-react", () => ({
  useListTopPlays: (params?: Record<string, string>) => {
    paramsRef.current = params;
    return { ...stateRef.current, refetch: refetchMock };
  },
  getListTopPlaysQueryKey: () => ["top-plays"],
  // Called at module scope by the analyze dialog on every play card. The
  // factory has to supply it even though most of these suites never open one.
  useGenerateGameAnalysis: () => ({
    mutate: analyzeMock,
    isPending: false,
    isError: false,
    data: undefined,
    error: undefined,
  }),
}));

import TopPlays from "./TopPlays";

function edge(overrides: Record<string, unknown> = {}) {
  return {
    gameId: "g1",
    sport: "baseball_mlb",
    commenceTime: "2026-08-04T23:05:00Z",
    homeTeam: "New York Yankees",
    awayTeam: "Boston Red Sox",
    market: "h2h",
    selection: "Boston Red Sox",
    point: null,
    player: null,
    americanOdds: 145,
    book: "DraftKings",
    dkOdds: 145,
    fairOdds: 120,
    evPercent: 3.2,
    sharpProb: 44.1,
    publicProb: 43.2,
    bookCount: 11,
    dispersionPercent: 0.9,
    confidenceTier: "solid",
    confidenceScore: 82,
    confidenceReasons: ["11 books", "sharp agrees"],
    ...overrides,
  };
}

function play(overrides: Record<string, unknown> = {}) {
  return {
    edge: edge(),
    rank: 1,
    score: 96.4,
    rationale: "3.2% EV at DraftKings · solid · 11 books",
    sameGameCount: 0,
    ...overrides,
  };
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    totalEdges: 184,
    eligibleEdges: 2,
    byTier: { solid: 1, playable: 33, fragile: 0, suspect: 22 },
    gamesRepresented: 14,
    sportsRepresented: 2,
    interpretation: "Only 1 play cleared the bar.",
    ...overrides,
  };
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    picks: [play()],
    summary: summary(),
    sportsScanned: ["baseball_mlb", "basketball_nba"],
    sportsSkipped: [],
    sportsFailed: [],
    scannedAt: "2026-08-03T18:40:00Z",
    windowStart: "2026-08-03T18:40:00Z",
    windowEnd: "2026-08-04T06:00:00Z",
    edgesOutsideWindow: 0,
    ...overrides,
  };
}

beforeEach(() => {
  stateRef.current = { data: undefined, isFetching: false, isError: false, error: undefined };
  refetchMock.mockReset();
  refetchMock.mockResolvedValue(undefined);
  analyzeMock.mockReset();
  paramsRef.current = undefined;
});

afterEach(cleanup);

describe("TopPlays", () => {
  it("does not scan until asked, because every sport is a billed request", async () => {
    render(<TopPlays />);
    expect(refetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Nothing scanned yet/i)).toBeTruthy();

    await userEvent.click(screen.getByTestId("button-scan-top-plays"));
    expect(refetchMock).toHaveBeenCalledTimes(1);
  });

  it("warns up front that an empty list is the expected result", () => {
    render(<TopPlays />);
    expect(screen.getByText(/On an efficient day it will be empty/i)).toBeTruthy();
  });

  it("leads with the read on the slate, not the list", () => {
    stateRef.current.data = response();
    render(<TopPlays />);
    expect(screen.getByText("Only 1 play cleared the bar.")).toBeTruthy();
    expect(screen.getByText(/184 priced/)).toBeTruthy();
    expect(screen.getByText(/14 games/)).toBeTruthy();
  });

  it("renders a pick with its price, book and rationale", () => {
    stateRef.current.data = response();
    render(<TopPlays />);
    expect(screen.getByText("+145")).toBeTruthy();
    expect(screen.getByText("DraftKings")).toBeTruthy();
    expect(screen.getByText(/3.2% EV at DraftKings/)).toBeTruthy();
    expect(screen.getByText("solid")).toBeTruthy();
  });

  it("tells you to size down a second pick from the same game", () => {
    stateRef.current.data = response({
      picks: [play(), play({ rank: 2, sameGameCount: 1 })],
    });
    render(<TopPlays />);
    expect(screen.getByText(/Second selection from this game/i)).toBeTruthy();
  });

  it("says nothing cleared without implying anything broke", () => {
    stateRef.current.data = response({
      picks: [],
      summary: summary({ interpretation: "Nothing on the board clears the bar today." }),
    });
    render(<TopPlays />);
    expect(screen.getByText(/Nothing on the board clears the bar today/i)).toBeTruthy();
    expect(screen.getByText(/Nothing priced for/i)).toBeTruthy();
    expect(screen.queryByText(/The scan failed/i)).toBeNull();
  });

  it("flags a partially failed fan-out so a thin board is not misread as a tight market", () => {
    stateRef.current.data = response({
      picks: [],
      sportsScanned: ["baseball_mlb"],
      sportsFailed: [{ sport: "basketball_nba", reason: "502" }],
    });
    render(<TopPlays />);
    expect(screen.getByText(/1 of 2 sports failed to scan/i)).toBeTruthy();
    expect(screen.getByText(/not necessarily because the market is tight/i)).toBeTruthy();
  });

  it("keeps an outright failure distinct from a quiet board", () => {
    stateRef.current.isError = true;
    stateRef.current.error = new Error("Every sport failed to scan.");
    render(<TopPlays />);
    expect(screen.getByText(/The scan failed/i)).toBeTruthy();
    expect(screen.getByText(/no conclusion should be drawn about today/i)).toBeTruthy();
    expect(screen.queryByText(/Nothing priced for/i)).toBeNull();
  });

  it("shows the scan is running and blocks a second click", () => {
    stateRef.current.isFetching = true;
    render(<TopPlays />);
    const button = screen.getByTestId("button-scan-top-plays") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/Scanning/i)).toBeTruthy();
  });

  /**
   * The feed hands back every upcoming event in a sport, so without a window a
   * September football game lands in the same pool as tonight's baseball and
   * can outrank it. The window has to come from the browser, because the server
   * runs in UTC and would call it tomorrow for the last hours of every evening.
   */
  it("asks only for today, bounded by the viewer's own midnight", async () => {
    render(<TopPlays />);
    expect(paramsRef.current).toBeUndefined();

    await userEvent.click(screen.getByTestId("button-scan-top-plays"));

    const params = paramsRef.current;
    expect(params).toBeDefined();

    const start = new Date(params!.startTime);
    const end = new Date(params!.endTime);

    // Starts at roughly now: games already underway are not plays.
    expect(Math.abs(start.getTime() - Date.now())).toBeLessThan(60_000);
    // Ends at local midnight, whatever timezone the viewer is in.
    expect(end.getHours()).toBe(0);
    expect(end.getMinutes()).toBe(0);
    expect(end.getTime()).toBeGreaterThan(start.getTime());
  });

  /**
   * Every option has to land on a local midnight rather than on "now plus N
   * days". A rolling 24 hours would put tomorrow afternoon's baseball in a list
   * labelled Today, which is the bug this whole window exists to prevent.
   */
  it.each([
    ["today", 0],
    ["tomorrow", 1],
    ["week", 7],
    ["fortnight", 14],
  ])("ends the %s window on a local midnight %i days past tonight", async (key, extraDays) => {
    render(<TopPlays />);

    await userEvent.click(screen.getByTestId(`button-window-${key}`));
    await userEvent.click(screen.getByTestId("button-scan-top-plays"));

    const end = new Date(paramsRef.current!.endTime);
    expect(end.getHours()).toBe(0);
    expect(end.getMinutes()).toBe(0);

    const tonight = new Date();
    tonight.setHours(24, 0, 0, 0);
    const dayMs = 24 * 60 * 60 * 1000;
    // Compared in whole days to stay correct across a daylight saving boundary,
    // where the span is 23 or 25 hours rather than 24.
    expect(Math.round((end.getTime() - tonight.getTime()) / dayMs)).toBe(extraDays);
  });

  it("defaults to today, so the expensive-looking option is never the accidental one", async () => {
    render(<TopPlays />);
    expect(screen.getByTestId("button-window-today").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("button-window-fortnight").getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  /**
   * A fortnight-wide list is a different object than a list of tonight's plays,
   * and the page should not let those be confused.
   */
  it("warns that a wide window is not a list of plays to make now", async () => {
    render(<TopPlays />);
    expect(screen.queryByTestId("text-wide-window-note")).toBeNull();

    await userEvent.click(screen.getByTestId("button-window-week"));
    expect(screen.getByTestId("text-wide-window-note")).toBeTruthy();
  });

  it("labels an empty result with the window it actually scanned", async () => {
    stateRef.current.data = response({ picks: [], edgesOutsideWindow: 3 });
    render(<TopPlays />);
    expect(screen.getByText(/Nothing priced for today/i)).toBeTruthy();
  });

  /**
   * An empty list because the day is over and an empty list because the market
   * is tight are the same JSON. They are not the same message.
   */
  it("distinguishes a finished day from a tight market", async () => {
    stateRef.current.data = response({ picks: [], edgesOutsideWindow: 41 });
    render(<TopPlays />);
    expect(screen.getByTestId("text-outside-window").textContent).toMatch(/41 priced outcomes/);
  });

  it("says nothing about later days when the window held everything", async () => {
    stateRef.current.data = response({ picks: [], edgesOutsideWindow: 0 });
    render(<TopPlays />);
    expect(screen.queryByTestId("text-outside-window")).toBeNull();
  });

  /**
   * The page asks for the whole ranked board rather than only what clears the
   * bar. An empty list on a day when 146 outcomes were priced is not an answer
   * anyone can act on; it hides where the market actually sits.
   */
  it("asks for the full ranked board, not just what clears the bar", async () => {
    render(<TopPlays />);
    await userEvent.click(screen.getByTestId("button-scan-top-plays"));
    expect(Number(paramsRef.current!.minEvPercent)).toBeLessThan(0);
    expect(Number(paramsRef.current!.limit)).toBeGreaterThanOrEqual(10);
  });

  /**
   * The whole risk of showing a board with nothing on it is that a ranked list
   * reads as a recommendation. It has to be impossible to mistake.
   */
  it("says plainly that nothing clears, and still ranks the board", async () => {
    stateRef.current.data = response({
      picks: [
        play({ rank: 1, edge: edge({ evPercent: -0.34, gameId: "g1" }) }),
        play({ rank: 2, edge: edge({ evPercent: -1.1, gameId: "g2" }) }),
      ],
    });
    render(<TopPlays />);

    expect(screen.getByTestId("text-nothing-clears").textContent).toMatch(/worse than fair/i);
    expect(screen.getByTestId("list-below-bar")).toBeTruthy();
    expect(screen.queryByTestId("list-clearing")).toBeNull();
  });

  it("separates what clears the bar from what is only context", async () => {
    stateRef.current.data = response({
      picks: [
        play({ rank: 1, edge: edge({ evPercent: 3.2, gameId: "g1" }) }),
        play({ rank: 2, edge: edge({ evPercent: -0.4, gameId: "g2" }) }),
      ],
    });
    render(<TopPlays />);

    expect(screen.getByTestId("list-clearing")).toBeTruthy();
    expect(screen.getByTestId("list-below-bar")).toBeTruthy();
    expect(screen.queryByTestId("text-nothing-clears")).toBeNull();
  });

  /**
   * The EV is one number derived from several. Showing only the output makes a
   * 3% edge with no sharp price look identical to a 3% edge the sharps agree
   * with, and those are not the same bet.
   */
  it("shows the numbers behind the EV, not just the EV", () => {
    stateRef.current.data = response({
      picks: [play({ rank: 1, edge: edge({ marketProb: 47.2, sharpProb: 51.3, publicProb: 44.8 }) })],
    });
    render(<TopPlays />);

    expect(screen.getByTestId("text-market-1").textContent).toMatch(/47\.2%/);
    expect(screen.getByTestId("text-sharp-1").textContent).toMatch(/51\.3%/);
    expect(screen.getByTestId("text-public-1").textContent).toMatch(/44\.8%/);
  });

  /**
   * A missing sharp price is information, not a blank. Roughly half of a given
   * MLB slate has no Pinnacle line, and those edges are assessed without the
   * input that matters most.
   */
  it("says so when there is no sharp price rather than rendering nothing", () => {
    stateRef.current.data = response({
      picks: [play({ rank: 1, edge: edge({ sharpProb: null, publicProb: null }) })],
    });
    render(<TopPlays />);

    expect(screen.getByTestId("text-sharp-1").textContent).toMatch(/none/i);
    expect(screen.getByTestId("text-public-1").textContent).toMatch(/none/i);
  });

  it("names the sports it skipped, so an absent sport is not mistaken for a bug", () => {
    stateRef.current.data = response({ sportsSkipped: ["americanfootball_nfl", "icehockey_nhl"] });
    render(<TopPlays />);
    expect(screen.getByTestId("text-sports-skipped").textContent).toMatch(/americanfootball_nfl/);
  });

  it("stays quiet about skipped sports when nothing was skipped", () => {
    stateRef.current.data = response({ sportsSkipped: [] });
    render(<TopPlays />);
    expect(screen.queryByTestId("text-sports-skipped")).toBeNull();
  });

  /**
   * The board can hold fifteen rows and each analysis is a billed AI call, so
   * nothing may fire until a dialog is actually opened.
   */
  it("does not spend an AI call until the dialog is opened", () => {
    stateRef.current.data = response();
    render(<TopPlays />);
    expect(screen.getByTestId("button-analyze-1")).toBeTruthy();
    expect(analyzeMock).not.toHaveBeenCalled();
  });

  /**
   * The endpoint requires every edge in a request to belong to one game and
   * caches per game, so a game with two picks must send both in a single call
   * rather than paying twice for the same write-up.
   */
  it("sends the whole game when a game has more than one pick", async () => {
    stateRef.current.data = response({
      picks: [
        play({ rank: 1, edge: edge({ gameId: "g1", selection: "Red Sox" }) }),
        play({ rank: 2, edge: edge({ gameId: "g1", selection: "Over 8.5", market: "totals" }) }),
      ],
    });
    render(<TopPlays />);

    await userEvent.click(screen.getByTestId("button-analyze-1"));

    expect(analyzeMock).toHaveBeenCalledTimes(1);
    const sent = analyzeMock.mock.calls[0][0].data;
    expect(sent.gameId).toBe("g1");
    expect(sent.edges).toHaveLength(2);
  });

  it("sends only that game, not the whole board", async () => {
    stateRef.current.data = response({
      picks: [
        play({ rank: 1, edge: edge({ gameId: "g1" }) }),
        play({ rank: 2, edge: edge({ gameId: "g2" }) }),
      ],
    });
    render(<TopPlays />);

    await userEvent.click(screen.getByTestId("button-analyze-2"));

    const sent = analyzeMock.mock.calls[0][0].data;
    expect(sent.gameId).toBe("g2");
    expect(sent.edges).toHaveLength(1);
  });

  it("cannot export a board that has not been scanned", () => {
    render(<TopPlays />);
    expect((screen.getByTestId("button-export-top-plays") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("offers the export once there is a board to export", () => {
    stateRef.current.data = response();
    render(<TopPlays />);
    expect((screen.getByTestId("button-export-top-plays") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});
