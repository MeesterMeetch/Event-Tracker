// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Bet } from '@workspace/api-client-react';

/**
 * Locks in that structured server errors (err.data.error) surfaced by the
 * edit-bet and delete-bet mutations are shown to the user verbatim on the
 * phone, instead of being swallowed by the fallback message. Mirrors the
 * equivalent contract tests on the web EditBetDialog. Rendered through
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

// Swappable per-test implementations for the two mutations under test.
let updateImpl: (vars: { id: number; data: Record<string, unknown> }, opts?: MutateOpts) => void =
  () => {};
let deleteImpl: (vars: { id: number }, opts?: MutateOpts) => void = () => {};

const updateMutate = vi.fn(
  (vars: { id: number; data: Record<string, unknown> }, opts?: MutateOpts) =>
    updateImpl(vars, opts),
);
const deleteMutate = vi.fn((vars: { id: number }, opts?: MutateOpts) =>
  deleteImpl(vars, opts),
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
  useDeleteBet: () => ({ mutate: deleteMutate, isPending: false }),
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

async function openEditSheet(selection: string) {
  await user.click(screen.getByLabelText(`Edit ${selection}`));
}

async function deleteTheBet(selection: string) {
  await user.click(screen.getByLabelText(`Delete ${selection}`));
  await user.click(screen.getByText('DELETE'));
}

beforeEach(() => {
  betsData = [makeBet()];
  invalidateQueries.mockClear();
  updateMutate.mockClear();
  deleteMutate.mockClear();
  // Default both mutations to no-ops; each test overrides as needed.
  updateImpl = () => {};
  deleteImpl = () => {};
});

// No vitest globals, so testing-library's auto-cleanup never registers —
// unmount explicitly or renders leak across tests.
afterEach(cleanup);

// ---------------------------------------------------------------------------
// EditBetSheet — onError surface
// ---------------------------------------------------------------------------

describe('EditBetSheet onError — server error message', () => {
  /**
   * When the PATCH returns a structured error (err.data.error is a non-empty
   * string) the sheet must display that exact server message instead of the
   * generic fallback. This is the primary guard against silent swallow.
   */
  it('shows the server error message when err.data.error is a non-empty string', async () => {
    updateImpl = (_vars, opts) =>
      opts?.onError?.({ data: { error: 'Odds are outside the allowed range.' } });

    render(<BetsScreen />);
    await openEditSheet('Gerrit Cole Over');
    await user.click(screen.getByLabelText('Save changes'));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    // The server's exact message must appear in the sheet.
    expect(screen.getByText('Odds are outside the allowed range.')).toBeDefined();
    // The generic fallback must NOT be shown.
    expect(screen.queryByText('Could not update this bet. Try again.')).toBeNull();
  });

  /**
   * When the error carries no structured message (bare Error object) the
   * sheet falls back to the friendly copy so the user is never left silent.
   */
  it('falls back to the friendly message when the error carries no server text', async () => {
    updateImpl = (_vars, opts) => opts?.onError?.(new Error('Network request failed'));

    render(<BetsScreen />);
    await openEditSheet('Gerrit Cole Over');
    await user.click(screen.getByLabelText('Save changes'));

    expect(screen.getByText('Could not update this bet. Try again.')).toBeDefined();
  });

  /**
   * Edge case: err.data.error is an empty string — the logical-OR must treat
   * it as falsy and show the fallback instead of a blank error line.
   */
  it('falls back to the friendly message when err.data.error is an empty string', async () => {
    updateImpl = (_vars, opts) => opts?.onError?.({ data: { error: '' } });

    render(<BetsScreen />);
    await openEditSheet('Gerrit Cole Over');
    await user.click(screen.getByLabelText('Save changes'));

    expect(screen.getByText('Could not update this bet. Try again.')).toBeDefined();
  });

  /**
   * Edge case: structureless error object {} — optional-chain must not throw
   * and must still produce the fallback, not a blank or silent failure.
   */
  it('falls back to the friendly message when onError receives {}', async () => {
    updateImpl = (_vars, opts) => opts?.onError?.({} as any);

    render(<BetsScreen />);
    await openEditSheet('Gerrit Cole Over');
    await user.click(screen.getByLabelText('Save changes'));

    expect(screen.getByText('Could not update this bet. Try again.')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// DeleteBetSheet (delete mutation) — onError surface
// ---------------------------------------------------------------------------

describe('Delete bet onError — server error message', () => {
  /**
   * When the DELETE returns a structured error (err.data.error is a non-empty
   * string) the feedback banner must display that exact server message instead
   * of the generic fallback.
   */
  it('shows the server error message when err.data.error is a non-empty string', async () => {
    deleteImpl = (_vars, opts) =>
      opts?.onError?.({ data: { error: 'This bet has already been deleted.' } });

    render(<BetsScreen />);
    await deleteTheBet('Gerrit Cole Over');

    expect(deleteMutate).toHaveBeenCalledTimes(1);
    // The server's exact message must appear in the feedback banner.
    expect(screen.getByText('This bet has already been deleted.')).toBeDefined();
    // The generic fallback must NOT be shown.
    expect(screen.queryByText('Could not delete this bet. Try again.')).toBeNull();
    // A failed delete must not show the success banner or the Undo action.
    expect(screen.queryByLabelText('Undo delete')).toBeNull();
  });

  /**
   * When the error carries no structured message the feedback banner falls
   * back to the friendly copy.
   */
  it('falls back to the friendly message when the error carries no server text', async () => {
    deleteImpl = (_vars, opts) => opts?.onError?.(new Error('Network request failed'));

    render(<BetsScreen />);
    await deleteTheBet('Gerrit Cole Over');

    expect(screen.getByText('Could not delete this bet. Try again.')).toBeDefined();
    expect(screen.queryByLabelText('Undo delete')).toBeNull();
  });

  /**
   * Edge case: err.data.error is an empty string — must produce the fallback,
   * not a blank feedback banner.
   */
  it('falls back to the friendly message when err.data.error is an empty string', async () => {
    deleteImpl = (_vars, opts) => opts?.onError?.({ data: { error: '' } });

    render(<BetsScreen />);
    await deleteTheBet('Gerrit Cole Over');

    expect(screen.getByText('Could not delete this bet. Try again.')).toBeDefined();
  });

  /**
   * Edge case: structureless error object {} — optional-chain must not throw
   * and must produce the fallback.
   */
  it('falls back to the friendly message when onError receives {}', async () => {
    deleteImpl = (_vars, opts) => opts?.onError?.({} as any);

    render(<BetsScreen />);
    await deleteTheBet('Gerrit Cole Over');

    expect(screen.getByText('Could not delete this bet. Try again.')).toBeDefined();
    expect(screen.queryByLabelText('Undo delete')).toBeNull();
  });
});
