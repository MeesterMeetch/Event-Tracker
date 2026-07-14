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
}));

vi.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LogBetDialog } from "./LiveEdges";

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
