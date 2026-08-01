// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ModelPitcherProjection } from '@workspace/api-client-react';

/**
 * Locks in the two-key invalidation contract for the phone's log-pick action
 * on the Edges screen (ProjectionCard in app/(tabs)/index.tsx).
 *
 * After a successful createPaperTrade mutation, invalidateQueries must be
 * called with BOTH ['paper-trades'] and ['paper-trade-summary'] so the
 * scorecard and summary tiles refresh immediately. A refactor that drops
 * either call will fail here, mirroring the equivalent web test for
 * ProjectionCard / logTrade.
 *
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
  SectionHeader: () => null,
  Skeleton: () => null,
  StatTile: () => null,
}));

type MutateOpts = {
  onSuccess?: (data?: unknown) => void;
  onError?: (err: unknown) => void;
  onSettled?: () => void;
};

// Succeeds by default; individual tests can override.
let createPaperTradeError: unknown = null;

const createPaperTradeMutate = vi.fn((_vars: unknown, opts?: MutateOpts) => {
  if (createPaperTradeError) opts?.onError?.(createPaperTradeError);
  else opts?.onSuccess?.();
  opts?.onSettled?.();
});

vi.mock('@workspace/api-client-react', () => ({
  useCreateBet: () => ({ mutate: vi.fn(), isPending: false }),
  useCreatePaperTrade: () => ({ mutate: createPaperTradeMutate, isPending: false }),
  useListEvents: () => ({ data: [] }),
  useListModelEdges: () => ({ data: [] }),
  useListPropEdges: () => ({ data: [] }),
  useListSports: () => ({ data: [] }),
  getListBetsQueryKey: () => ['bets'],
  getListEventsQueryKey: () => ['events'],
  getListModelEdgesQueryKey: () => ['model-edges'],
  getListPropEdgesQueryKey: () => ['prop-edges'],
  getListPaperTradesQueryKey: () => ['paper-trades'],
  getGetPaperTradeSummaryQueryKey: () => ['paper-trade-summary'],
}));

import { ProjectionCard } from '../app/(tabs)/index';

const projection: ModelPitcherProjection = {
  sport: 'baseball_mlb',
  gameId: 'g1',
  commenceTime: '2026-07-14T23:10:00Z',
  homeTeam: 'NYY',
  awayTeam: 'BOS',
  pitcher: 'Gerrit Cole',
  team: 'NYY',
  opponent: 'BOS',
  throws: 'R',
  expectedStrikeouts: 7.1,
  projectedBattersFaced: 24,
  opponentFactor: 1.02,
  ratePerBF: 0.29,
  sampleStarts: 12,
  sampleBattersFaced: 300,
  opponentDataAvailable: true,
  insufficientData: false,
  lines: [
    {
      selection: 'Over',
      point: 6.5,
      book: 'fanduel',
      americanOdds: -110,
      modelProb: 0.58,
      marketProb: 0.52,
      edgePercent: 6,
      isFlagged: true,
      recommendedUnits: 1,
    },
  ],
} as ModelPitcherProjection;

const user = userEvent.setup();

beforeEach(() => {
  createPaperTradeError = null;
  createPaperTradeMutate.mockClear();
  invalidateQueries.mockClear();
});

// No vitest globals, so testing-library's auto-cleanup never registers —
// unmount explicitly or renders leak across tests.
afterEach(cleanup);

describe('ProjectionCard log-pick → query invalidation', () => {
  // Sync: keep this test's invalidateQueries assertions aligned with the
  // equivalent web test for ProjectionCard / logTrade — both must assert the
  // same two-key invalidation contract so a refactor that drops either call
  // fails on both platforms, not just one.
  it('invalidates both paper-trades and paper-trade-summary after a successful log-pick', async () => {
    render(<ProjectionCard projection={projection} />);

    await user.click(screen.getByLabelText('Log paper trade'));

    expect(createPaperTradeMutate).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['paper-trades'] });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['paper-trade-summary'],
    });
    expect(invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it('does not invalidate any queries when the mutation fails', async () => {
    createPaperTradeError = { status: 500, data: { error: 'Server error.' } };
    render(<ProjectionCard projection={projection} />);

    await user.click(screen.getByLabelText('Log paper trade'));

    expect(createPaperTradeMutate).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});
