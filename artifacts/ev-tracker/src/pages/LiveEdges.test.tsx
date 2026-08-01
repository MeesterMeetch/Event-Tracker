// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EdgeOpportunity } from "@workspace/api-client-react";

/**
 * Guards the LiveEdges log-a-bet form against the FormMessage scaffold bug:
 * a re-scaffolded form.tsx that drops `{body}` from FormMessage would block
 * bad submits but render NO error text, silently stranding the user. This
 * suite drives the form with an invalid stake and asserts the validation
 * message is actually visible — and that the create mutation never fires.
 */

const { createMutate, toastMock } = vi.hoisted(() => ({
  createMutate: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock("@workspace/api-client-react", () => ({
  useCreateBet: () => ({ mutate: createMutate, isPending: false }),
  // Pulled in by the rest of LiveEdges.tsx at module scope.
  useListSports: () => ({ data: [], isLoading: false }),
  useListEdges: () => ({ data: [], isLoading: false, isFetching: false, isError: false }),
  useListEvents: () => ({ data: [], isLoading: false, isError: false }),
  useListPropEdges: () => ({ data: [], isLoading: false, isFetching: false, isError: false }),
  useListRankingsSports: () => ({ data: [] }),
  useListStandings: () => ({ data: [] }),
  useGenerateGameAnalysis: () => ({ mutate: vi.fn(), isPending: false }),
  getListEdgesQueryKey: () => ["edges"],
  getListEventsQueryKey: () => ["events"],
  getListPropEdgesQueryKey: () => ["prop-edges"],
  getListStandingsQueryKey: () => ["standings"],
  getListBetsQueryKey: () => ["bets"],
  getGetDashboardSummaryQueryKey: () => ["dashboard-summary"],
}));

vi.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LogBetDialog, ScannerLogButton } from "./LiveEdges";

function makeEdge(overrides: Partial<EdgeOpportunity> = {}): EdgeOpportunity {
  return {
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
    fairOdds: -125,
    evPercent: 2.4,
    ...overrides,
  } as EdgeOpportunity;
}

async function renderOpenDialog(edge: EdgeOpportunity) {
  const user = userEvent.setup();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <LogBetDialog edge={edge}>
        <button type="button">Log</button>
      </LogBetDialog>
    </QueryClientProvider>,
  );
  await user.click(screen.getByRole("button", { name: /^log$/i }));
  await screen.findByRole("dialog");
  return user;
}

beforeEach(() => {
  createMutate.mockClear();
  toastMock.mockClear();
});

afterEach(cleanup);

function renderScannerLogButton(edge: EdgeOpportunity) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ScannerLogButton edge={edge} />
    </QueryClientProvider>,
  );
}

describe("ScannerLogButton — impossible-price guard", () => {
  it("renders a disabled button for an impossible price inside (-100, 100)", async () => {
    renderScannerLogButton(makeEdge({ americanOdds: -50 }));

    const btn = screen.getByRole("button");
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(btn.getAttribute("aria-disabled")).toBeTruthy();
    expect(btn.textContent).toMatch(/invalid odds/i);
    expect(createMutate).not.toHaveBeenCalled();
  });

  it.each([
    ["negative impossible", -1],
    ["zero", 0],
    ["positive impossible", 50],
    ["-99 (just inside)", -99],
    ["+99 (just inside)", 99],
  ])("is disabled for %s (%i)", (_label, americanOdds) => {
    renderScannerLogButton(makeEdge({ americanOdds }));

    const btn = screen.getByRole("button");
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(btn.getAttribute("aria-disabled")).toBeTruthy();
  });

  it("keeps the button enabled at the valid boundary price -100", async () => {
    const user = userEvent.setup();
    renderScannerLogButton(makeEdge({ americanOdds: -100 }));

    // Should render the Log trigger (not the disabled fallback)
    const trigger = screen.getByRole("button", { name: /^log$/i });
    expect((trigger as HTMLButtonElement).disabled).toBe(false);

    // Clicking opens the dialog — mutation not called until form submit
    await user.click(trigger);
    await screen.findByRole("dialog");
    expect(createMutate).not.toHaveBeenCalled(); // not until form submit
  });

  it("keeps the button enabled at the valid boundary price +100", async () => {
    const user = userEvent.setup();
    renderScannerLogButton(makeEdge({ americanOdds: 100 }));

    const trigger = screen.getByRole("button", { name: /^log$/i });
    expect((trigger as HTMLButtonElement).disabled).toBe(false);

    await user.click(trigger);
    await screen.findByRole("dialog");
  });

  it("fires the mutation for a valid price when the form is submitted", async () => {
    const user = userEvent.setup();
    renderScannerLogButton(makeEdge({ americanOdds: -110 }));

    await user.click(screen.getByRole("button", { name: /^log$/i }));
    await screen.findByRole("dialog");

    // Submit with the default units value (1)
    await user.click(screen.getByRole("button", { name: /log bet/i }));

    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
    expect(createMutate.mock.calls[0][0].data.americanOdds).toBe(-110);
  });
});

/**
 * Locks in the impossible-odds guard inside LogBetDialog itself — independent
 * of ScannerLogButton. If the dialog is ever opened directly (e.g. in a future
 * context that bypasses the scanner button) with a price in the dead zone
 * (-100, +100), the form must block the mutation, show an inline error, and
 * disable the submit button. The Enter shortcut in the units field must also
 * be blocked. A refactor that removes the oddsValid check should fail here.
 */
describe("LogBetDialog impossible-odds submit guard", () => {
  it("shows an inline error and does not call the mutation when opened with impossible odds", async () => {
    const user = await renderOpenDialog(makeEdge({ americanOdds: 50 }));

    // The dialog is open — inline error must already be visible.
    expect(screen.getByRole("alert").textContent).toMatch(/-100 or below, or \+100 and up/);

    // Clicking the submit button must not fire the mutation.
    await user.click(screen.getByRole("button", { name: /log bet/i }));
    expect(createMutate).not.toHaveBeenCalled();
  });

  it("disables the Log Bet button when odds are impossible", async () => {
    await renderOpenDialog(makeEdge({ americanOdds: -50 }));

    const btn = screen.getByRole("button", { name: /log bet/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("pressing Enter in the units field with impossible odds does not call the mutation", async () => {
    const user = await renderOpenDialog(makeEdge({ americanOdds: 0 }));

    const units = screen.getByLabelText(/units/i);
    await user.clear(units);
    await user.type(units, "2{Enter}");

    expect(createMutate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/-100 or below, or \+100 and up/);
  });

  it("keeps the submit button enabled and hides the error for a valid boundary price -100", async () => {
    await renderOpenDialog(makeEdge({ americanOdds: -100 }));

    const btn = screen.getByRole("button", { name: /log bet/i });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("LogBetDialog log-pick success — query invalidation", () => {
  /**
   * Guards against the log-bet onSuccess handler forgetting to re-fetch the
   * bet log or the dashboard summary. Both getListBetsQueryKey() and
   * getGetDashboardSummaryQueryKey() must be invalidated so the scorecard and
   * the bet log table both reflect the new bet without a manual refresh.
   */

  it("invalidates both bet-list and dashboard-summary queries when the bet is logged", async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, "invalidateQueries");

    createMutate.mockImplementationOnce(
      (_vars: unknown, opts?: { onSuccess?: () => void }) => {
        opts?.onSuccess?.();
      },
    );

    render(
      <QueryClientProvider client={qc}>
        <LogBetDialog edge={makeEdge()}>
          <button type="button">Log</button>
        </LogBetDialog>
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole("button", { name: /^log$/i }));
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: /log bet/i }));

    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));

    const invalidatedKeys = invalidate.mock.calls.map((c) => (c[0] as { queryKey: unknown }).queryKey);
    expect(invalidatedKeys).toContainEqual(["bets"]);
    expect(invalidatedKeys).toContainEqual(["dashboard-summary"]);
  });
});

describe("LiveEdges LogBetDialog validation messages", () => {
  it("shows the minimum-stake message for units below 0.01 and blocks the mutation", async () => {
    const user = await renderOpenDialog(makeEdge());

    const units = screen.getByLabelText(/units/i);
    await user.clear(units);
    await user.type(units, "0");
    await user.click(screen.getByRole("button", { name: /log bet/i }));

    // The message must be VISIBLE text, not just a blocked submit — this is
    // exactly what the FormMessage `{body}` regression would break.
    expect(await screen.findByText(/must wager at least 0\.01 units/i)).toBeTruthy();
    expect(createMutate).not.toHaveBeenCalled();
  });

  it("shows the message when units are cleared entirely", async () => {
    const user = await renderOpenDialog(makeEdge());

    await user.clear(screen.getByLabelText(/units/i));
    await user.click(screen.getByRole("button", { name: /log bet/i }));

    expect(await screen.findByText(/must wager at least 0\.01 units/i)).toBeTruthy();
    expect(createMutate).not.toHaveBeenCalled();
  });

  it("submits a valid stake (positive control: the form itself works)", async () => {
    const user = await renderOpenDialog(makeEdge());

    const units = screen.getByLabelText(/units/i);
    await user.clear(units);
    await user.type(units, "1.5");
    await user.click(screen.getByRole("button", { name: /log bet/i }));

    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
    expect(createMutate.mock.calls[0][0].data.units).toBe(1.5);
    expect(screen.queryByText(/must wager at least/i)).toBeNull();
  });
});
