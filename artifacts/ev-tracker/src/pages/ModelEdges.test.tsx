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

const { createMutate, updateMutate, deleteMutate, restoreMutate, toastMock, tradesRef } = vi.hoisted(() => ({
  createMutate: vi.fn(),
  updateMutate: vi.fn(),
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
  useUpdatePaperTrade: () => ({ mutate: updateMutate, isPending: false }),
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

import { PaperTradesTable, ProjectionCard, EditPaperTradeDialog } from "./ModelEdges";
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
  updateMutate.mockReset();
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
describe("PaperTradesTable price correction", () => {
  it("opens the edit dialog from the row's pencil button and saves the corrected price", async () => {
    renderTable([makeTrade({ id: 201, americanOdds: -1100 })]);

    await user.click(screen.getByLabelText("Edit price for paper trade Gerrit Cole Over 6.5"));
    const input = await screen.findByLabelText("American odds");
    expect((input as HTMLInputElement).value).toBe("-1100");

    await user.clear(input);
    await user.type(input, "-110");
    await user.click(screen.getByRole("button", { name: /save price/i }));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0][0]).toEqual({ id: 201, data: { americanOdds: -110 } });
  });

  it("blocks impossible prices inside (-100, 100) with an inline error and no request", async () => {
    renderTable([makeTrade({ id: 202 })]);

    await user.click(screen.getByLabelText("Edit price for paper trade Gerrit Cole Over 6.5"));
    const input = await screen.findByLabelText("American odds");
    await user.clear(input);
    await user.type(input, "50");

    expect(updateMutate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/-100 or below, or \+100 and up/);
  });

  it("disables Save while the price is impossible and re-enables it when the user corrects the value", async () => {
    renderTable([makeTrade({ id: 203, americanOdds: -110 })]);

    await user.click(screen.getByLabelText("Edit price for paper trade Gerrit Cole Over 6.5"));
    const input = await screen.findByLabelText("American odds");

    // Type an impossible price — Save must become disabled.
    await user.clear(input);
    await user.type(input, "50");
    const saveBtn = screen.getByRole("button", { name: /save price/i });
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true);

    // Correct it to a valid price — Save must become enabled again.
    await user.clear(input);
    await user.type(input, "-110");
    expect((saveBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it("pressing Enter with an impossible price does not call the update mutation and keeps the inline error visible", async () => {
    renderTable([makeTrade({ id: 204, americanOdds: -110 })]);

    await user.click(screen.getByLabelText("Edit price for paper trade Gerrit Cole Over 6.5"));
    const input = await screen.findByLabelText("American odds");

    // Type an impossible price (inside the -100..+100 dead zone) then press Enter.
    await user.clear(input);
    await user.type(input, "50");
    await user.keyboard("{Enter}");

    // The early-return guard in save() must have fired — no mutation call.
    expect(updateMutate).not.toHaveBeenCalled();

    // The inline validation message must still be visible.
    expect(screen.getByRole("alert").textContent).toMatch(/-100 or below, or \+100 and up/);
  });

  it("pressing Enter with an empty price field does not call the update mutation and keeps the inline error visible", async () => {
    renderTable([makeTrade({ id: 205, americanOdds: -110 })]);

    await user.click(screen.getByLabelText("Edit price for paper trade Gerrit Cole Over 6.5"));
    const input = await screen.findByLabelText("American odds");

    // Clear the field entirely, leaving it blank, then press Enter.
    await user.clear(input);
    await user.keyboard("{Enter}");

    // An empty string is not a valid odds value — save() must bail before
    // calling the mutation.
    expect(updateMutate).not.toHaveBeenCalled();

    // The inline validation alert must remain visible.
    expect(screen.getByRole("alert").textContent).toMatch(/-100 or below, or \+100 and up/);
  });
});

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

  /**
   * The grace-window restore endpoint purges expired tombstones before
   * attempting the update, so an expired undo returns 404 with
   * { error: "This pick can no longer be restored." }.  The handler must
   * surface that body text rather than swallowing it silently.
   */
  it("surfaces the server error message when the grace window has expired (404)", async () => {
    restoreMutate.mockImplementation((_vars, opts) =>
      opts?.onError?.({ status: 404, data: { error: "This pick can no longer be restored." } }),
    );
    const action = await deleteAndGetUndoAction(107);

    action.props.onClick();

    const failureToast = toastMock.mock.calls.find(
      ([args]) => args?.title === "Could not undo",
    );
    expect(failureToast).toBeDefined();
    expect(failureToast![0].variant).toBe("destructive");
    // The server's body { error } must be forwarded verbatim — not swallowed.
    expect(failureToast![0].description).toBe("This pick can no longer be restored.");
  });

  it("falls back to the default message when the error body carries no text", async () => {
    // e.g. a network error or an unexpected server response with no body
    restoreMutate.mockImplementation((_vars, opts) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      opts?.onError?.({ status: 500, data: {} } as any),
    );
    const action = await deleteAndGetUndoAction(108);

    action.props.onClick();

    const failureToast = toastMock.mock.calls.find(
      ([args]) => args?.title === "Could not undo",
    );
    expect(failureToast).toBeDefined();
    expect(failureToast![0].variant).toBe("destructive");
    // No body → fallback must be shown so the toast is never blank.
    expect(failureToast![0].description).toBe("This pick can no longer be restored.");
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

/**
 * Locks in the client-side impossible-odds disabled state on the projections
 * card: scan results with corrupted prices like +50, -50, or 0 must render
 * with a visually-disabled, aria-disabled button whose accessible label
 * changes to "Cannot log — invalid odds …" so screen-reader users know why
 * the control is inert. The mutation must never fire, and no toast appears
 * (the disabled state is self-explanatory — no toast nag required).
 *
 * Valid boundary prices (-100, +100) must keep the normal "Log paper trade"
 * label, must NOT carry aria-disabled, and must fire the mutation on click.
 *
 * Complementary to artifacts/ev-mobile/__tests__/scorecard-log-odds-boundary.test.tsx
 * which covers the same rule on the phone.
 *
 * A refactor that removes the isValidAmericanOdds check from the button's
 * disabled prop should fail here.
 */
/**
 * Locks in the server-rejection path of EditPaperTradeDialog: when the PATCH
 * mutation comes back with a server error the dialog must stay open (so the
 * user can correct and retry), surface the error message, and never call
 * onSaved. If the onError handler is refactored to close the dialog or to
 * skip the toast, these tests will catch the regression.
 *
 * Mirrors the equivalent test on the mobile EditTradeSheet.
 */
describe("EditPaperTradeDialog server-rejection path", () => {
  function renderDialog(onOpenChange = vi.fn(), onSaved = vi.fn()) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <EditPaperTradeDialog
          trade={makeTrade({ id: 301, americanOdds: -110 })}
          open
          onOpenChange={onOpenChange}
          onSaved={onSaved}
        />
      </QueryClientProvider>,
    );
  }

  it("keeps the dialog open when the server rejects the corrected price", async () => {
    updateMutate.mockImplementation((_vars, opts) =>
      opts?.onError?.({ status: 400, data: { error: "Price is outside allowed range." } }),
    );
    const onOpenChange = vi.fn();
    renderDialog(onOpenChange);

    // Type a valid price and submit so the mutation fires.
    const input = screen.getByLabelText("American odds");
    await user.clear(input);
    await user.type(input, "-120");
    await user.click(screen.getByRole("button", { name: /save price/i }));

    // The dialog must remain open — onOpenChange(false) must not have been called.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("surfaces the server's error message in a destructive toast", async () => {
    updateMutate.mockImplementation((_vars, opts) =>
      opts?.onError?.({ status: 400, data: { error: "Price is outside allowed range." } }),
    );
    renderDialog();

    const input = screen.getByLabelText("American odds");
    await user.clear(input);
    await user.type(input, "-120");
    await user.click(screen.getByRole("button", { name: /save price/i }));

    const errorToast = toastMock.mock.calls.find(
      ([args]) => args?.title === "Failed to correct price",
    );
    expect(errorToast).toBeDefined();
    expect(errorToast![0].variant).toBe("destructive");
    expect(errorToast![0].description).toBe("Price is outside allowed range.");
  });

  it("does not call onSaved when the server rejects the price", async () => {
    updateMutate.mockImplementation((_vars, opts) =>
      opts?.onError?.({ status: 400, data: { error: "Price is outside allowed range." } }),
    );
    const onSaved = vi.fn();
    renderDialog(vi.fn(), onSaved);

    const input = screen.getByLabelText("American odds");
    await user.clear(input);
    await user.type(input, "-120");
    await user.click(screen.getByRole("button", { name: /save price/i }));

    expect(onSaved).not.toHaveBeenCalled();
  });

  it("falls back to 'An unknown error occurred.' when the server gives no message", async () => {
    updateMutate.mockImplementation((_vars, opts) =>
      opts?.onError?.({ status: 500, data: {} }),
    );
    renderDialog();

    const input = screen.getByLabelText("American odds");
    await user.clear(input);
    await user.type(input, "-120");
    await user.click(screen.getByRole("button", { name: /save price/i }));

    const errorToast = toastMock.mock.calls.find(
      ([args]) => args?.title === "Failed to correct price",
    );
    expect(errorToast).toBeDefined();
    expect(errorToast![0].description).toBe("An unknown error occurred.");
  });

  it("falls back to 'An unknown error occurred.' when onError receives a bare empty object", async () => {
    updateMutate.mockImplementation((_vars, opts) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      opts?.onError?.({} as any),
    );
    const onOpenChange = vi.fn();
    const onSaved = vi.fn();
    renderDialog(onOpenChange, onSaved);

    const input = screen.getByLabelText("American odds");
    await user.clear(input);
    await user.type(input, "-120");
    await user.click(screen.getByRole("button", { name: /save price/i }));

    const errorToast = toastMock.mock.calls.find(
      ([args]) => args?.title === "Failed to correct price",
    );
    expect(errorToast).toBeDefined();
    expect(errorToast![0].description).toBe("An unknown error occurred.");
    expect(onSaved).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("falls back to 'An unknown error occurred.' when onError receives null", async () => {
    updateMutate.mockImplementation((_vars, opts) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      opts?.onError?.(null as any),
    );
    const onOpenChange = vi.fn();
    const onSaved = vi.fn();
    renderDialog(onOpenChange, onSaved);

    const input = screen.getByLabelText("American odds");
    await user.clear(input);
    await user.type(input, "-120");
    await user.click(screen.getByRole("button", { name: /save price/i }));

    const errorToast = toastMock.mock.calls.find(
      ([args]) => args?.title === "Failed to correct price",
    );
    expect(errorToast).toBeDefined();
    expect(errorToast![0].description).toBe("An unknown error occurred.");
    expect(onSaved).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

/**
 * Locks in the two-key invalidation contract on the web PaperTradesTable
 * restore (UNDO) happy-path. After a successful restore, both
 * ['paper-trades'] and ['paper-trade-summary'] must be passed to
 * invalidateQueries so the trades list and the summary tile both refresh.
 *
 * Mirrors artifacts/ev-mobile/__tests__/scorecard-undo-delete.test.tsx
 * ("tapping UNDO fires the restore mutation for that pick and re-invalidates
 * the queries") — both must assert the same two-key invalidation contract so
 * a refactor that drops one call fails in both screens, not just one.
 */
describe("PaperTradesTable restore happy-path invalidates both queries", () => {
  afterEach(() => {
    deleteMutate.mockReset();
    restoreMutate.mockReset();
  });

  it("successful UNDO invalidates both paper-trades and paper-trade-summary", async () => {
    deleteMutate.mockImplementation((_vars: unknown, opts?: { onSuccess?: () => void }) =>
      opts?.onSuccess?.(),
    );
    restoreMutate.mockImplementation((_vars: unknown, opts?: { onSuccess?: () => void }) =>
      opts?.onSuccess?.(),
    );

    tradesRef.current = [makeTrade({ id: 300, status: "open" })];
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    render(
      <QueryClientProvider client={queryClient}>
        <PaperTradesTable />
      </QueryClientProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: /delete paper trade gerrit cole over 6\.5/i }),
    );

    // Delete succeeded → toast with Undo action.
    const deleteToast = toastMock.mock.calls.find(([args]) => args?.title === "Paper trade deleted");
    expect(deleteToast).toBeDefined();

    // Clear spy to isolate the restore-phase invalidations from the delete-phase ones.
    invalidateSpy.mockClear();

    const action = deleteToast![0].action as ReactElement<{ onClick: () => void }>;
    action.props.onClick();

    // Restore succeeded → both queries must be re-invalidated.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["paper-trades"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["paper-trade-summary"] });
  });
});

/**
 * Locks in the two-key invalidation contract on the web PaperTradesTable
 * delete happy-path. After a successful delete on an open trade, both
 * ['paper-trades'] and ['paper-trade-summary'] must be passed to
 * invalidateQueries so the trades list and the summary tile both refresh.
 *
 * Paired with the restore-phase equivalent above
 * ("PaperTradesTable restore happy-path invalidates both queries") — a
 * refactor that removes the invalidate() call from remove() should fail here
 * while leaving the restore test green, making the regression immediately
 * visible.
 *
 * Mirrors artifacts/ev-mobile/__tests__/scorecard-undo-delete.test.tsx
 * ("shows the success banner with an UNDO action after deleting a pick")
 * which asserts the same two-key contract on the phone.
 */
describe("PaperTradesTable delete happy-path invalidates both queries", () => {
  afterEach(() => {
    deleteMutate.mockReset();
  });

  it("successful delete invalidates both paper-trades and paper-trade-summary", async () => {
    deleteMutate.mockImplementation((_vars: unknown, opts?: { onSuccess?: () => void }) =>
      opts?.onSuccess?.(),
    );

    tradesRef.current = [makeTrade({ id: 400, status: "open" })];
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    render(
      <QueryClientProvider client={queryClient}>
        <PaperTradesTable />
      </QueryClientProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: /delete paper trade gerrit cole over 6\.5/i }),
    );

    // Delete succeeded → both queries must be invalidated.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["paper-trades"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["paper-trade-summary"] });
  });
});

/**
 * Locks in the two-key invalidation contract on ProjectionCard's logTrade
 * happy-path. After a successful create call, both ['paper-trades'] and
 * ['paper-trade-summary'] must be passed to invalidateQueries so the trades
 * list and the summary tile both refresh.
 *
 * Mirrors the delete and restore invalidation tests above — a refactor that
 * drops either invalidateQueries call from logTrade's onSuccess should fail
 * here while leaving the delete/restore tests green, making the regression
 * immediately visible.
 */
describe("ProjectionCard log-trade happy-path invalidates both queries", () => {
  afterEach(() => {
    createMutate.mockReset();
  });

  it("successful logTrade invalidates both paper-trades and paper-trade-summary", async () => {
    createMutate.mockImplementation((_vars: unknown, opts?: { onSuccess?: () => void }) =>
      opts?.onSuccess?.(),
    );

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const projection: ModelPitcherProjection = {
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

    render(
      <QueryClientProvider client={queryClient}>
        <ProjectionCard projection={projection} />
      </QueryClientProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: /log paper trade gerrit cole over 6\.5/i }),
    );

    // Successful create → both queries must be invalidated.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["paper-trades"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["paper-trade-summary"] });
  });
});

describe("ProjectionCard impossible-odds disabled state", () => {
  function makeProjectionWithOdds(americanOdds: number): ModelPitcherProjection {
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
          americanOdds,
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

  function renderCardWithOdds(americanOdds: number) {
    const queryClient = new QueryClient();
    return render(
      <QueryClientProvider client={queryClient}>
        <ProjectionCard projection={makeProjectionWithOdds(americanOdds)} />
      </QueryClientProvider>,
    );
  }

  // Partial text the disabled button's accessible label begins with — must
  // match the aria-label set on the Button when !isValidAmericanOdds.
  const DISABLED_LABEL_PREFIX = /cannot log/i;

  describe("impossible prices render a disabled, inaccessible button", () => {
    it.each([0, 50, -50])(
      "hides the normal 'Log paper trade' label for odds %s",
      (americanOdds) => {
        renderCardWithOdds(americanOdds);

        expect(
          screen.queryByRole("button", { name: /log paper trade gerrit cole/i }),
        ).toBeNull();
      },
    );

    it.each([0, 50, -50])(
      "renders a 'Cannot log' button instead for odds %s",
      (americanOdds) => {
        renderCardWithOdds(americanOdds);

        const btn = screen.getByRole("button", { name: DISABLED_LABEL_PREFIX });
        expect(btn).toBeDefined();
      },
    );

    it.each([0, 50, -50])(
      "marks the button disabled (HTML disabled attribute) for odds %s",
      (americanOdds) => {
        renderCardWithOdds(americanOdds);

        const btn = screen.getByRole("button", { name: DISABLED_LABEL_PREFIX });
        // The shadcn Button sets the native disabled attribute, which also
        // maps to aria-disabled in the accessibility tree.
        expect((btn as HTMLButtonElement).disabled).toBe(true);
      },
    );

    it.each([0, 50, -50])(
      "never fires the create mutation for odds %s",
      (americanOdds) => {
        renderCardWithOdds(americanOdds);

        // The button is natively disabled so user-event will not dispatch a
        // click event; confirm directly that the mock was not called.
        expect(createMutate).not.toHaveBeenCalled();
      },
    );

    it.each([0, 50, -50])(
      "never shows the 'Invalid odds' toast for odds %s (button is inert, not a click-time guard)",
      (americanOdds) => {
        renderCardWithOdds(americanOdds);

        expect(
          toastMock.mock.calls.some(([args]) => args?.title === "Invalid odds"),
        ).toBe(false);
      },
    );
  });

  describe("valid boundary prices keep the button enabled and fire the mutation", () => {
    it.each([-100, 100])(
      "shows the normal 'Log paper trade' label for boundary odds %s",
      (americanOdds) => {
        renderCardWithOdds(americanOdds);

        expect(
          screen.getByRole("button", { name: /log paper trade gerrit cole over 6\.5/i }),
        ).toBeDefined();
      },
    );

    it.each([-100, 100])(
      "button is not disabled for boundary odds %s",
      (americanOdds) => {
        renderCardWithOdds(americanOdds);

        const btn = screen.getByRole("button", {
          name: /log paper trade gerrit cole over 6\.5/i,
        }) as HTMLButtonElement;
        expect(btn.disabled).toBe(false);
      },
    );

    it.each([-100, 100])(
      "fires the mutation when boundary odds %s button is clicked",
      async (americanOdds) => {
        renderCardWithOdds(americanOdds);

        await user.click(
          screen.getByRole("button", { name: /log paper trade gerrit cole over 6\.5/i }),
        );

        expect(createMutate).toHaveBeenCalledTimes(1);
        expect(
          toastMock.mock.calls.some(([args]) => args?.title === "Invalid odds"),
        ).toBe(false);
      },
    );

    it("fires the mutation for a canonical valid price -110", async () => {
      renderCardWithOdds(-110);

      await user.click(
        screen.getByRole("button", { name: /log paper trade gerrit cole over 6\.5/i }),
      );

      expect(createMutate).toHaveBeenCalledTimes(1);
    });
  });
});
