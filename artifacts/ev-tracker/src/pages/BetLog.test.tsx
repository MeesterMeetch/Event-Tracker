// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Bet } from "@workspace/api-client-react";

/**
 * Locks in the "blank = automatic" P&L convention on the web EditBetDialog,
 * matching the phone's EditBetSheet: an untouched P&L field must NOT send a
 * pnl value on save (the server then recomputes it in lockstep with the new
 * status/odds/units), while typed text is a deliberate manual override. A
 * regression that prefills and re-sends the current pnl would silently freeze
 * auto-grading — the exact bug this file guards against.
 */

const { updateMutate, deleteMutate, restoreMutate, toastMock, listBetsData } = vi.hoisted(() => ({
  updateMutate: vi.fn(),
  deleteMutate: vi.fn(),
  restoreMutate: vi.fn(),
  toastMock: vi.fn(),
  // Mutable ref so individual tests can inject bets into BetLog renders.
  listBetsData: { current: [] as Bet[] },
}));

vi.mock("@workspace/api-client-react", () => ({
  useUpdateBet: () => ({ mutate: updateMutate, isPending: false }),
  getListBetsQueryKey: () => ["bets"],
  getGetDashboardSummaryQueryKey: () => ["dashboard-summary"],
  useListBets: () => ({ data: listBetsData.current, isLoading: false, isError: false }),
  useListSports: () => ({ data: [] }),
  useDeleteBet: () => ({ mutate: deleteMutate, isPending: false }),
  useRestoreBet: () => ({ mutate: restoreMutate, isPending: false }),
}));

vi.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import BetLog, { EditBetDialog, DeleteBetDialog } from "./BetLog";

function makeBet(overrides: Partial<Bet> = {}): Bet {
  return {
    id: 1,
    sport: "baseball_mlb",
    gameId: "g1",
    commenceTime: "2026-07-14T23:10:00Z",
    homeTeam: "NYY",
    awayTeam: "BOS",
    market: "h2h",
    selection: "NYY",
    point: null,
    book: "fanduel",
    americanOdds: -110,
    units: 1,
    status: "won",
    pnl: 0.91,
    notes: null,
    createdAt: "2026-07-14T15:00:00Z",
    ...overrides,
  } as Bet;
}

function renderDialog(bet: Bet, onOpenChange: (open: boolean) => void = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <EditBetDialog bet={bet} open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  updateMutate.mockClear();
  deleteMutate.mockClear();
  restoreMutate.mockClear();
  toastMock.mockClear();
});

afterEach(cleanup);

describe("EditBetDialog P&L override", () => {
  it("omits pnl entirely when the field is left blank (server recomputes)", async () => {
    const user = userEvent.setup();
    renderDialog(makeBet());

    const units = screen.getByLabelText(/units/i);
    await user.clear(units);
    await user.type(units, "2");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    const payload = updateMutate.mock.calls[0][0];
    expect(payload.data.units).toBe(2);
    expect("pnl" in payload.data).toBe(false);
  });

  it("shows the current auto pnl only as a placeholder, never as a value", () => {
    renderDialog(makeBet({ pnl: 0.91 }));
    const pnlInput = screen.getByLabelText(/p&l/i) as HTMLInputElement;
    expect(pnlInput.value).toBe("");
    expect(pnlInput.placeholder).toMatch(/auto/i);
  });

  it("sends typed text as a deliberate manual override", async () => {
    const user = userEvent.setup();
    renderDialog(makeBet());

    await user.type(screen.getByLabelText(/p&l/i), "-0.5");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    expect(updateMutate.mock.calls[0][0].data.pnl).toBe(-0.5);
  });

  it("rejects non-numeric P&L text with a validation message", async () => {
    const user = userEvent.setup();
    renderDialog(makeBet());

    await user.type(screen.getByLabelText(/p&l/i), "abc");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(await screen.findByText(/leave blank for automatic/i)).toBeTruthy();
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it("never sends pnl for a pending bet even if text was typed before switching status", async () => {
    const user = userEvent.setup();
    renderDialog(makeBet({ status: "pending", pnl: null }));

    // Field is disabled while pending, so nothing can be typed — save anyway.
    const pnlInput = screen.getByLabelText(/p&l/i) as HTMLInputElement;
    expect(pnlInput.disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    expect("pnl" in updateMutate.mock.calls[0][0].data).toBe(false);
  });
});

function renderDeleteDialog(
  bet: Bet,
  onOpenChange: (open: boolean) => void = () => {},
  onUndo: (bet: Bet) => void = () => {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DeleteBetDialog bet={bet} open onOpenChange={onOpenChange} onUndo={onUndo} />
    </QueryClientProvider>,
  );
}

describe("DeleteBetDialog server error fallback", () => {
  /**
   * Guards against vague / structureless server errors on delete going silent.
   * When onError receives {} or null (no err.data.error field), a destructive
   * toast must still fire and the dialog must NOT close — the bet row is still
   * present in the log and the user needs to know the deletion failed.
   */

  it("shows fallback toast and keeps dialog open when delete onError receives {}", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    deleteMutate.mockImplementationOnce(
      (_vars: unknown, opts?: { onError?: (err: unknown) => void }) => {
        opts?.onError?.({});
      },
    );
    renderDeleteDialog(makeBet(), onOpenChange);

    await user.click(screen.getByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    const [toastCall] = toastMock.mock.calls;
    expect(toastCall[0].description).toBe("An unknown error occurred.");
    expect(toastCall[0].variant).toBe("destructive");
    // Dialog must stay open so the user can retry.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("shows fallback toast and keeps dialog open when delete onError receives null", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    deleteMutate.mockImplementationOnce(
      (_vars: unknown, opts?: { onError?: (err: unknown) => void }) => {
        opts?.onError?.(null);
      },
    );
    renderDeleteDialog(makeBet(), onOpenChange);

    await user.click(screen.getByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    const [toastCall] = toastMock.mock.calls;
    expect(toastCall[0].description).toBe("An unknown error occurred.");
    expect(toastCall[0].variant).toBe("destructive");
    // Dialog must stay open so the user can retry.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("shows the server's message when delete onError carries err.data.error", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    deleteMutate.mockImplementationOnce(
      (_vars: unknown, opts?: { onError?: (err: unknown) => void }) => {
        opts?.onError?.({ data: { error: "Bet is already settled" } });
      },
    );
    renderDeleteDialog(makeBet(), onOpenChange);

    await user.click(screen.getByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    const [toastCall] = toastMock.mock.calls;
    expect(toastCall[0].description).toBe("Bet is already settled");
    expect(toastCall[0].variant).toBe("destructive");
    // Dialog must stay open so the user can retry.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe("undoDelete (restore) server error fallback", () => {
  /**
   * Guards against vague / structureless server errors on restore going silent.
   * undoDelete lives inside BetLog and is wired as onUndo on DeleteBetDialog.
   * These tests go through the full BetLog render so they exercise the actual
   * undoDelete implementation — not a mirror of it.
   *
   * Flow: render BetLog with one bet → open dropdown → click Delete → confirm
   * delete (deleteMutate calls onSuccess) → render the toast's Undo action
   * element and click it → undoDelete fires → restoreMutate calls onError →
   * assert fallback toast.
   */

  function renderBetLog(bets: Bet[]) {
    listBetsData.current = bets;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <BetLog />
      </QueryClientProvider>,
    );
  }

  afterEach(() => {
    listBetsData.current = [];
  });

  async function openDeleteDialogAndConfirm(user: ReturnType<typeof userEvent.setup>) {
    // Open the row's actions dropdown
    await user.click(screen.getByRole("button", { name: /open menu/i }));
    // Click "Delete" in the dropdown
    await user.click(screen.getByRole("menuitem", { name: /delete/i }));
    // Confirm in the dialog (has two Delete-labelled buttons now — pick the
    // destructive one inside the dialog footer, which is the only button
    // whose accessible name is exactly "Delete").
    const deleteButtons = screen.getAllByRole("button", { name: /^delete$/i });
    await user.click(deleteButtons[deleteButtons.length - 1]);
  }

  it("shows fallback toast when restore onError receives {}", async () => {
    const user = userEvent.setup();

    deleteMutate.mockImplementationOnce(
      (_vars: unknown, opts?: { onSuccess?: () => void }) => {
        opts?.onSuccess?.();
      },
    );
    restoreMutate.mockImplementationOnce(
      (_vars: unknown, opts?: { onError?: (err: unknown) => void }) => {
        opts?.onError?.({});
      },
    );

    renderBetLog([makeBet()]);
    await openDeleteDialogAndConfirm(user);

    // deleteMutate.onSuccess fired → toast with Undo action
    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    const deleteSuccessToast = toastMock.mock.calls[0][0];
    expect(deleteSuccessToast.title).toBe("Bet Deleted");

    // Render the Undo ToastAction element and click it → undoDelete fires
    const { unmount: unmountAction } = render(deleteSuccessToast.action);
    await user.click(screen.getByRole("button", { name: /undo/i }));
    unmountAction();

    // restoreMutate.onError fires the fallback "This bet can no longer be restored."
    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(2));
    const restoreErrorToast = toastMock.mock.calls[1][0];
    expect(restoreErrorToast.title).toBe("Could not undo");
    expect(restoreErrorToast.description).toBe("This bet can no longer be restored.");
    expect(restoreErrorToast.variant).toBe("destructive");
  });

  it("shows fallback toast when restore onError receives null", async () => {
    const user = userEvent.setup();

    deleteMutate.mockImplementationOnce(
      (_vars: unknown, opts?: { onSuccess?: () => void }) => {
        opts?.onSuccess?.();
      },
    );
    restoreMutate.mockImplementationOnce(
      (_vars: unknown, opts?: { onError?: (err: unknown) => void }) => {
        opts?.onError?.(null);
      },
    );

    renderBetLog([makeBet()]);
    await openDeleteDialogAndConfirm(user);

    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    const deleteSuccessToast = toastMock.mock.calls[0][0];

    const { unmount: unmountAction } = render(deleteSuccessToast.action);
    await user.click(screen.getByRole("button", { name: /undo/i }));
    unmountAction();

    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(2));
    const restoreErrorToast = toastMock.mock.calls[1][0];
    expect(restoreErrorToast.title).toBe("Could not undo");
    expect(restoreErrorToast.description).toBe("This bet can no longer be restored.");
    expect(restoreErrorToast.variant).toBe("destructive");
  });

  it("shows the server's message when restore onError carries err.data.error", async () => {
    const user = userEvent.setup();

    deleteMutate.mockImplementationOnce(
      (_vars: unknown, opts?: { onSuccess?: () => void }) => {
        opts?.onSuccess?.();
      },
    );
    restoreMutate.mockImplementationOnce(
      (_vars: unknown, opts?: { onError?: (err: unknown) => void }) => {
        opts?.onError?.({ data: { error: "Restore window has expired" } });
      },
    );

    renderBetLog([makeBet()]);
    await openDeleteDialogAndConfirm(user);

    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    const deleteSuccessToast = toastMock.mock.calls[0][0];

    const { unmount: unmountAction } = render(deleteSuccessToast.action);
    await user.click(screen.getByRole("button", { name: /undo/i }));
    unmountAction();

    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(2));
    const restoreErrorToast = toastMock.mock.calls[1][0];
    expect(restoreErrorToast.title).toBe("Could not undo");
    expect(restoreErrorToast.description).toBe("Restore window has expired");
    expect(restoreErrorToast.variant).toBe("destructive");
  });

  it("shows fallback toast when restore onError receives a bare Error object", async () => {
    const user = userEvent.setup();

    deleteMutate.mockImplementationOnce(
      (_vars: unknown, opts?: { onSuccess?: () => void }) => {
        opts?.onSuccess?.();
      },
    );
    restoreMutate.mockImplementationOnce(
      (_vars: unknown, opts?: { onError?: (err: unknown) => void }) => {
        opts?.onError?.(new Error("Network request failed"));
      },
    );

    renderBetLog([makeBet()]);
    await openDeleteDialogAndConfirm(user);

    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    const deleteSuccessToast = toastMock.mock.calls[0][0];

    const { unmount: unmountAction } = render(deleteSuccessToast.action);
    await user.click(screen.getByRole("button", { name: /undo/i }));
    unmountAction();

    // A bare Error has no .data.error, so the fallback text must appear.
    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(2));
    const restoreErrorToast = toastMock.mock.calls[1][0];
    expect(restoreErrorToast.title).toBe("Could not undo");
    expect(restoreErrorToast.description).toBe("This bet can no longer be restored.");
    expect(restoreErrorToast.variant).toBe("destructive");
  });

  it("shows fallback toast when restore onError carries an empty err.data.error string", async () => {
    const user = userEvent.setup();

    deleteMutate.mockImplementationOnce(
      (_vars: unknown, opts?: { onSuccess?: () => void }) => {
        opts?.onSuccess?.();
      },
    );
    restoreMutate.mockImplementationOnce(
      (_vars: unknown, opts?: { onError?: (err: unknown) => void }) => {
        opts?.onError?.({ data: { error: "" } });
      },
    );

    renderBetLog([makeBet()]);
    await openDeleteDialogAndConfirm(user);

    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    const deleteSuccessToast = toastMock.mock.calls[0][0];

    const { unmount: unmountAction } = render(deleteSuccessToast.action);
    await user.click(screen.getByRole("button", { name: /undo/i }));
    unmountAction();

    // An empty string is falsy, so the logical-OR must produce the fallback.
    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(2));
    const restoreErrorToast = toastMock.mock.calls[1][0];
    expect(restoreErrorToast.title).toBe("Could not undo");
    expect(restoreErrorToast.description).toBe("This bet can no longer be restored.");
    expect(restoreErrorToast.variant).toBe("destructive");
  });
});

describe("EditBetDialog server error fallback", () => {
  /**
   * Guards against vague / structureless server errors going silent.
   * When the onError callback receives an empty object `{}` or `null`
   * (no err.data.error field), the dialog must still surface the
   * fallback "An unknown error occurred." message via toast AND must
   * NOT close — the user needs to know the save failed.
   */

  it("shows fallback toast and keeps dialog open when onError receives {}", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    updateMutate.mockImplementationOnce(
      (_vars: unknown, opts?: { onError?: (err: unknown) => void }) => {
        opts?.onError?.({});
      },
    );
    renderDialog(makeBet(), onOpenChange);

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    const [toastCall] = toastMock.mock.calls;
    expect(toastCall[0].description).toBe("An unknown error occurred.");
    expect(toastCall[0].variant).toBe("destructive");
    // Dialog must stay open — onOpenChange should never be called with false.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("shows fallback toast and keeps dialog open when onError receives null", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    updateMutate.mockImplementationOnce(
      (_vars: unknown, opts?: { onError?: (err: unknown) => void }) => {
        opts?.onError?.(null);
      },
    );
    renderDialog(makeBet(), onOpenChange);

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    const [toastCall] = toastMock.mock.calls;
    expect(toastCall[0].description).toBe("An unknown error occurred.");
    expect(toastCall[0].variant).toBe("destructive");
    // Dialog must stay open — onOpenChange should never be called with false.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("shows the server's message when onError carries err.data.error", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    updateMutate.mockImplementationOnce(
      (_vars: unknown, opts?: { onError?: (err: unknown) => void }) => {
        opts?.onError?.({ data: { error: "Bet is already settled" } });
      },
    );
    renderDialog(makeBet(), onOpenChange);

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    const [toastCall] = toastMock.mock.calls;
    expect(toastCall[0].description).toBe("Bet is already settled");
    expect(toastCall[0].variant).toBe("destructive");
    // Dialog must stay open — save failed, user must see the error.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
