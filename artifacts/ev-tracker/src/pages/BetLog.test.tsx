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

const { updateMutate, toastMock } = vi.hoisted(() => ({
  updateMutate: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock("@workspace/api-client-react", () => ({
  useUpdateBet: () => ({ mutate: updateMutate, isPending: false }),
  getListBetsQueryKey: () => ["bets"],
  getGetDashboardSummaryQueryKey: () => ["dashboard-summary"],
  // Pulled in by the rest of BetLog.tsx at module scope.
  useListBets: () => ({ data: [], isLoading: false }),
  useDeleteBet: () => ({ mutate: vi.fn(), isPending: false }),
  useRestoreBet: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EditBetDialog } from "./BetLog";

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

function renderDialog(bet: Bet) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <EditBetDialog bet={bet} open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  updateMutate.mockClear();
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
