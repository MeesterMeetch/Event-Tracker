// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Bet } from '@workspace/api-client-react';

/**
 * Locks in the Bet Log delete → Undo flow on the mobile Bets screen:
 * deleting a bet surfaces a success banner carrying an UNDO action, tapping
 * it fires the restore mutation for that bet id and re-invalidates the bets
 * and dashboard-summary queries, and a stale/double Undo (restore 404s past
 * the grace window) swaps the banner to the friendly "can no longer be
 * restored" error instead of failing silently. Rendered through
 * react-native-web (aliased in vitest.config.ts) so no Expo/Metro runtime is
 * needed.
 */

vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(),
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));

vi.mock('@expo/vector-icons', () => ({
  Feather: () => null,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const invalidateQueries = vi.fn();
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries }),
}));

// The shared UI kit pulls in reanimated; the flow under test only needs the
// list card to render its children and the banner text to be reachable.
vi.mock('@/components/ui', () => ({
  Badge: ({ label }: { label: string }) => <span>{label}</span>,
  Card: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  EmptyState: () => null,
  ErrorState: () => null,
  ScreenHeader: () => null,
  SectionHeader: ({ title }: { title: string }) => <div>{title}</div>,
  Skeleton: () => null,
  StatTile: () => null,
}));

type MutateOpts = {
  onSuccess?: (data?: unknown) => void;
  onError?: (err: unknown) => void;
  onSettled?: () => void;
};

// Delete always succeeds (204 → no payload); restore behavior is swapped per
// test between the happy path and the 404 "grace window expired" path.
const deleteMutate = vi.fn((_vars: { id: number }, opts?: MutateOpts) => {
  opts?.onSuccess?.(undefined);
  opts?.onSettled?.();
});
let restoreImpl: (vars: { id: number }, opts?: MutateOpts) => void = () => {};
const restoreMutate = vi.fn((vars: { id: number }, opts?: MutateOpts) =>
  restoreImpl(vars, opts),
);

let betsData: Bet[] = [];

vi.mock('@workspace/api-client-react', () => ({
  useListBets: () => ({
    data: betsData,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    isRefetching: false,
  }),
  useGetDashboardSummary: () => ({
    data: undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    isRefetching: false,
  }),
  useListSports: () => ({ data: [] }),
  useUpdateBet: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteBet: () => ({ mutate: deleteMutate, isPending: false }),
  useRestoreBet: () => ({ mutate: restoreMutate, isPending: false }),
  getListBetsQueryKey: () => ['bets'],
  getGetDashboardSummaryQueryKey: () => ['dashboard-summary'],
}));

import BetsScreen from '../app/(tabs)/bets';

function makeBet(overrides: Partial<Bet> = {}): Bet {
  return {
    id: 7,
    sport: 'baseball_mlb',
    gameId: 'g1',
    commenceTime: '2026-07-14T23:10:00Z',
    homeTeam: 'NYY',
    awayTeam: 'BOS',
    market: 'pitcher_strikeouts',
    selection: 'Gerrit Cole Over',
    point: 6.5,
    book: 'fanduel',
    americanOdds: -110,
    units: 1,
    status: 'pending',
    pnl: null,
    notes: null,
    createdAt: '2026-07-14T15:00:00Z',
    ...overrides,
  } as Bet;
}

const user = userEvent.setup();

/** Arms the row's two-step confirm and taps DELETE. */
async function deleteTheBet(selection: string) {
  await user.click(screen.getByLabelText(`Delete ${selection}`));
  await user.click(screen.getByText('DELETE'));
}

beforeEach(() => {
  betsData = [makeBet()];
  invalidateQueries.mockClear();
  deleteMutate.mockClear();
  restoreMutate.mockClear();
});

// No vitest globals, so testing-library's auto-cleanup never registers —
// unmount explicitly or renders leak across tests.
afterEach(cleanup);

describe('Bet Log delete → Undo flow', () => {
  it('shows the success banner with an UNDO action after deleting a bet', async () => {
    render(<BetsScreen />);

    await deleteTheBet('Gerrit Cole Over');

    expect(deleteMutate).toHaveBeenCalledTimes(1);
    expect(deleteMutate.mock.calls[0][0]).toEqual({ id: 7 });
    expect(screen.getByText('Deleted Gerrit Cole Over from the bet log')).toBeDefined();
    expect(screen.getByLabelText('Undo delete')).toBeDefined();
    // Delete already refreshed the list + summary once each.
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['bets'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['dashboard-summary'] });
  });

  it('tapping UNDO fires the restore mutation for that bet and re-invalidates the queries', async () => {
    restoreImpl = (vars, opts) =>
      opts?.onSuccess?.(makeBet({ id: vars.id }));
    render(<BetsScreen />);

    await deleteTheBet('Gerrit Cole Over');
    invalidateQueries.mockClear();

    await user.click(screen.getByLabelText('Undo delete'));

    expect(restoreMutate).toHaveBeenCalledTimes(1);
    expect(restoreMutate.mock.calls[0][0]).toEqual({ id: 7 });
    // Banner flips to the restored confirmation and drops the UNDO action.
    expect(screen.getByText('Restored Gerrit Cole Over to the bet log')).toBeDefined();
    expect(screen.queryByLabelText('Undo delete')).toBeNull();
    // Restore refreshed the list and the ledger summary again.
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['bets'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['dashboard-summary'] });
  });

  it('a stale Undo (restore 404) shows the server error banner instead of failing silently', async () => {
    // Mirrors the API's restore guard: past the grace window (or on a double
    // Undo) the endpoint 404s with this exact message.
    restoreImpl = (_vars, opts) =>
      opts?.onError?.({ data: { error: 'This bet can no longer be restored.' } });
    render(<BetsScreen />);

    await deleteTheBet('Gerrit Cole Over');
    invalidateQueries.mockClear();

    await user.click(screen.getByLabelText('Undo delete'));

    expect(restoreMutate).toHaveBeenCalledTimes(1);
    expect(screen.getByText('This bet can no longer be restored.')).toBeDefined();
    // The failed restore banner carries no UNDO action — no second tap.
    expect(screen.queryByLabelText('Undo delete')).toBeNull();
    // Nothing was restored, so nothing is re-invalidated.
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('falls back to the friendly restore message when the error carries no server text', async () => {
    restoreImpl = (_vars, opts) => opts?.onError?.(new Error('Network request failed'));
    render(<BetsScreen />);

    await deleteTheBet('Gerrit Cole Over');
    await user.click(screen.getByLabelText('Undo delete'));

    expect(
      screen.getByText('Could not undo — this bet can no longer be restored.'),
    ).toBeDefined();
  });
});
