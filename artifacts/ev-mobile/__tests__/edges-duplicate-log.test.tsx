// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  EdgeOpportunity,
  ModelPitcherProjection,
} from '@workspace/api-client-react';

/**
 * Locks in the phone's "already logged" handling for duplicate submissions on
 * the Edges screen — both 409 branches in app/(tabs)/index.tsx:
 *
 * 1. LogPropSheet (real-bet log): a 409 from createBet must run the duplicate
 *    path — invalidate the bet list and hand the server's message to
 *    `onDuplicate` — WITHOUT dead-ending the sheet in its error state. Any
 *    other failure must still surface the error inside the sheet.
 * 2. ProjectionCard (paper-trade log): a 409 from createPaperTrade must flip
 *    the row's button to "logged" (so it can't be re-tapped) while echoing
 *    the server's explanation; a non-409 leaves the row re-tappable.
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

// The shared UI kit pulls in reanimated; the flows under test only need Card
// to render its children so rows/sheets are reachable.
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

// Each test points these at the outcome it wants; the mutate mocks invoke the
// callbacks synchronously the way the real mutation would on settle.
let createBetError: unknown = null;
let createPaperTradeError: unknown = null;

const createBetMutate = vi.fn((_vars: unknown, opts?: MutateOpts) => {
  if (createBetError) opts?.onError?.(createBetError);
  else opts?.onSuccess?.();
  opts?.onSettled?.();
});
const createPaperTradeMutate = vi.fn((_vars: unknown, opts?: MutateOpts) => {
  if (createPaperTradeError) opts?.onError?.(createPaperTradeError);
  else opts?.onSuccess?.();
  opts?.onSettled?.();
});

vi.mock('@workspace/api-client-react', () => ({
  useCreateBet: () => ({ mutate: createBetMutate, isPending: false }),
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

import { LogPropSheet, ProjectionCard } from '../app/(tabs)/index';

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

let onClose: ReturnType<typeof vi.fn<() => void>>;
let onLogged: ReturnType<typeof vi.fn<(edge: EdgeOpportunity, units: number) => void>>;
let onDuplicate: ReturnType<typeof vi.fn<(edge: EdgeOpportunity, message: string) => void>>;

beforeEach(() => {
  createBetError = null;
  createPaperTradeError = null;
  createBetMutate.mockClear();
  createPaperTradeMutate.mockClear();
  invalidateQueries.mockClear();
  onClose = vi.fn<() => void>();
  onLogged = vi.fn<(edge: EdgeOpportunity, units: number) => void>();
  onDuplicate = vi.fn<(edge: EdgeOpportunity, message: string) => void>();
});

// No vitest globals, so testing-library's auto-cleanup never registers —
// unmount explicitly or renders leak across tests.
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

describe('LogPropSheet duplicate (409) handling', () => {
  it('a 409 runs the duplicate path: onDuplicate gets the server message, the bet list is invalidated, and no error is shown in the sheet', async () => {
    createBetError = {
      status: 409,
      data: { error: 'This bet is already open in your bet log.' },
    };
    renderSheet();

    await user.click(screen.getByLabelText('Log bet'));

    expect(onDuplicate).toHaveBeenCalledTimes(1);
    expect(onDuplicate).toHaveBeenCalledWith(
      edge,
      'This bet is already open in your bet log.',
    );
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['bets'] });
    // The critical contract: the duplicate path must NOT fall through to the
    // sheet's error state — no error text of any kind renders.
    expect(
      screen.queryByText('This bet is already open in your bet log.'),
    ).toBeNull();
    expect(screen.queryByText(/could not log this bet/i)).toBeNull();
    expect(onLogged).not.toHaveBeenCalled();
  });

  it('a 409 without a server message falls back to the default duplicate wording', async () => {
    createBetError = { status: 409 };
    renderSheet();

    await user.click(screen.getByLabelText('Log bet'));

    expect(onDuplicate).toHaveBeenCalledWith(
      edge,
      'This bet is already in your bet log.',
    );
  });

  it('a non-409 failure still surfaces the error inside the sheet and never calls onDuplicate', async () => {
    createBetError = { status: 400, data: { error: 'Odds are out of range.' } };
    renderSheet();

    await user.click(screen.getByLabelText('Log bet'));

    expect(screen.getByText('Odds are out of range.')).toBeDefined();
    expect(onDuplicate).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
    expect(onLogged).not.toHaveBeenCalled();
  });

  it('a non-409 failure without a body shows the generic error message', async () => {
    createBetError = { status: 500 };
    renderSheet();

    await user.click(screen.getByLabelText('Log bet'));

    expect(screen.getByText(/could not log this bet\. try again\./i)).toBeDefined();
    expect(onDuplicate).not.toHaveBeenCalled();
  });
});

describe('ProjectionCard duplicate (409) handling', () => {
  it('a 409 flips the row to logged (not re-tappable) and echoes the server message', async () => {
    createPaperTradeError = {
      status: 409,
      data: { error: 'This pick is already in your scorecard.' },
    };
    render(<ProjectionCard projection={projection} />);

    await user.click(screen.getByLabelText('Log paper trade'));

    // Row is now in the logged state — the idle log button is gone.
    expect(screen.getByLabelText('Logged to scorecard')).toBeDefined();
    expect(screen.queryByLabelText('Log paper trade')).toBeNull();
    expect(
      screen.getByText('This pick is already in your scorecard.'),
    ).toBeDefined();

    // The logged button is disabled, so a duplicate can't be re-fired.
    const loggedButton = screen.getByLabelText(
      'Logged to scorecard',
    ) as HTMLButtonElement;
    expect(loggedButton.disabled).toBe(true);
    expect(createPaperTradeMutate).toHaveBeenCalledTimes(1);
  });

  it('a non-409 failure shows the error and leaves the row re-tappable', async () => {
    createPaperTradeError = { status: 500, data: { error: 'Server exploded.' } };
    render(<ProjectionCard projection={projection} />);

    await user.click(screen.getByLabelText('Log paper trade'));

    expect(screen.getByText('Server exploded.')).toBeDefined();
    expect(screen.queryByLabelText('Logged to scorecard')).toBeNull();

    // Still idle — a retry fires a second create.
    await user.click(screen.getByLabelText('Log paper trade'));
    expect(createPaperTradeMutate).toHaveBeenCalledTimes(2);
  });
});
