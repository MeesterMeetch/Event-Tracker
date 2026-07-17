// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Bet } from '@workspace/api-client-react';

/**
 * Confirms that the settle-bet onSuccess path (status update via the row's
 * settle chips) surfaces the server's returned pnl value in the feedback
 * banner, and that reopening to pending shows the "P&L cleared" message.
 * Uses the same mock pattern as settle-bet-server-error.test.tsx.
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
  await user.click(screen.getByLabelText(`Mark ${selection} as ${statusLabel}`));
}

beforeEach(() => {
  betsData = [makeBet()];
  invalidateQueries.mockClear();
  updateMutate.mockClear();
  updateImpl = () => {};
});

afterEach(cleanup);

// ---------------------------------------------------------------------------
// settleBet onSuccess — P&L shown in feedback banner
// ---------------------------------------------------------------------------

describe('settle-bet onSuccess — P&L in feedback banner', () => {
  /**
   * Primary guard: settling to 'won' when the server returns a positive pnl
   * must produce a banner that includes the formatted P&L string.
   * formatPnlUnits(0.91) → "+0.91u"
   */
  it('shows the server pnl in the banner when settling to won', async () => {
    updateImpl = (_vars, opts) => {
      opts?.onSuccess?.({ ...makeBet(), status: 'won', pnl: 0.91 });
      opts?.onSettled?.();
    };

    render(<BetsScreen />);
    await settleBet('Gerrit Cole Over', 'won');

    expect(updateMutate).toHaveBeenCalledTimes(1);
    // The banner must contain the selection name, the new status, and the formatted P&L.
    expect(screen.getByText('Marked Gerrit Cole Over won (+0.91u)')).toBeDefined();
  });

  /**
   * Settling to 'lost' with a negative pnl — the formatted value must appear
   * with the correct sign.
   * formatPnlUnits(-1) → "-1.00u"
   */
  it('shows the server pnl in the banner when settling to lost', async () => {
    updateImpl = (_vars, opts) => {
      opts?.onSuccess?.({ ...makeBet(), status: 'lost', pnl: -1 });
      opts?.onSettled?.();
    };

    render(<BetsScreen />);
    await settleBet('Gerrit Cole Over', 'lost');

    expect(screen.getByText('Marked Gerrit Cole Over lost (-1.00u)')).toBeDefined();
  });

  /**
   * Edge case: the server returns pnl=null (e.g. a push) — the banner must
   * still appear but without the P&L suffix, not blank or crashed.
   */
  it('omits the pnl suffix in the banner when the server returns pnl null', async () => {
    updateImpl = (_vars, opts) => {
      opts?.onSuccess?.({ ...makeBet(), status: 'push', pnl: null });
      opts?.onSettled?.();
    };

    render(<BetsScreen />);
    await settleBet('Gerrit Cole Over', 'push');

    expect(screen.getByText('Marked Gerrit Cole Over push')).toBeDefined();
  });

  /**
   * Reopening a settled bet to pending must show the "P&L cleared" message,
   * not the settlement copy. This confirms the status === 'pending' branch.
   */
  it('shows the P&L cleared message when reopening a settled bet to pending', async () => {
    // Start with a settled bet so the PENDING chip is enabled.
    betsData = [makeBet({ status: 'won', pnl: 0.91 })];

    updateImpl = (_vars, opts) => {
      opts?.onSuccess?.({ ...makeBet(), status: 'pending', pnl: null });
      opts?.onSettled?.();
    };

    render(<BetsScreen />);
    await settleBet('Gerrit Cole Over', 'pending');

    expect(screen.getByText('Reopened Gerrit Cole Over — P&L cleared')).toBeDefined();
    // Must NOT show a won/lost banner copy.
    expect(screen.queryByText(/Marked Gerrit Cole Over/)).toBeNull();
  });

  /**
   * Confirms that the dashboard and bets queries are both invalidated on a
   * successful settle so the summary tiles stay in sync.
   */
  it('invalidates both bets and dashboard queries on successful settle', async () => {
    updateImpl = (_vars, opts) => {
      opts?.onSuccess?.({ ...makeBet(), status: 'won', pnl: 0.91 });
      opts?.onSettled?.();
    };

    render(<BetsScreen />);
    await settleBet('Gerrit Cole Over', 'won');

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['bets'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['dashboard-summary'] });
  });
});
