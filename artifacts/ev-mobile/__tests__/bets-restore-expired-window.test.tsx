// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Bet } from '@workspace/api-client-react';

/**
 * Mirrors the web BetLog "undoDelete (restore) server error fallback" describe
 * block for the mobile Bets screen, focused on the expired-window path.
 *
 * Locks in two contracts:
 *  1. When the server replies with { data: { error: "Restore window has
 *     expired" } } the feedback banner shows that exact string — not the
 *     hardcoded fallback.
 *  2. When the error carries no server body the banner falls back to the
 *     friendly "Could not undo — this bet can no longer be restored." copy
 *     so the user is never left with a blank or silent failure.
 *
 * Rendered through react-native-web (aliased in vitest.config.ts) so no
 * Expo / Metro runtime is needed.
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

/** Arms the two-step confirm, fires DELETE, then taps Undo. */
async function deleteAndUndo(selection: string) {
  // Step 1: arm the confirm prompt.
  await user.click(screen.getByLabelText(`Delete ${selection}`));
  // Step 2: confirm deletion → deleteImpl → onSuccess → Undo banner appears.
  await user.click(screen.getByText('DELETE'));
  // Step 3: tap Undo → restoreImpl fires.
  await user.click(screen.getByLabelText('Undo delete'));
}

beforeEach(() => {
  betsData = [makeBet()];
  invalidateQueries.mockClear();
  deleteMutate.mockClear();
  restoreMutate.mockClear();
  // Default delete to succeed so the Undo button appears; each test overrides
  // restoreImpl to exercise the onError branch.
  deleteImpl = (_vars, opts) => opts?.onSuccess?.();
  restoreImpl = () => {};
});

// No vitest globals → testing-library's auto-cleanup never registers;
// unmount explicitly so renders don't leak across tests.
afterEach(cleanup);

// ---------------------------------------------------------------------------
// Expired-window restore error — feedback banner surface (mobile)
// ---------------------------------------------------------------------------

describe('restore-bet expired-window — feedback banner', () => {
  /**
   * Primary guard: when the server's 404 body carries
   * { data: { error: "Restore window has expired" } } the feedback banner
   * must show that exact string verbatim, not the hardcoded fallback.
   * Mirrors the web BetLog test "shows the server's message when restore
   * onError carries err.data.error".
   */
  it('shows the server expired-window message verbatim when err.data.error is set', async () => {
    restoreImpl = (_vars, opts) =>
      opts?.onError?.({ data: { error: 'Restore window has expired' } });

    render(<BetsScreen />);
    await deleteAndUndo('Gerrit Cole Over');

    expect(restoreMutate).toHaveBeenCalledTimes(1);
    // The server's exact expired-window message must appear in the banner.
    expect(screen.getByText('Restore window has expired')).toBeDefined();
    // The generic fallback must NOT be shown.
    expect(
      screen.queryByText('Could not undo — this bet can no longer be restored.'),
    ).toBeNull();
    // A failed restore must not offer a second Undo tap.
    expect(screen.queryByLabelText('Undo delete')).toBeNull();
  });

  /**
   * Fallback guard: when the error carries no structured body (bare Error
   * object) the banner must show the friendly fallback so the user is never
   * left silent.
   */
  it('shows the friendly fallback when the error carries no server body', async () => {
    restoreImpl = (_vars, opts) =>
      opts?.onError?.(new Error('Network request failed'));

    render(<BetsScreen />);
    await deleteAndUndo('Gerrit Cole Over');

    expect(
      screen.getByText('Could not undo — this bet can no longer be restored.'),
    ).toBeDefined();
    expect(screen.queryByText('Restore window has expired')).toBeNull();
    expect(screen.queryByLabelText('Undo delete')).toBeNull();
  });
});
