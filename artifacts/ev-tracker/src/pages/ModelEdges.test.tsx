// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { PaperTrade } from "@workspace/api-client-react";

/**
 * Locks in the graded-delete guard on the paper-trades table: deleting a
 * closed (graded) pick rewrites the model's validation stats (beat-close
 * rate, avg CLV), so it must go through a blocking confirm dialog, while
 * open/expired picks delete immediately (they have the undo toast instead).
 * A refactor that drops the status check should fail here.
 */

const { createMutate, deleteMutate, restoreMutate, toastMock, tradesRef } = vi.hoisted(() => ({
  createMutate: vi.fn(),
  deleteMutate: vi.fn(),
  restoreMutate: vi.fn(),
  toastMock: vi.fn(),
  tradesRef: { current: [] as unknown[] },
}));

vi.mock("@workspace/api-client-react", () => ({
  useListPaperTrades: () => ({ data: tradesRef.current, isLoading: false }),
  useDeletePaperTrade: () => ({ mutate: deleteMutate, isPending: false }),
  useRestorePaperTrade: () => ({ mutate: restoreMutate, isPending: false }),
  useCreatePaperTrade: () => ({ mutate: createMutate, isPending: false }),
  useGetPaperTradeSummary: () => ({ data: undefined }),
  useListEvents: () => ({ data: [], isLoading: false, isError: false }),
  useListModelEdges: () => ({ data: undefined, isLoading: false, isFetching: false, isError: false }),
  getListEventsQueryKey: () => ["events"],
  getListModelEdgesQueryKey: () => ["model-edges"],
  getListPaperTradesQueryKey: () => ["paper-trades"],
  getGetPaperTradeSummaryQueryKey: () => ["paper-trade-summary"],
}));

// The toast render pipeline is exercised elsewhere; here we capture the
// toast() payloads so the undo tests can pull the ToastAction element out of
// the delete toast and drive its onClick directly.
vi.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

// ModelPerformance pulls in charting; irrelevant to the delete guard.
vi.mock("@/components/ModelPerformance", () => ({ default: () => null }));

import { PaperTradesTable, ProjectionCard } from "./ModelEdges";
import type { ModelPitcherProjection } from "@workspace/api-client-react";

function makeTrade(overrides: Partial<PaperTrade>): PaperTrade {
  return {
    id: 1,
    sport: "baseball_mlb",
    gameId: "g1",
    commenceTime: "2026-07-14T23:10:00Z",
    homeTeam: "NYY",
    awayTeam: "BOS",
    pitcher: "Gerrit Cole",
    team: "NYY",
    opponent: "BOS",
    selection: "Over",
    point: 6.5,
    book: "fanduel",
    americanOdds: -110,
    modelProb: 0.58,
    marketProb: 0.52,
    edgePercent: 6,
    isFlagged: true,
    expectedStrikeouts: 7.1,
    projectedBattersFaced: 24,
    recommendedUnits: 1,
    kellyMultiplier: 0.25,
    status: "open",
    closingOdds: null,
    clvPercent: null,
    createdAt: "2026-07-14T15:00:00Z",
    ...overrides,
  } as PaperTrade;
}

function renderTable(trades: PaperTrade[]) {
  tradesRef.current = trades;
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <PaperTradesTable />
    </QueryClientProvider>,
  );
}

// Radix sets pointer-events:none on the body behind an open dialog, which
// trips user-event's default pointer check in jsdom.
const user = userEvent.setup({ pointerEventsCheck: 0 });

beforeEach(() => {
  createMutate.mockReset();
  deleteMutate.mockClear();
  restoreMutate.mockClear();
  toastMock.mockClear();
});

// No vitest globals, so testing-library's auto-cleanup never registers —
// unmount explicitly or renders leak across tests.
afterEach(cleanup);

describe("PaperTradesTable graded-delete guard", () => {
  it("opens the confirm dialog for a closed (graded) trade without deleting", async () => {
    renderTable([
      makeTrade({ id: 101, status: "closed", closingOdds: -125, clvPercent: 3.1 }),
    ]);

    await user.click(
      screen.getByRole("button", { name: /delete paper trade gerrit cole over 6\.5/i }),
    );

    expect(screen.getByText("Delete a graded pick?")).toBeDefined();
    expect(deleteMutate).not.toHaveBeenCalled();
  });

  it("deletes the closed trade only after confirming in the dialog", async () => {
    renderTable([
      makeTrade({ id: 101, status: "closed", closingOdds: -125, clvPercent: 3.1 }),
    ]);

    await user.click(
      screen.getByRole("button", { name: /delete paper trade gerrit cole over 6\.5/i }),
    );
    await user.click(screen.getByRole("button", { name: /delete graded pick/i }));

    expect(deleteMutate).toHaveBeenCalledTimes(1);
    expect(deleteMutate.mock.calls[0][0]).toEqual({ id: 101 });
  });

  it("keeps the pick when the dialog is cancelled", async () => {
    renderTable([
      makeTrade({ id: 101, status: "closed", closingOdds: -125, clvPercent: 3.1 }),
    ]);

    await user.click(
      screen.getByRole("button", { name: /delete paper trade gerrit cole over 6\.5/i }),
    );
    await user.click(screen.getByRole("button", { name: /keep pick/i }));

    expect(deleteMutate).not.toHaveBeenCalled();
  });

  it("deletes an open trade immediately with no dialog", async () => {
    renderTable([makeTrade({ id: 102, status: "open" })]);

    await user.click(
      screen.getByRole("button", { name: /delete paper trade gerrit cole over 6\.5/i }),
    );

    expect(deleteMutate).toHaveBeenCalledTimes(1);
    expect(deleteMutate.mock.calls[0][0]).toEqual({ id: 102 });
    expect(screen.queryByText("Delete a graded pick?")).toBeNull();
  });

  it("deletes an expired trade immediately with no dialog", async () => {
    renderTable([makeTrade({ id: 103, status: "expired" })]);

    await user.click(
      screen.getByRole("button", { name: /delete paper trade gerrit cole over 6\.5/i }),
    );

    expect(deleteMutate).toHaveBeenCalledTimes(1);
    expect(deleteMutate.mock.calls[0][0]).toEqual({ id: 103 });
    expect(screen.queryByText("Delete a graded pick?")).toBeNull();
  });
});

/**
 * Locks in the delete → Undo flow: the toast shown after a successful delete
 * carries an Undo action that must call the restore endpoint with the deleted
 * pick's id, and a failed restore must surface the destructive "Could not
 * undo" feedback. A refactor of the toast action wiring should fail here.
 */
describe("PaperTradesTable delete undo", () => {
  // Drive the delete for trade `id` and return the Undo ToastAction element
  // captured from the success toast.
  async function deleteAndGetUndoAction(id: number) {
    // The component only shows the undo toast from the delete mutation's
    // onSuccess callback — simulate a successful server delete.
    deleteMutate.mockImplementation((_vars, opts) => opts?.onSuccess?.());

    renderTable([makeTrade({ id, status: "open" })]);
    await user.click(
      screen.getByRole("button", { name: /delete paper trade gerrit cole over 6\.5/i }),
    );

    const deleteToast = toastMock.mock.calls.find(
      ([args]) => args?.title === "Paper trade deleted",
    );
    expect(deleteToast).toBeDefined();
    const action = deleteToast![0].action as ReactElement<{ onClick: () => void }>;
    expect(action).toBeDefined();
    return action;
  }

  afterEach(() => {
    deleteMutate.mockReset();
    restoreMutate.mockReset();
  });

  it("toast Undo calls the restore mutation with the deleted pick's id", async () => {
    const action = await deleteAndGetUndoAction(104);

    // Fire the Undo action the way the toast button would.
    action.props.onClick();

    expect(restoreMutate).toHaveBeenCalledTimes(1);
    expect(restoreMutate.mock.calls[0][0]).toEqual({ id: 104 });
  });

  it("shows the restored toast when the restore succeeds", async () => {
    restoreMutate.mockImplementation((_vars, opts) => opts?.onSuccess?.());
    const action = await deleteAndGetUndoAction(105);

    action.props.onClick();

    const restoredToast = toastMock.mock.calls.find(
      ([args]) => args?.title === "Paper trade restored",
    );
    expect(restoredToast).toBeDefined();
  });

  it("shows destructive 'Could not undo' feedback when the restore fails", async () => {
    restoreMutate.mockImplementation((_vars, opts) =>
      opts?.onError?.({ status: 410, data: { error: "Restore window has passed." } }),
    );
    const action = await deleteAndGetUndoAction(106);

    action.props.onClick();

    const failureToast = toastMock.mock.calls.find(
      ([args]) => args?.title === "Could not undo",
    );
    expect(failureToast).toBeDefined();
    expect(failureToast![0].variant).toBe("destructive");
    expect(failureToast![0].description).toBe("Restore window has passed.");
  });
});

/**
 * Locks in the duplicate-log framing on the projections card: logging a pick
 * that's already in the scorecard comes back as a 409 from the server, and
 * the toast must present that as neutral information ("Already logged",
 * default variant) — not the destructive red failure toast reserved for real
 * errors. A refactor of logTrade's onError that drops the 409 branch should
 * fail here.
 */
describe("ProjectionCard duplicate-log toast", () => {
  function makeProjection(): ModelPitcherProjection {
    return {
      gameId: "g1",
      sport: "baseball_mlb",
      commenceTime: "2026-07-14T23:10:00Z",
      homeTeam: "NYY",
      awayTeam: "BOS",
      pitcher: "Gerrit Cole",
      team: "NYY",
      opponent: "BOS",
      throws: "R",
      projectedBattersFaced: 24,
      expectedStrikeouts: 7.1,
      ratePerBF: 0.29,
      opponentFactor: 1.02,
      sampleStarts: 12,
      sampleBattersFaced: 290,
      opponentDataAvailable: true,
      insufficientData: false,
      lines: [
        {
          point: 6.5,
          selection: "Over",
          americanOdds: -110,
          book: "fanduel",
          marketProb: 0.52,
          modelProb: 0.58,
          edgePercent: 6,
          fullKellyFraction: 0.12,
          recommendedUnits: 1,
          isFlagged: true,
        },
      ],
    } as unknown as ModelPitcherProjection;
  }

  function renderCard() {
    const queryClient = new QueryClient();
    return render(
      <QueryClientProvider client={queryClient}>
        <ProjectionCard projection={makeProjection()} />
      </QueryClientProvider>,
    );
  }

  // Each line's log button carries an accessible name naming the exact pick,
  // so the test queries by it instead of guessing by position.
  async function clickLogButton() {
    await user.click(
      screen.getByRole("button", { name: /log paper trade gerrit cole over 6\.5/i }),
    );
  }

  it("shows a neutral 'Already logged' toast on a 409 duplicate", async () => {
    createMutate.mockImplementation((_vars, opts) =>
      opts?.onError?.({ status: 409, data: { error: "This pick is already in the scorecard." } }),
    );
    renderCard();

    await clickLogButton();

    expect(createMutate).toHaveBeenCalledTimes(1);
    const duplicateToast = toastMock.mock.calls.find(
      ([args]) => args?.title === "Already logged",
    );
    expect(duplicateToast).toBeDefined();
    expect(duplicateToast![0].variant).toBe("default");
    expect(duplicateToast![0].description).toBe("This pick is already in the scorecard.");
  });

  it("still shows the destructive failure toast for a non-409 error", async () => {
    createMutate.mockImplementation((_vars, opts) =>
      opts?.onError?.({ status: 500, data: { error: "Database unavailable." } }),
    );
    renderCard();

    await clickLogButton();

    const failureToast = toastMock.mock.calls.find(
      ([args]) => args?.title === "Failed to log paper trade",
    );
    expect(failureToast).toBeDefined();
    expect(failureToast![0].variant).toBe("destructive");
    expect(failureToast![0].description).toBe("Database unavailable.");
    expect(toastMock.mock.calls.some(([args]) => args?.title === "Already logged")).toBe(false);
  });
});
