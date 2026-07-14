// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PaperTrade, PaperTradeSummary } from '@workspace/api-client-react';

/**
 * Locks in the Scorecard delete → Undo flow on the mobile Paper Scorecard
 * screen: deleting a pick surfaces a success banner carrying an UNDO action,
 * tapping it fires the restore mutation for that pick id and re-invalidates
 * the paper-trades and summary queries, and a stale/double Undo (restore 404s
 * past the grace window) swaps the banner to the friendly "can no longer be
 * restored" error instead of failing silently. Rendered through
 * react-native-web (aliased in vitest.config.ts) so no Expo/Metro runtime is
 * needed. Mirrors __tests__/bets-undo-delete.test.tsx.
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

let tradesData: PaperTrade[] = [];
let summaryData: PaperTradeSummary | undefined;

vi.mock('@workspace/api-client-react', () => ({
  useListPaperTrades: () => ({
    data: tradesData,
    refetch: vi.fn(),
  }),
  useGetPaperTradeSummary: () => ({
    data: summaryData,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    isRefetching: false,
  }),
  useDeletePaperTrade: () => ({ mutate: deleteMutate, isPending: false }),
  useRestorePaperTrade: () => ({ mutate: restoreMutate, isPending: false }),
  useUpdatePaperTrade: () => ({ mutate: vi.fn(), isPending: false }),
  getListPaperTradesQueryKey: () => ['paper-trades'],
  getGetPaperTradeSummaryQueryKey: () => ['paper-trade-summary'],
}));

import ScorecardScreen from '../app/(tabs)/scorecard';

function makeTrade(overrides: Partial<PaperTrade> = {}): PaperTrade {
  return {
    id: 11,
    sport: 'baseball_mlb',
    gameId: 'g1',
    commenceTime: '2026-07-14T23:10:00Z',
    homeTeam: 'NYY',
    awayTeam: 'BOS',
    pitcher: 'Gerrit Cole',
    team: 'NYY',
    opponent: 'BOS',
    selection: 'Over',
    point: 6.5,
    book: 'fanduel',
    americanOdds: -110,
    modelProb: 0.58,
    marketProb: 0.52,
    edgePercent: 6,
    isFlagged: true,
    expectedStrikeouts: 7.1,
    projectedBattersFaced: 24,
    recommendedUnits: 1,
    kellyMultiplier: 0.25,
    status: 'open',
    closingOdds: null,
    clvPercent: null,
    createdAt: '2026-07-14T15:00:00Z',
    ...overrides,
  } as PaperTrade;
}

function makeSummary(): PaperTradeSummary {
  return {
    total: 1,
    open: 1,
    closed: 0,
    expired: 0,
    gradedCount: 0,
    beatCloseCount: 0,
    beatCloseRate: null,
    avgClvPercent: null,
    avgEdgePercent: 6,
  } as PaperTradeSummary;
}

const user = userEvent.setup();

/** Arms the open pick's inline REMOVE? confirm and taps DELETE. */
async function deleteThePick() {
  await user.click(screen.getByLabelText('Delete pick Gerrit Cole Over 6.5'));
  await user.click(screen.getByText('DELETE'));
}

beforeEach(() => {
  tradesData = [makeTrade()];
  summaryData = makeSummary();
  invalidateQueries.mockClear();
  deleteMutate.mockClear();
  restoreMutate.mockClear();
});

// No vitest globals, so testing-library's auto-cleanup never registers —
// unmount explicitly or renders leak across tests.
afterEach(cleanup);

describe('Scorecard delete → Undo flow', () => {
  it('shows the success banner with an UNDO action after deleting a pick', async () => {
    render(<ScorecardScreen />);

    await deleteThePick();

    expect(deleteMutate).toHaveBeenCalledTimes(1);
    expect(deleteMutate.mock.calls[0][0]).toEqual({ id: 11 });
    expect(
      screen.getByText('Removed Gerrit Cole Over 6.5K from the scorecard'),
    ).toBeDefined();
    expect(screen.getByText('UNDO')).toBeDefined();
    // Delete already refreshed the list + summary once each.
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['paper-trades'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['paper-trade-summary'] });
  });

  it('tapping UNDO fires the restore mutation for that pick and re-invalidates the queries', async () => {
    restoreImpl = (vars, opts) => opts?.onSuccess?.(makeTrade({ id: vars.id }));
    render(<ScorecardScreen />);

    await deleteThePick();
    invalidateQueries.mockClear();

    await user.click(screen.getByText('UNDO'));

    expect(restoreMutate).toHaveBeenCalledTimes(1);
    expect(restoreMutate.mock.calls[0][0]).toEqual({ id: 11 });
    // Banner flips to the restored confirmation and drops the UNDO action.
    expect(
      screen.getByText('Restored Gerrit Cole Over 6.5K to the scorecard'),
    ).toBeDefined();
    expect(screen.queryByText('UNDO')).toBeNull();
    // Restore refreshed the list and the summary again.
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['paper-trades'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['paper-trade-summary'] });
  });

  it('a stale Undo (restore 404) shows the server error banner instead of failing silently', async () => {
    // Mirrors the API's restore guard: past the grace window (or on a double
    // Undo) the endpoint 404s with this exact message.
    restoreImpl = (_vars, opts) =>
      opts?.onError?.({ data: { error: 'This pick can no longer be restored.' } });
    render(<ScorecardScreen />);

    await deleteThePick();
    invalidateQueries.mockClear();

    await user.click(screen.getByText('UNDO'));

    expect(restoreMutate).toHaveBeenCalledTimes(1);
    expect(screen.getByText('This pick can no longer be restored.')).toBeDefined();
    // The failed restore banner carries no UNDO action — no second tap.
    expect(screen.queryByText('UNDO')).toBeNull();
    // Nothing was restored, so nothing is re-invalidated.
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('falls back to the friendly restore message when the error carries no server text', async () => {
    restoreImpl = (_vars, opts) => opts?.onError?.(new Error('Network request failed'));
    render(<ScorecardScreen />);

    await deleteThePick();
    await user.click(screen.getByText('UNDO'));

    expect(
      screen.getByText('Could not undo — this pick can no longer be restored.'),
    ).toBeDefined();
  });
});
