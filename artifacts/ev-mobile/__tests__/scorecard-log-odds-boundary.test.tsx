// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ModelPitcherProjection } from '@workspace/api-client-react';

/**
 * Confirms that the phone's paper-trade log button applies the same
 * americanOdds boundary rule as the server (POST /paper-trades) before the
 * mutation is even fired.  The forbidden zone is the open interval (-100, 100):
 * the exact edges -100 and +100 are valid American odds and must pass; values
 * like 50, -50, and 0 are impossible on the American scale and must be caught
 * here on the device, not discovered at the HTTP layer.
 *
 * Companion to:
 *   - artifacts/api-server/src/routes/paper-trades-validation-parity.test.ts
 *     (schema ↔ shared-rule parity)
 *   - artifacts/ev-mobile/__tests__/scorecard-edit-price.test.tsx
 *     (EditTradeSheet PATCH flow)
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

const createPaperTradeMutate = vi.fn((_vars: unknown, opts?: MutateOpts) => {
  opts?.onSuccess?.();
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

// Error text shown by logTrade when it catches an impossible price.
const IMPOSSIBLE_ODDS_ERROR = 'Odds must be -100 or below, or +100 and up (e.g. -110).';

function makeProjection(americanOdds: number): ModelPitcherProjection {
  return {
    sport: 'baseball_mlb',
    gameId: 'g-boundary',
    commenceTime: '2026-07-15T23:10:00Z',
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
        americanOdds,
        modelProb: 0.58,
        marketProb: 0.52,
        edgePercent: 6,
        isFlagged: true,
        recommendedUnits: 1,
      },
    ],
  } as ModelPitcherProjection;
}

const user = userEvent.setup();

beforeEach(() => {
  createPaperTradeMutate.mockClear();
  invalidateQueries.mockClear();
});

afterEach(cleanup);

describe('ProjectionCard log button — americanOdds boundary guard', () => {
  it('rejects odds of 0 (impossible price): no mutation is fired and an error message appears', async () => {
    render(<ProjectionCard projection={makeProjection(0)} />);

    await user.click(screen.getByLabelText('Log paper trade'));

    expect(createPaperTradeMutate).not.toHaveBeenCalled();
    expect(screen.getByText(IMPOSSIBLE_ODDS_ERROR)).toBeDefined();
  });

  it('rejects odds of 50 (impossible price inside (0, 100)): no mutation and error shown', async () => {
    render(<ProjectionCard projection={makeProjection(50)} />);

    await user.click(screen.getByLabelText('Log paper trade'));

    expect(createPaperTradeMutate).not.toHaveBeenCalled();
    expect(screen.getByText(IMPOSSIBLE_ODDS_ERROR)).toBeDefined();
  });

  it('rejects odds of -50 (impossible price inside (-100, 0)): no mutation and error shown', async () => {
    render(<ProjectionCard projection={makeProjection(-50)} />);

    await user.click(screen.getByLabelText('Log paper trade'));

    expect(createPaperTradeMutate).not.toHaveBeenCalled();
    expect(screen.getByText(IMPOSSIBLE_ODDS_ERROR)).toBeDefined();
  });

  it('accepts odds of -100 (exact lower boundary): mutation fires and no error shown', async () => {
    // -100 is the outermost valid negative American odds; the forbidden zone is
    // the open interval (-100, 100), so the edge itself must be allowed through.
    render(<ProjectionCard projection={makeProjection(-100)} />);

    await user.click(screen.getByLabelText('Log paper trade'));

    expect(createPaperTradeMutate).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(IMPOSSIBLE_ODDS_ERROR)).toBeNull();
  });

  it('accepts odds of 100 (exact upper boundary): mutation fires and no error shown', async () => {
    // +100 is the outermost valid positive American odds; the forbidden zone is
    // the open interval (-100, 100), so the edge itself must be allowed through.
    render(<ProjectionCard projection={makeProjection(100)} />);

    await user.click(screen.getByLabelText('Log paper trade'));

    expect(createPaperTradeMutate).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(IMPOSSIBLE_ODDS_ERROR)).toBeNull();
  });

  it('accepts a canonical valid price -110: mutation fires and no error shown', async () => {
    render(<ProjectionCard projection={makeProjection(-110)} />);

    await user.click(screen.getByLabelText('Log paper trade'));

    expect(createPaperTradeMutate).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(IMPOSSIBLE_ODDS_ERROR)).toBeNull();
  });
});
