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

const { refetchMock, stateRef } = vi.hoisted(() => ({
  refetchMock: vi.fn(),
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
  useListTopPlays: () => ({ ...stateRef.current, refetch: refetchMock }),
  getListTopPlaysQueryKey: () => ["top-plays"],
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
    sportsFailed: [],
    scannedAt: "2026-08-03T18:40:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  stateRef.current = { data: undefined, isFetching: false, isError: false, error: undefined };
  refetchMock.mockReset();
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
    expect(screen.getByText(/Nothing cleared the bar/i)).toBeTruthy();
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
    expect(screen.queryByText(/Nothing cleared the bar/i)).toBeNull();
  });

  it("shows the scan is running and blocks a second click", () => {
    stateRef.current.isFetching = true;
    render(<TopPlays />);
    const button = screen.getByTestId("button-scan-top-plays") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/Scanning/i)).toBeTruthy();
  });
});
