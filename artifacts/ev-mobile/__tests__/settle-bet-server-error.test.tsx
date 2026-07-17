// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Bet } from '@workspace/api-client-react';

/**
 * Locks in that structured server errors (err.data.error) surfaced by the
 * settle-bet mutation (status update via the row's settle chips) are shown to
 * the user verbatim in the feedback banner instead of being swallowed by the
 * fallback message. Mirrors the equivalent contract tests for edit-bet and
 * delete-bet. Rendered through react-native-web (aliased in vitest.config.ts)
 * so no Expo/Metro runtime is needed.
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

// Swappable per-test implementation for the update mutation under test.
let updateImpl: (vars: { id: number; data: Record<string, unknown> }, opts?: MutateOpts) => void =
  () => {};

const updateMutate = vi.fn(
  (vars: { id: number; data: Record<string, unknown> }, opts?: MutateOpts) =>
    updateImpl(vars, opts),
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
  useUpdateBet: () => ({ mutate: updateMutate, isPending: false }),
  useDeleteBet: () => ({ mutate: vi.fn(), isPending: false }),
  useRestoreBet: () => ({ mutate: vi.fn(), isPending: false }),
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

/** Open the settle chip row for the named selection. */
async function openSettleRow(selection: string) {
  await user.click(screen.getByLabelText(`Settle ${selection}`));
}

/** Trigger settling the named bet to a given status label (e.g. 'won'). */
async function settleBet(selection: string, statusLabel: string) {
  await openSettleRow(selection);
  await user.click(
    screen.getByLabelText(`Mark ${selection} as ${statusLabel}`),
  );
}

beforeEach(() => {
  betsData = [makeBet()];
  invalidateQueries.mockClear();
  updateMutate.mockClear();
  // Default the mutation to a no-op; each test overrides as needed.
  updateImpl = () => {};
});

// No vitest globals, so testing-library's auto-cleanup never registers —
// unmount explicitly or renders leak across tests.
afterEach(cleanup);

// ---------------------------------------------------------------------------
// settleBet onError — feedback banner surface
// ---------------------------------------------------------------------------

describe('settle-bet onError — feedback banner', () => {
  /**
   * Primary guard: when the PATCH returns a structured server error
   * (err.data.error is a non-empty string) the feedback banner must display
   * that exact message instead of the generic fallback.
   */
  it('shows the server error message when err.data.error is a non-empty string', async () => {
    updateImpl = (_vars, opts) =>
      opts?.onError?.({ data: { error: 'This bet cannot be settled in its current state.' } });

    render(<BetsScreen />);
    await settleBet('Gerrit Cole Over', 'won');

    expect(updateMutate).toHaveBeenCalledTimes(1);
    // The server's exact message must appear in the feedback banner.
    expect(
      screen.getByText('This bet cannot be settled in its current state.'),
    ).toBeDefined();
    // The generic fallback must NOT be shown.
    expect(
      screen.queryByText('Could not update this bet. Try again.'),
    ).toBeNull();
    // A failed settle must not show an Undo button.
    expect(screen.queryByLabelText('Undo delete')).toBeNull();
  });

  /**
   * When the error carries no structured message (bare Error object) the
   * feedback banner falls back to the friendly copy so the user is never
   * left silent.
   */
  it('falls back to the friendly message when the error carries no server text', async () => {
    updateImpl = (_vars, opts) =>
      opts?.onError?.(new Error('Network request failed'));

    render(<BetsScreen />);
    await settleBet('Gerrit Cole Over', 'lost');

    expect(
      screen.getByText('Could not update this bet. Try again.'),
    ).toBeDefined();
    expect(screen.queryByLabelText('Undo delete')).toBeNull();
  });

  /**
   * Edge case: err.data.error is an empty string — the logical-OR must treat
   * it as falsy and show the fallback instead of a blank feedback line.
   */
  it('falls back to the friendly message when err.data.error is an empty string', async () => {
    updateImpl = (_vars, opts) =>
      opts?.onError?.({ data: { error: '' } });

    render(<BetsScreen />);
    await settleBet('Gerrit Cole Over', 'push');

    expect(
      screen.getByText('Could not update this bet. Try again.'),
    ).toBeDefined();
  });

  /**
   * Edge case: structureless error object {} — optional-chain must not throw
   * and must still produce the fallback, not a blank or silent failure.
   */
  it('falls back to the friendly message when onError receives {}', async () => {
    updateImpl = (_vars, opts) =>
      opts?.onError?.({} as any);

    render(<BetsScreen />);
    await settleBet('Gerrit Cole Over', 'won');

    expect(
      screen.getByText('Could not update this bet. Try again.'),
    ).toBeDefined();
    expect(screen.queryByLabelText('Undo delete')).toBeNull();
  });
});
