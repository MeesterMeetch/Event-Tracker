// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Bet } from '@workspace/api-client-react';

/**
 * Locks in the Edit Bet sheet's P&L override contract on the phone: leaving
 * the optional P&L field untouched must send a PATCH payload with NO `pnl`
 * key at all (the server keeps pnl in lockstep with odds/units), while typing
 * a correction sends it as an explicit manual override. A regression that
 * starts sending pnl unconditionally would silently freeze automatic grading
 * on every edit — unit tests cover parsePnlInput, but only this component
 * test asserts what actually goes over the wire. Rendered through
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
// list card to render its children so the row's Edit action is reachable.
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

// Capture every PATCH the sheet fires; resolve successfully with the vars'
// data echoed back so the success path (banner + invalidation) completes.
const updateMutate = vi.fn(
  (vars: { id: number; data: Record<string, unknown> }, opts?: MutateOpts) => {
    opts?.onSuccess?.({ ...makeBet(), ...vars.data });
    opts?.onSettled?.();
  },
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
    status: 'won',
    pnl: 0.91,
    notes: null,
    createdAt: '2026-07-14T15:00:00Z',
    ...overrides,
  } as Bet;
}

const user = userEvent.setup();

async function openEditSheet(selection: string) {
  await user.click(screen.getByLabelText(`Edit ${selection}`));
}

beforeEach(() => {
  betsData = [makeBet()];
  invalidateQueries.mockClear();
  updateMutate.mockClear();
});

// No vitest globals, so testing-library's auto-cleanup never registers —
// unmount explicitly or renders leak across tests.
afterEach(cleanup);

describe('EditBetSheet P&L override payload', () => {
  it('saving a settled bet with the P&L field untouched sends NO pnl key', async () => {
    render(<BetsScreen />);
    await openEditSheet('Gerrit Cole Over');

    // The override field is present for a settled bet, showing the current
    // auto-graded value only as a placeholder — never as prefilled text.
    const pnlField = screen.getByLabelText('P&L in units') as HTMLInputElement;
    expect(pnlField.value).toBe('');

    await user.click(screen.getByLabelText('Save changes'));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    const [vars] = updateMutate.mock.calls[0];
    expect(vars.id).toBe(7);
    // The critical contract: the key must be absent entirely (not null/0),
    // so the server recomputes pnl instead of freezing it.
    expect('pnl' in vars.data).toBe(false);
    expect(vars.data).toEqual({
      americanOdds: -110,
      units: 1,
      notes: null,
    });
  });

  it('typing a correction sends pnl as an explicit override', async () => {
    render(<BetsScreen />);
    await openEditSheet('Gerrit Cole Over');

    await user.type(screen.getByLabelText('P&L in units'), '-0.5');
    await user.click(screen.getByLabelText('Save changes'));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    const [vars] = updateMutate.mock.calls[0];
    expect(vars.data.pnl).toBe(-0.5);
  });

  it('clearing a typed value back to blank reverts to omitting pnl', async () => {
    render(<BetsScreen />);
    await openEditSheet('Gerrit Cole Over');

    const pnlField = screen.getByLabelText('P&L in units');
    await user.type(pnlField, '1.25');
    await user.clear(pnlField);
    await user.click(screen.getByLabelText('Save changes'));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect('pnl' in updateMutate.mock.calls[0][0].data).toBe(false);
  });

  it('the P&L field is absent for a pending bet, and its save sends no pnl', async () => {
    betsData = [makeBet({ status: 'pending', pnl: null })];
    render(<BetsScreen />);
    await openEditSheet('Gerrit Cole Over');

    expect(screen.queryByLabelText('P&L in units')).toBeNull();

    await user.click(screen.getByLabelText('Save changes'));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect('pnl' in updateMutate.mock.calls[0][0].data).toBe(false);
  });
});
