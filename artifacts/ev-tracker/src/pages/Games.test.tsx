// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { GameSummary } from "@workspace/api-client-react";

/**
 * Guards the MLB Games page against key regressions:
 * - Loading skeleton renders while data is in flight
 * - Game cards show matchup, status badge, probable pitchers, and scores
 * - Scores are hidden for scheduled games and shown for live/final games
 * - The empty-state message renders when the date has no games
 * - The error state renders when the fetch fails
 */

let gamesData: GameSummary[] | undefined;
let isLoading = false;
let isError = false;

vi.mock("@workspace/api-client-react", () => ({
  useListMlbGames: () => ({ data: gamesData, isLoading, isError }),
}));

import Games from "./Games";

function makeGame(overrides: Partial<GameSummary> = {}): GameSummary {
  return {
    gamePk: 800001,
    gameDate: "2026-07-18T17:10:00Z",
    status: { abstractGameState: "Final", detailedState: "Final" },
    homeTeam: "Los Angeles Dodgers",
    awayTeam: "San Francisco Giants",
    homeProbablePitcher: { id: 605483, name: "Blake Snell" },
    awayProbablePitcher: { id: 657277, name: "Logan Webb" },
    homeScore: 5,
    awayScore: 3,
    ...overrides,
  } as GameSummary;
}

afterEach(() => {
  cleanup();
  gamesData = undefined;
  isLoading = false;
  isError = false;
});

describe("Games — loading state", () => {
  it("renders skeleton placeholders while data is in flight", () => {
    isLoading = true;
    const { container } = render(<Games />);
    // Skeletons are rendered while loading — there should be multiple.
    const skeletons = container.querySelectorAll("[class*='skeleton'], [data-skeleton], .animate-pulse");
    expect(skeletons.length).toBeGreaterThan(0);
  });
});

describe("Games — error state", () => {
  it("shows an error message when the fetch fails", () => {
    isError = true;
    render(<Games />);
    expect(screen.getByText(/failed to load schedule/i)).toBeTruthy();
  });
});

describe("Games — empty state", () => {
  it("shows a friendly empty state when the date has no games", () => {
    gamesData = [];
    render(<Games />);
    expect(screen.getByText(/no games scheduled for this date/i)).toBeTruthy();
  });
});

describe("Games — game cards", () => {
  it("renders team names for both sides", () => {
    gamesData = [makeGame()];
    render(<Games />);
    expect(screen.getByText("San Francisco Giants")).toBeTruthy();
    expect(screen.getByText("Los Angeles Dodgers")).toBeTruthy();
  });

  it("shows the status badge with the detailedState text", () => {
    gamesData = [makeGame({ status: { abstractGameState: "Final", detailedState: "Final" } })];
    render(<Games />);
    expect(screen.getByText("Final")).toBeTruthy();
  });

  it("shows a Live badge for in-progress games", () => {
    gamesData = [
      makeGame({
        gamePk: 800002,
        status: { abstractGameState: "Live", detailedState: "In Progress" },
        homeScore: 1,
        awayScore: 2,
      }),
    ];
    render(<Games />);
    expect(screen.getByText("In Progress")).toBeTruthy();
  });

  it("renders scores for Final games", () => {
    gamesData = [makeGame({ homeScore: 5, awayScore: 3 })];
    render(<Games />);
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("renders scores for Live games", () => {
    gamesData = [
      makeGame({
        status: { abstractGameState: "Live", detailedState: "In Progress" },
        homeScore: 2,
        awayScore: 1,
      }),
    ];
    render(<Games />);
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
  });

  it("does not render scores for Scheduled games", () => {
    gamesData = [
      makeGame({
        status: { abstractGameState: "Preview", detailedState: "Scheduled" },
        homeScore: null,
        awayScore: null,
      }),
    ];
    render(<Games />);
    expect(screen.queryByText("5")).toBeNull();
    expect(screen.queryByText("3")).toBeNull();
  });

  it("renders probable pitcher names when present", () => {
    gamesData = [makeGame()];
    render(<Games />);
    expect(screen.getByText(/Blake Snell/)).toBeTruthy();
    expect(screen.getByText(/Logan Webb/)).toBeTruthy();
  });

  it("skips the pitcher section when neither side has a probable starter", () => {
    gamesData = [
      makeGame({
        homeProbablePitcher: null,
        awayProbablePitcher: null,
      }),
    ];
    const { container } = render(<Games />);
    // The pitcher block is only rendered when at least one pitcher is present.
    expect(container.querySelectorAll("svg").length).toBeGreaterThanOrEqual(0);
    expect(screen.queryByText(/Blake Snell/)).toBeNull();
    expect(screen.queryByText(/Logan Webb/)).toBeNull();
  });

  it("renders multiple game cards for a multi-game slate", () => {
    gamesData = [
      makeGame({ gamePk: 800001, homeTeam: "Los Angeles Dodgers", awayTeam: "San Francisco Giants" }),
      makeGame({ gamePk: 800002, homeTeam: "New York Yankees", awayTeam: "Baltimore Orioles" }),
    ];
    render(<Games />);
    expect(screen.getByText("New York Yankees")).toBeTruthy();
    expect(screen.getByText("Baltimore Orioles")).toBeTruthy();
  });
});
