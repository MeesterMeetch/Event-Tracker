// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
 * Rendering behaviour for impossible odds (task #131):
 *   - The log button is visually *disabled* (opacity reduced, slash icon).
 *   - Its accessible label changes from "Log paper trade" to the out-of-range
 *     explanation so screen-reader users know why the button is inert.
 *   - The button carries accessibilityState.disabled = true (→ aria-disabled).
 *   - Clicking (or tapping) a disabled button never fires the mutation.
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

// Partial text that the disabled button's accessible label begins with.
const DISABLED_LABEL_PREFIX = 'Cannot log';

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

// ─── Disabled-button state for impossible prices ────────────────────────────

describe('ProjectionCard log button — disabled state for impossible prices', () => {
  it('shows a disabled button (not "Log paper trade") for odds of 0', () => {
    render(<ProjectionCard projection={makeProjection(0)} />);

    // The normal idle label must be absent — the row should not look tappable.
    expect(screen.queryByLabelText('Log paper trade')).toBeNull();

    // A button whose label begins with "Cannot log" must exist instead.
    const btn = screen.getByLabelText(new RegExp(DISABLED_LABEL_PREFIX));
    expect(btn).toBeDefined();
  });

  it('marks the button aria-disabled for odds of 0', () => {
    render(<ProjectionCard projection={makeProjection(0)} />);

    const btn = screen.getByLabelText(new RegExp(DISABLED_LABEL_PREFIX));
    // react-native-web maps accessibilityState.disabled → aria-disabled="true"
    expect(btn.getAttribute('aria-disabled')).toBe('true');
  });

  it('never fires the mutation when the disabled button is activated for odds of 0', () => {
    render(<ProjectionCard projection={makeProjection(0)} />);

    // fireEvent bypasses pointer-events:none (same as a raw OS tap landing on
    // a visually-inert element) — the disabled Pressable's onPress must still
    // be blocked, so the mutation must not fire.
    const btn = screen.getByLabelText(new RegExp(DISABLED_LABEL_PREFIX));
    fireEvent.click(btn);

    expect(createPaperTradeMutate).not.toHaveBeenCalled();
  });

  it('shows a disabled button for odds of 50 (inside the forbidden open interval (0, 100))', () => {
    render(<ProjectionCard projection={makeProjection(50)} />);

    expect(screen.queryByLabelText('Log paper trade')).toBeNull();
    expect(screen.getByLabelText(new RegExp(DISABLED_LABEL_PREFIX))).toBeDefined();
  });

  it('marks the button aria-disabled for odds of 50', () => {
    render(<ProjectionCard projection={makeProjection(50)} />);

    const btn = screen.getByLabelText(new RegExp(DISABLED_LABEL_PREFIX));
    expect(btn.getAttribute('aria-disabled')).toBe('true');
  });

  it('never fires the mutation for odds of 50 even if the button is activated', () => {
    render(<ProjectionCard projection={makeProjection(50)} />);

    const btn = screen.getByLabelText(new RegExp(DISABLED_LABEL_PREFIX));
    fireEvent.click(btn);

    expect(createPaperTradeMutate).not.toHaveBeenCalled();
  });

  it('shows a disabled button for odds of -50 (inside the forbidden open interval (-100, 0))', () => {
    render(<ProjectionCard projection={makeProjection(-50)} />);

    expect(screen.queryByLabelText('Log paper trade')).toBeNull();
    expect(screen.getByLabelText(new RegExp(DISABLED_LABEL_PREFIX))).toBeDefined();
  });

  it('marks the button aria-disabled for odds of -50', () => {
    render(<ProjectionCard projection={makeProjection(-50)} />);

    const btn = screen.getByLabelText(new RegExp(DISABLED_LABEL_PREFIX));
    expect(btn.getAttribute('aria-disabled')).toBe('true');
  });

  it('never fires the mutation for odds of -50 even if the button is activated', () => {
    render(<ProjectionCard projection={makeProjection(-50)} />);

    const btn = screen.getByLabelText(new RegExp(DISABLED_LABEL_PREFIX));
    fireEvent.click(btn);

    expect(createPaperTradeMutate).not.toHaveBeenCalled();
  });
});

// ─── Valid boundary prices — button must remain enabled ─────────────────────

describe('ProjectionCard log button — valid prices at and beyond the boundary', () => {
  it('accepts odds of -100 (exact lower boundary): button is tappable and mutation fires', async () => {
    // -100 is the outermost valid negative American odds; the forbidden zone is
    // the open interval (-100, 100), so the edge itself must be allowed through.
    render(<ProjectionCard projection={makeProjection(-100)} />);

    const btn = screen.getByLabelText('Log paper trade');
    expect(btn.getAttribute('aria-disabled')).not.toBe('true');

    await user.click(btn);

    expect(createPaperTradeMutate).toHaveBeenCalledTimes(1);
  });

  it('accepts odds of 100 (exact upper boundary): button is tappable and mutation fires', async () => {
    // +100 is the outermost valid positive American odds; the forbidden zone is
    // the open interval (-100, 100), so the edge itself must be allowed through.
    render(<ProjectionCard projection={makeProjection(100)} />);

    const btn = screen.getByLabelText('Log paper trade');
    expect(btn.getAttribute('aria-disabled')).not.toBe('true');

    await user.click(btn);

    expect(createPaperTradeMutate).toHaveBeenCalledTimes(1);
  });

  it('accepts a canonical valid price -110: button is tappable and mutation fires', async () => {
    render(<ProjectionCard projection={makeProjection(-110)} />);

    const btn = screen.getByLabelText('Log paper trade');
    expect(btn.getAttribute('aria-disabled')).not.toBe('true');

    await user.click(btn);

    expect(createPaperTradeMutate).toHaveBeenCalledTimes(1);
  });
});
