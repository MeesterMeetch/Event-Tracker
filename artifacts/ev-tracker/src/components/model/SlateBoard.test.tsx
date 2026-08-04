// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Guards the two things this board must not get wrong.
 *
 * It must not scan on mount, because every game is a billed request.
 *
 * And it must not present an unvalidated model as a set of plays. The stake
 * sizes it can render are Kelly fractions of probabilities that have never been
 * checked against a result, so they stay hidden until the calibration state
 * says otherwise. A number that looks like a bet size is the most harmful thing
 * this screen could show.
 */

const { refetchMock, stateRef, paramsRef } = vi.hoisted(() => ({
  refetchMock: vi.fn(),
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
  useListModelSlate: (params?: Record<string, string>) => {
    paramsRef.current = params;
    return { ...stateRef.current, refetch: refetchMock };
  },
  getListModelSlateQueryKey: () => ["model-slate"],
}));

import SlateBoard from "./SlateBoard";

function play(over: Record<string, unknown> = {}) {
  return {
    gameId: "g1",
    commenceTime: "2026-08-05T23:05:00Z",
    homeTeam: "Los Angeles Dodgers",
    awayTeam: "San Francisco Giants",
    pitcher: "Blake Snell",
    team: "Los Angeles Dodgers",
    opponent: "San Francisco Giants",
    expectedStrikeouts: 6.1,
    sampleStarts: 10,
    degradedInputs: false,
    point: 5.5,
    selection: "Over",
    americanOdds: -110,
    book: "DraftKings",
    modelProb: 0.62,
    marketProb: 0.5,
    edgePercent: 18.3,
    recommendedUnits: 1.25,
    isFlagged: true,
    rank: 1,
    ...over,
  };
}

function response(over: Record<string, unknown> = {}) {
  return {
    plays: [play()],
    calibration: {
      gradedTrades: 0,
      plattFitted: false,
      blendWeight: 1,
      isCalibrated: false,
      minGradedForCalibration: 30,
      minGradedForBlendWeight: 50,
    },
    summary: {
      eventsScanned: 15,
      linesMeasured: 54,
      pitchersProjected: 25,
      flagged: 54,
      insufficientData: 0,
      interpretation: "54 of 54 lines clear the edge threshold.",
    },
    eventsFailed: [],
    windowStart: "2026-08-05T14:00:00Z",
    windowEnd: "2026-08-06T06:00:00Z",
    scannedAt: "2026-08-05T14:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  stateRef.current = { data: undefined, isFetching: false, isError: false, error: undefined };
  refetchMock.mockReset();
  refetchMock.mockResolvedValue(undefined);
  paramsRef.current = undefined;
});

afterEach(cleanup);

describe("SlateBoard", () => {
  it("does not scan until asked, because every game is billed", async () => {
    render(<SlateBoard />);
    expect(refetchMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId("button-scan-slate"));
    expect(refetchMock).toHaveBeenCalledTimes(1);
  });

  it("bounds the scan at a local midnight rather than a rolling day", async () => {
    render(<SlateBoard />);
    await userEvent.click(screen.getByTestId("button-scan-slate"));

    const end = new Date(paramsRef.current!.endTime);
    expect(end.getHours()).toBe(0);
    expect(end.getMinutes()).toBe(0);
    expect(Number(paramsRef.current!.minEdgePercent)).toBeLessThan(0);
  });

  it("says the model has never been checked, and counts down to when it will be", () => {
    stateRef.current.data = response();
    render(<SlateBoard />);

    expect(screen.getByTestId("text-uncalibrated")).toBeTruthy();
    expect(screen.getByText(/0 of 30 graded predictions/i)).toBeTruthy();
    // blendWeight of 1 is the reason it can disagree with everything.
    expect(screen.getByText(/unblended with the market/i)).toBeTruthy();
  });

  it("hides stake sizes while the model is unvalidated", () => {
    stateRef.current.data = response();
    render(<SlateBoard />);

    expect(screen.getByTestId("list-slate-plays")).toBeTruthy();
    expect(screen.queryByText(/1\.25u/)).toBeNull();
  });

  it("shows stake sizes once calibration is actually in effect", () => {
    stateRef.current.data = response({
      calibration: {
        gradedTrades: 140,
        plattFitted: true,
        blendWeight: 0.6,
        isCalibrated: true,
        minGradedForCalibration: 30,
        minGradedForBlendWeight: 50,
      },
    });
    render(<SlateBoard />);

    expect(screen.queryByTestId("text-uncalibrated")).toBeNull();
    expect(screen.getByText(/1\.25u/)).toBeTruthy();
  });

  it("marks a thin sample rather than letting a big edge hide it", () => {
    stateRef.current.data = response({
      plays: [play({ sampleStarts: 3, rank: 1 })],
    });
    render(<SlateBoard />);
    expect(screen.getByTestId("badge-sample-1").textContent).toMatch(/3 starts/);
  });

  it("says a partial board is partial rather than quiet", () => {
    stateRef.current.data = response({
      eventsFailed: [{ eventId: "g9", reason: "upstream 500" }],
    });
    render(<SlateBoard />);
    expect(screen.getByText(/failed to scan/i)).toBeTruthy();
  });
});
