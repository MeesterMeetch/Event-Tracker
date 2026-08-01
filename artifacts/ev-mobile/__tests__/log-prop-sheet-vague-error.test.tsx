// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EdgeOpportunity } from '@workspace/api-client-react';

/**
 * Locks in the LogPropSheet fallback message when the server returns a vague
 * or empty error (e.g. network timeout, 500 with no body). The onError handler
 * must show a user-visible message inline; the sheet must stay open and
 * onLogged must never be called.
 *
 * Specifically exercises the two "empty" error shapes:
 *  - `{}` — a defined object with no status or data fields
 *  - `null` — no error object at all
 *
 * Rendered via react-native-web (aliased in vitest.config.ts).
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

let createBetError: unknown = null;

const createBetMutate = vi.fn((_vars: unknown, opts?: MutateOpts) => {
  if (createBetError !== null) opts?.onError?.(createBetError);
  else opts?.onSuccess?.();
  opts?.onSettled?.();
});

vi.mock('@workspace/api-client-react', () => ({
  useCreateBet: () => ({ mutate: createBetMutate, isPending: false }),
  useCreatePaperTrade: () => ({ mutate: vi.fn(), isPending: false }),
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

import { LogPropSheet } from '../app/(tabs)/index';

const edge: EdgeOpportunity = {
  sport: 'baseball_mlb',
  gameId: 'g1',
  commenceTime: '2026-07-14T23:10:00Z',
  homeTeam: 'NYY',
  awayTeam: 'BOS',
  market: 'pitcher_strikeouts',
  selection: 'Over',
  player: 'Gerrit Cole',
  point: 6.5,
  americanOdds: 110,
  fairOdds: -105,
  evPercent: 4.2,
  book: 'fanduel',
} as EdgeOpportunity;

const user = userEvent.setup();

let onClose: ReturnType<typeof vi.fn<() => void>>;
let onLogged: ReturnType<typeof vi.fn<(edge: EdgeOpportunity, units: number) => void>>;
let onDuplicate: ReturnType<typeof vi.fn<(edge: EdgeOpportunity, message: string) => void>>;

beforeEach(() => {
  createBetError = null;
  createBetMutate.mockClear();
  invalidateQueries.mockClear();
  onClose = vi.fn<() => void>();
  onLogged = vi.fn<(edge: EdgeOpportunity, units: number) => void>();
  onDuplicate = vi.fn<(edge: EdgeOpportunity, message: string) => void>();
});

afterEach(cleanup);

function renderSheet() {
  render(
    <LogPropSheet
      edge={edge}
      onClose={onClose}
      onLogged={onLogged}
      onDuplicate={onDuplicate}
    />,
  );
}

describe('LogPropSheet vague-error fallback', () => {
  it('shows the fallback message inline when onError receives an empty object {}', async () => {
    createBetError = {};
    renderSheet();

    await user.click(screen.getByLabelText('Log bet'));

    // Fallback message must appear in the sheet
    expect(
      screen.getByText(/could not log this bet\. try again\./i),
    ).toBeDefined();

    // Sheet stays open — onClose must not have been called
    expect(onClose).not.toHaveBeenCalled();

    // onLogged is never called — the submission did not succeed
    expect(onLogged).not.toHaveBeenCalled();

    // Not treated as a duplicate
    expect(onDuplicate).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('shows the fallback message inline when onError receives null', async () => {
    // Sentinel: mutate should call onError(null), not onSuccess
    createBetError = undefined; // won't trigger our sentinel
    // Override mutate for this test to pass null explicitly
    createBetMutate.mockImplementationOnce((_vars: unknown, opts?: MutateOpts) => {
      opts?.onError?.(null);
      opts?.onSettled?.();
    });
    renderSheet();

    await user.click(screen.getByLabelText('Log bet'));

    expect(
      screen.getByText(/could not log this bet\. try again\./i),
    ).toBeDefined();

    expect(onClose).not.toHaveBeenCalled();
    expect(onLogged).not.toHaveBeenCalled();
    expect(onDuplicate).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});
