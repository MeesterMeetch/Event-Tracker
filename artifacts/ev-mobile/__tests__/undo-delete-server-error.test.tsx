// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Bet } from '@workspace/api-client-react';

/**
 * Locks in that structured server errors (err.data.error) surfaced by the
 * restore-bet (undo-delete) mutation are shown to the user verbatim in the
 * feedback banner instead of being swallowed by the fallback message.
 * Mirrors the equivalent contract tests for settle-bet and delete-bet.
 * Rendered through react-native-web (aliased in vitest.config.ts) so no
 * Expo/Metro runtime is needed.
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

// Swappable per-test implementations for the two mutations involved.
let deleteImpl: (vars: { id: number }, opts?: MutateOpts) => void = () => {};
let restoreImpl: (vars: { id: number }, opts?: MutateOpts) => void = () => {};

const deleteMutate = vi.fn((vars: { id: number }, opts?: MutateOpts) =>
  deleteImpl(vars, opts),
);
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

/** Trigger the two-step delete flow and the subsequent Undo tap. */
async function deleteAndUndo(selection: string) {
  // Step 1: arm the confirm prompt.
  await user.click(screen.getByLabelText(`Delete ${selection}`));
  // Step 2: confirm deletion (calls deleteMutate → deleteImpl → onSuccess).
  await user.click(screen.getByText('DELETE'));
  // Step 3: tap Undo in the success banner (calls restoreMutate → restoreImpl).
  await user.click(screen.getByLabelText('Undo delete'));
}

beforeEach(() => {
  betsData = [makeBet()];
  invalidateQueries.mockClear();
  deleteMutate.mockClear();
  restoreMutate.mockClear();
  // Default delete to a success so the Undo button appears; each test can
  // override restoreImpl to exercise the onError branch.
  deleteImpl = (_vars, opts) =>
    opts?.onSuccess?.();
  restoreImpl = () => {};
});

// No vitest globals, so testing-library's auto-cleanup never registers —
// unmount explicitly or renders leak across tests.
afterEach(cleanup);

// ---------------------------------------------------------------------------
// restoreBet onError — feedback banner surface
// ---------------------------------------------------------------------------

describe('restore-bet (undo-delete) onError — feedback banner', () => {
  /**
   * Primary guard: when the restore POST returns a structured server error
   * (err.data.error is a non-empty string) the feedback banner must display
   * that exact message instead of the generic fallback. This is the primary
   * guard against silent swallow on the undo-delete path.
   */
  it('shows the server error message when err.data.error is a non-empty string', async () => {
    restoreImpl = (_vars, opts) =>
      opts?.onError?.({ data: { error: 'This bet can no longer be restored.' } });

    render(<BetsScreen />);
    await deleteAndUndo('Gerrit Cole Over');

    expect(restoreMutate).toHaveBeenCalledTimes(1);
    // The server's exact message must appear in the feedback banner.
    expect(
      screen.getByText('This bet can no longer be restored.'),
    ).toBeDefined();
    // The generic fallback must NOT be shown.
    expect(
      screen.queryByText('Could not undo — this bet can no longer be restored.'),
    ).toBeNull();
    // A failed restore must not show the Undo button again.
    expect(screen.queryByLabelText('Undo delete')).toBeNull();
  });

  /**
   * When the error carries no structured message (bare Error object) the
   * feedback banner falls back to the friendly copy so the user is never
   * left silent.
   */
  it('falls back to the friendly message when the error carries no server text', async () => {
    restoreImpl = (_vars, opts) =>
      opts?.onError?.(new Error('Network request failed'));

    render(<BetsScreen />);
    await deleteAndUndo('Gerrit Cole Over');

    expect(
      screen.getByText('Could not undo — this bet can no longer be restored.'),
    ).toBeDefined();
    expect(screen.queryByLabelText('Undo delete')).toBeNull();
  });

  /**
   * Edge case: err.data.error is an empty string — the logical-OR must treat
   * it as falsy and show the fallback instead of a blank feedback line.
   */
  it('falls back to the friendly message when err.data.error is an empty string', async () => {
    restoreImpl = (_vars, opts) =>
      opts?.onError?.({ data: { error: '' } });

    render(<BetsScreen />);
    await deleteAndUndo('Gerrit Cole Over');

    expect(
      screen.getByText('Could not undo — this bet can no longer be restored.'),
    ).toBeDefined();
    expect(screen.queryByLabelText('Undo delete')).toBeNull();
  });

  /**
   * Edge case: structureless error object {} — optional-chain must not throw
   * and must still produce the fallback, not a blank or silent failure.
   */
  it('falls back to the friendly message when onError receives {}', async () => {
    restoreImpl = (_vars, opts) =>
      opts?.onError?.({} as any);

    render(<BetsScreen />);
    await deleteAndUndo('Gerrit Cole Over');

    expect(
      screen.getByText('Could not undo — this bet can no longer be restored.'),
    ).toBeDefined();
    expect(screen.queryByLabelText('Undo delete')).toBeNull();
  });
});
