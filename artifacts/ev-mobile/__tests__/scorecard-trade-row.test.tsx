// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PaperTrade } from '@workspace/api-client-react';

/**
 * Locks in the graded-delete guard on the mobile scorecard's TradeRow:
 * closed (graded) picks must show the blocking warning block when the delete
 * is armed — deleting one rewrites the model's validation stats — while
 * open/expired picks get the lightweight inline REMOVE? confirm. Rendered
 * through react-native-web (aliased in vitest.config.ts) so no Expo/Metro
 * runtime is needed.
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

// The shared UI kit pulls in reanimated; TradeRow only needs Badge.
vi.mock('@/components/ui', () => ({
  Badge: ({ label }: { label: string }) => <span>{label}</span>,
  Card: () => null,
  EmptyState: () => null,
  ErrorState: () => null,
  ScreenHeader: () => null,
  SectionHeader: () => null,
  Skeleton: () => null,
  StatTile: () => null,
}));

vi.mock('@workspace/api-client-react', () => ({
  useDeletePaperTrade: () => ({ mutate: vi.fn(), isPending: false }),
  useRestorePaperTrade: () => ({ mutate: vi.fn(), isPending: false }),
  useGetPaperTradeSummary: () => ({ data: undefined }),
  useListPaperTrades: () => ({ data: [] }),
  getListPaperTradesQueryKey: () => ['paper-trades'],
  getGetPaperTradeSummaryQueryKey: () => ['paper-trade-summary'],
}));

import { TradeRow } from '../app/(tabs)/scorecard';

function makeTrade(overrides: Partial<PaperTrade>): PaperTrade {
  return {
    id: 1,
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

const user = userEvent.setup();
const armLabel = /delete pick gerrit cole over 6\.5/i;
const gradedWarning = /this pick is already graded/i;

let onDelete: ReturnType<typeof vi.fn<() => void>>;
beforeEach(() => {
  onDelete = vi.fn<() => void>();
});

// No vitest globals, so testing-library's auto-cleanup never registers —
// unmount explicitly or renders leak across tests.
afterEach(cleanup);

describe('TradeRow graded-delete guard', () => {
  it('shows the blocking graded warning when a closed pick is armed, without deleting', async () => {
    render(
      <TradeRow
        trade={makeTrade({ status: 'closed', closingOdds: -125, clvPercent: 3.1 })}
        onDelete={onDelete}
        deleting={false}
      />,
    );

    await user.click(screen.getByLabelText(armLabel));

    expect(screen.getByText(gradedWarning)).toBeDefined();
    expect(screen.getByText('DELETE GRADED PICK')).toBeDefined();
    expect(screen.queryByText('REMOVE?')).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('deletes a closed pick only after the explicit graded confirm', async () => {
    render(
      <TradeRow
        trade={makeTrade({ status: 'closed', closingOdds: -125, clvPercent: 3.1 })}
        onDelete={onDelete}
        deleting={false}
      />,
    );

    await user.click(screen.getByLabelText(armLabel));
    await user.click(screen.getByText('DELETE GRADED PICK'));

    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('KEEP dismisses the graded warning without deleting', async () => {
    render(
      <TradeRow
        trade={makeTrade({ status: 'closed', closingOdds: -125, clvPercent: 3.1 })}
        onDelete={onDelete}
        deleting={false}
      />,
    );

    await user.click(screen.getByLabelText(armLabel));
    await user.click(screen.getByText('KEEP'));

    expect(screen.queryByText(gradedWarning)).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('shows the lightweight inline REMOVE? confirm for an open pick', async () => {
    render(<TradeRow trade={makeTrade({ status: 'open' })} onDelete={onDelete} deleting={false} />);

    await user.click(screen.getByLabelText(armLabel));

    expect(screen.getByText('REMOVE?')).toBeDefined();
    expect(screen.queryByText(gradedWarning)).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();

    await user.click(screen.getByText('DELETE'));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('shows the inline confirm (not the graded warning) for an expired pick', async () => {
    render(
      <TradeRow trade={makeTrade({ status: 'expired' })} onDelete={onDelete} deleting={false} />,
    );

    await user.click(screen.getByLabelText(armLabel));

    expect(screen.getByText('REMOVE?')).toBeDefined();
    expect(screen.queryByText(gradedWarning)).toBeNull();
  });
});
