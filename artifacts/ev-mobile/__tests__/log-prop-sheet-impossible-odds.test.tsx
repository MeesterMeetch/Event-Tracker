// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EdgeOpportunity } from '@workspace/api-client-react';

/**
 * Confirms that the phone's log-bet form (LogPropSheet) applies the same
 * americanOdds boundary guard as the rest of the app before firing the
 * createBet mutation.
 *
 * The forbidden zone is the open interval (-100, 100): values like 0, 50,
 * and -50 are impossible on the American scale.  When an edge carrying such
 * odds is opened in the sheet:
 *   - The Log Bet button is disabled.
 *   - An inline error message is visible.
 *   - The Units TextInput's onSubmitEditing (Enter) path does NOT call the
 *     mutation.
 *   - Tapping the disabled button directly also does NOT call the mutation.
 *
 * Companion to:
 *   - artifacts/ev-mobile/__tests__/scorecard-log-odds-boundary.test.tsx
 *     (paper-trade LogButton disabled state)
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

const createBetMutate = vi.fn((_vars: unknown, _opts?: MutateOpts) => {
  // Should never be called in the impossible-odds tests.
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

function makeEdge(americanOdds: number): EdgeOpportunity {
  return {
    sport: 'baseball_mlb',
    gameId: 'g-impossible',
    commenceTime: '2026-07-15T23:10:00Z',
    homeTeam: 'NYY',
    awayTeam: 'BOS',
    market: 'pitcher_strikeouts',
    selection: 'Over',
    player: 'Gerrit Cole',
    point: 6.5,
    americanOdds,
    fairOdds: -105,
    evPercent: 4.2,
    book: 'fanduel',
  } as EdgeOpportunity;
}

const user = userEvent.setup();

let onClose: ReturnType<typeof vi.fn<() => void>>;
let onLogged: ReturnType<typeof vi.fn<(edge: EdgeOpportunity, units: number) => void>>;
let onDuplicate: ReturnType<typeof vi.fn<(edge: EdgeOpportunity, message: string) => void>>;

beforeEach(() => {
  createBetMutate.mockClear();
  invalidateQueries.mockClear();
  onClose = vi.fn<() => void>();
  onLogged = vi.fn<(edge: EdgeOpportunity, units: number) => void>();
  onDuplicate = vi.fn<(edge: EdgeOpportunity, message: string) => void>();
});

afterEach(cleanup);

// ─── Impossible odds: Enter on Units field must not call the mutation ─────────

describe('LogPropSheet — impossible odds block Enter / onSubmitEditing', () => {
  it('does not call the mutation when Enter is pressed on the units field with odds of 0', async () => {
    render(
      <LogPropSheet
        edge={makeEdge(0)}
        onClose={onClose}
        onLogged={onLogged}
        onDuplicate={onDuplicate}
      />,
    );

    // Click to focus the units field, then press Enter (simulates onSubmitEditing).
    const unitsInput = screen.getByLabelText('Units');
    await user.click(unitsInput);
    await user.keyboard('{Enter}');

    expect(createBetMutate).not.toHaveBeenCalled();
  });

  it('does not call the mutation when Enter is pressed with odds of 50 (forbidden open interval)', async () => {
    render(
      <LogPropSheet
        edge={makeEdge(50)}
        onClose={onClose}
        onLogged={onLogged}
        onDuplicate={onDuplicate}
      />,
    );

    const unitsInput = screen.getByLabelText('Units');
    await user.click(unitsInput);
    await user.keyboard('{Enter}');

    expect(createBetMutate).not.toHaveBeenCalled();
  });

  it('does not call the mutation when Enter is pressed with odds of -50 (forbidden open interval)', async () => {
    render(
      <LogPropSheet
        edge={makeEdge(-50)}
        onClose={onClose}
        onLogged={onLogged}
        onDuplicate={onDuplicate}
      />,
    );

    const unitsInput = screen.getByLabelText('Units');
    await user.click(unitsInput);
    await user.keyboard('{Enter}');

    expect(createBetMutate).not.toHaveBeenCalled();
  });
});

// ─── Impossible odds: inline error message is visible ────────────────────────

describe('LogPropSheet — impossible odds show inline error', () => {
  it('shows the out-of-range error message for odds of 0', () => {
    render(
      <LogPropSheet
        edge={makeEdge(0)}
        onClose={onClose}
        onLogged={onLogged}
        onDuplicate={onDuplicate}
      />,
    );

    expect(
      screen.getByText(/odds must be.*100.*or below.*100.*and up/i),
    ).toBeDefined();
  });

  it('shows the out-of-range error message for odds of 50', () => {
    render(
      <LogPropSheet
        edge={makeEdge(50)}
        onClose={onClose}
        onLogged={onLogged}
        onDuplicate={onDuplicate}
      />,
    );

    expect(
      screen.getByText(/odds must be.*100.*or below.*100.*and up/i),
    ).toBeDefined();
  });
});

// ─── Impossible odds: Log Bet button is disabled ─────────────────────────────

describe('LogPropSheet — impossible odds disable the Log Bet button', () => {
  it('marks the Log Bet button aria-disabled for odds of 0', () => {
    render(
      <LogPropSheet
        edge={makeEdge(0)}
        onClose={onClose}
        onLogged={onLogged}
        onDuplicate={onDuplicate}
      />,
    );

    const btn = screen.getByLabelText('Log bet');
    expect(btn.getAttribute('aria-disabled')).toBe('true');
  });

  it('does not call the mutation when the disabled Log Bet button is tapped with odds of 0', async () => {
    render(
      <LogPropSheet
        edge={makeEdge(0)}
        onClose={onClose}
        onLogged={onLogged}
        onDuplicate={onDuplicate}
      />,
    );

    const btn = screen.getByLabelText('Log bet');
    // fireEvent bypasses pointer-events: none (same as a raw OS tap landing on
    // a visually-inert element); the disabled Pressable's onPress must still be
    // blocked, so the mutation must not fire.
    fireEvent.click(btn);

    expect(createBetMutate).not.toHaveBeenCalled();
  });
});

// ─── Valid boundary odds must still pass ─────────────────────────────────────

describe('LogPropSheet — valid boundary odds allow submission', () => {
  it('does not show the out-of-range error for odds of -110', () => {
    render(
      <LogPropSheet
        edge={makeEdge(-110)}
        onClose={onClose}
        onLogged={onLogged}
        onDuplicate={onDuplicate}
      />,
    );

    expect(
      screen.queryByText(/odds must be.*100.*or below.*100.*and up/i),
    ).toBeNull();
  });

  it('does not disable the Log Bet button for odds of 110', () => {
    render(
      <LogPropSheet
        edge={makeEdge(110)}
        onClose={onClose}
        onLogged={onLogged}
        onDuplicate={onDuplicate}
      />,
    );

    const btn = screen.getByLabelText('Log bet');
    expect(btn.getAttribute('aria-disabled')).not.toBe('true');
  });

  it('calls the mutation when Enter is pressed with valid odds of 110', async () => {
    render(
      <LogPropSheet
        edge={makeEdge(110)}
        onClose={onClose}
        onLogged={onLogged}
        onDuplicate={onDuplicate}
      />,
    );

    const unitsInput = screen.getByLabelText('Units');
    await user.click(unitsInput);
    await user.keyboard('{Enter}');

    expect(createBetMutate).toHaveBeenCalledOnce();
  });
});
