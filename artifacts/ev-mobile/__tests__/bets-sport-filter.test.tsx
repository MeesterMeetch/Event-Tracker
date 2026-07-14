// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Bet, DashboardSummary } from '@workspace/api-client-react';

/**
 * Locks in the "tap a sport in the ledger to see just those bets" flow on
 * the mobile Bet Log screen: tapping a row in the By Sport breakdown filters
 * the Logged Bets list to that sport (client-side, combinable with the
 * status chips), surfaces a labeled clear chip next to the status filters,
 * tapping the same row (or the chip) clears the filter, and an empty
 * filtered list names the sport instead of claiming the ledger is empty.
 * Rendered through react-native-web (aliased in vitest.config.ts).
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

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

// The shared UI kit pulls in reanimated; the flow under test only needs the
// cards to render children and the empty state's title to be reachable.
vi.mock('@/components/ui', () => ({
  Badge: ({ label }: { label: string }) => <span>{label}</span>,
  Card: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  EmptyState: ({ title, subtitle }: { title: string; subtitle?: string }) => (
    <div>
      <div>{title}</div>
      {subtitle ? <div>{subtitle}</div> : null}
    </div>
  ),
  ErrorState: () => null,
  ScreenHeader: () => null,
  SectionHeader: ({ title }: { title: string }) => <div>{title}</div>,
  Skeleton: () => null,
  StatTile: () => null,
}));

let betsData: Bet[] = [];
// The status filter is applied server-side via the hook params; the mock
// mirrors that so the sport filter's client-side AND is exercised for real.
let lastListBetsParams: { status?: string } | undefined;

vi.mock('@workspace/api-client-react', () => ({
  useListBets: (params?: { status?: string }) => {
    lastListBetsParams = params;
    return {
      data: params?.status ? betsData.filter((b) => b.status === params.status) : betsData,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
      isRefetching: false,
    };
  },
  useGetDashboardSummary: () => ({
    data: summaryData,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    isRefetching: false,
  }),
  useListSports: () => ({
    data: [{ key: 'basketball_wnba', title: 'WNBA' }],
  }),
  useUpdateBet: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteBet: () => ({ mutate: vi.fn(), isPending: false }),
  useRestoreBet: () => ({ mutate: vi.fn(), isPending: false }),
  getListBetsQueryKey: () => ['bets'],
  getGetDashboardSummaryQueryKey: () => ['dashboard-summary'],
}));

let summaryData: DashboardSummary | undefined;

import BetsScreen from '../app/(tabs)/bets';

function makeBet(overrides: Partial<Bet> = {}): Bet {
  return {
    id: 1,
    sport: 'basketball_wnba',
    gameId: 'g1',
    commenceTime: '2026-07-14T23:10:00Z',
    homeTeam: 'NYL',
    awayTeam: 'LVA',
    market: 'h2h',
    selection: 'New York Liberty',
    point: null,
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

const summaryBase: DashboardSummary = {
  totalBets: 3,
  won: 1,
  lost: 1,
  push: 0,
  pending: 1,
  totalUnits: 2,
  pendingUnits: 0,
  totalPnl: -1,
  roiPercent: -50,
  avgClvPercent: null,
  clvSampleSize: 0,
  bySport: [
    { sport: 'basketball_wnba', bets: 2, won: 0, lost: 1, push: 0, pending: 1, settledUnits: 1, pnl: -1, roiPercent: -100 },
    { sport: 'baseball_mlb', bets: 1, won: 1, lost: 0, push: 0, pending: 0, settledUnits: 1, pnl: 0.91, roiPercent: 91 },
  ],
} as DashboardSummary;

const user = userEvent.setup();

/** Expands the By Sport breakdown, then taps the given sport row. */
async function tapSportRow(label: string) {
  await user.click(screen.getByLabelText('Show sport breakdown'));
  await user.click(screen.getByLabelText(`Show only ${label} bets`));
}

beforeEach(() => {
  summaryData = summaryBase;
  betsData = [
    makeBet({ id: 1, sport: 'basketball_wnba', selection: 'New York Liberty', status: 'pending' }),
    makeBet({ id: 2, sport: 'basketball_wnba', selection: 'Aces Under', status: 'lost', pnl: -1 }),
    makeBet({ id: 3, sport: 'baseball_mlb', selection: 'Gerrit Cole Over', status: 'won', pnl: 0.91 }),
  ];
  lastListBetsParams = undefined;
});

// No vitest globals, so testing-library's auto-cleanup never registers —
// unmount explicitly or renders leak across tests.
afterEach(cleanup);

describe('Bet Log — sport filter from the By Sport breakdown', () => {
  it('filters the list to the tapped sport and shows a clear chip', async () => {
    render(<BetsScreen />);
    // All three bets visible before filtering.
    expect(screen.getByText(/Gerrit Cole Over/)).toBeTruthy();

    await tapSportRow('WNBA');

    expect(screen.getByText(/New York Liberty/)).toBeTruthy();
    expect(screen.getByText(/Aces Under/)).toBeTruthy();
    expect(screen.queryByText(/Gerrit Cole Over/)).toBeNull();
    // The clear affordance names the sport.
    expect(screen.getByLabelText('Clear sport filter WNBA')).toBeTruthy();
  });

  it('clears the filter from the chip and restores the full list', async () => {
    render(<BetsScreen />);
    await tapSportRow('WNBA');
    expect(screen.queryByText(/Gerrit Cole Over/)).toBeNull();

    await user.click(screen.getByLabelText('Clear sport filter WNBA'));

    expect(screen.getByText(/Gerrit Cole Over/)).toBeTruthy();
    expect(screen.queryByLabelText(/Clear sport filter/)).toBeNull();
  });

  it('clears the filter by tapping the same sport row again', async () => {
    render(<BetsScreen />);
    await tapSportRow('WNBA');

    await user.click(screen.getByLabelText('Stop filtering bets by WNBA'));

    expect(screen.getByText(/Gerrit Cole Over/)).toBeTruthy();
    expect(screen.queryByLabelText(/Clear sport filter/)).toBeNull();
  });

  it('combines with the status chips (sport AND status)', async () => {
    render(<BetsScreen />);
    await tapSportRow('WNBA');

    await user.click(screen.getByRole('button', { name: 'Lost' }));

    expect(lastListBetsParams).toEqual({ status: 'lost' });
    expect(screen.getByText(/Aces Under/)).toBeTruthy();
    expect(screen.queryByText(/New York Liberty/)).toBeNull();
    expect(screen.queryByText(/Gerrit Cole Over/)).toBeNull();
  });

  it('names the sport in the empty state when the filtered list has no bets', async () => {
    render(<BetsScreen />);
    // MLB titles are not in the live sports list — falls back to formatSportKey.
    await user.click(screen.getByLabelText('Show sport breakdown'));
    const mlbLabel = screen.getByLabelText(/Show only .*MLB.* bets/i);
    await user.click(mlbLabel);
    await user.click(screen.getByRole('button', { name: 'Pending' }));

    expect(screen.getByText(/^No pending .*MLB.* bets$/i)).toBeTruthy();
    expect(screen.getByText(/Clear the sport filter above/)).toBeTruthy();
  });
});
