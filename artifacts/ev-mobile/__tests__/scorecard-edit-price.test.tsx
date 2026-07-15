// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PaperTrade } from '@workspace/api-client-react';

/**
 * Locks in the mobile scorecard's correct-price flow (EditTradeSheet),
 * mirroring the web EditPaperTradeDialog: the shared isValidAmericanOdds rule
 * rejects impossible prices with the same inline message as the web dialog
 * (shown only after a save attempt), a valid correction PATCHes only
 * americanOdds, and the success feedback mentions the CLV recompute exactly
 * when a closing line was already captured. Rendered through react-native-web
 * (aliased in vitest.config.ts) so no Expo/Metro runtime is needed.
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

// The shared UI kit pulls in reanimated; the sheet under test needs none of it.
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
};

// Swapped per test between the happy path and a server rejection.
let updateImpl: (vars: { id: number; data: { americanOdds: number } }, opts?: MutateOpts) => void =
  (_vars, opts) => opts?.onSuccess?.(undefined);
const updateMutate = vi.fn(
  (vars: { id: number; data: { americanOdds: number } }, opts?: MutateOpts) =>
    updateImpl(vars, opts),
);

vi.mock('@workspace/api-client-react', () => ({
  useListPaperTrades: () => ({ data: [], refetch: vi.fn() }),
  useGetPaperTradeSummary: () => ({
    data: undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    isRefetching: false,
  }),
  useDeletePaperTrade: () => ({ mutate: vi.fn(), isPending: false }),
  useRestorePaperTrade: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdatePaperTrade: () => ({ mutate: updateMutate, isPending: false }),
  getListPaperTradesQueryKey: () => ['paper-trades'],
  getGetPaperTradeSummaryQueryKey: () => ['paper-trade-summary'],
}));

import { EditTradeSheet, TradeRow } from '../app/(tabs)/scorecard';

function makeTrade(overrides: Partial<PaperTrade> = {}): PaperTrade {
  return {
    id: 7,
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

// Must match the web EditPaperTradeDialog's inline error text exactly.
const inlineError = 'Odds must be -100 or below, or +100 and up (e.g. -110).';

const user = userEvent.setup();

let onClose: ReturnType<typeof vi.fn<() => void>>;
let onSaved: ReturnType<typeof vi.fn<(message: string) => void>>;
beforeEach(() => {
  onClose = vi.fn<() => void>();
  onSaved = vi.fn<(message: string) => void>();
  updateImpl = (_vars, opts) => opts?.onSuccess?.(undefined);
  updateMutate.mockClear();
  invalidateQueries.mockClear();
});

// No vitest globals, so testing-library's auto-cleanup never registers —
// unmount explicitly or renders leak across tests.
afterEach(cleanup);

/** Type text into the odds field (clears first) without clicking Save. */
async function typeOdds(text: string) {
  const input = screen.getByLabelText('American odds');
  await user.clear(input);
  await user.type(input, text);
}

/** Type valid odds into the field then click the (enabled) Save button. */
async function typeOddsAndSave(text: string) {
  await typeOdds(text);
  await user.click(screen.getByLabelText('Save price'));
}

describe('EditTradeSheet price correction', () => {
  it('shows the inline error immediately for impossible prices — no save attempt needed', async () => {
    render(<EditTradeSheet trade={makeTrade()} onClose={onClose} onSaved={onSaved} />);

    // Starting value (-110) is valid: no error initially.
    expect(screen.queryByText(inlineError)).toBeNull();

    await typeOdds('-50');

    // Error appears as soon as the value becomes invalid, without clicking Save.
    expect(screen.getByText(inlineError)).toBeDefined();
    expect(updateMutate).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Save button is disabled for impossible prices and re-enabled when corrected', async () => {
    render(<EditTradeSheet trade={makeTrade()} onClose={onClose} onSaved={onSaved} />);

    const btn = screen.getByLabelText('Save price');

    // Starting value -110 is valid: button must be enabled.
    expect(btn.getAttribute('aria-disabled')).not.toBe('true');

    // Type an impossible price: button becomes disabled.
    await typeOdds('-50');
    expect(btn.getAttribute('aria-disabled')).toBe('true');

    // Correct to a valid price: button becomes enabled again.
    await typeOdds('-110');
    expect(btn.getAttribute('aria-disabled')).not.toBe('true');
  });

  it('correcting an impossible price to a valid one clears the inline error', async () => {
    render(<EditTradeSheet trade={makeTrade()} onClose={onClose} onSaved={onSaved} />);

    await typeOdds('-50');
    expect(screen.getByText(inlineError)).toBeDefined();

    // Appending '0' makes the field '-500', a valid American odds price.
    await user.type(screen.getByLabelText('American odds'), '0');
    expect(screen.queryByText(inlineError)).toBeNull();
  });

  it('PATCHes only the corrected price and refreshes the scorecard queries', async () => {
    render(<EditTradeSheet trade={makeTrade()} onClose={onClose} onSaved={onSaved} />);

    await typeOddsAndSave('-125');

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0][0]).toEqual({ id: 7, data: { americanOdds: -125 } });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['paper-trades'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['paper-trade-summary'] });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('success message stays quiet about CLV when no close was captured', async () => {
    render(<EditTradeSheet trade={makeTrade()} onClose={onClose} onSaved={onSaved} />);

    await typeOddsAndSave('-125');

    expect(onSaved).toHaveBeenCalledTimes(1);
    const message = onSaved.mock.calls[0][0];
    expect(message).toContain('Gerrit Cole Over 6.5K is now -125');
    expect(message).not.toMatch(/CLV/);
  });

  it('success message mentions the CLV recompute when a close was already captured', async () => {
    render(
      <EditTradeSheet
        trade={makeTrade({ status: 'closed', closingOdds: -130, clvPercent: 2.1 })}
        onClose={onClose}
        onSaved={onSaved}
      />,
    );

    await typeOddsAndSave('+105');

    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved.mock.calls[0][0]).toBe(
      'Gerrit Cole Over 6.5K is now +105 — CLV recomputed against the captured close',
    );
  });

  it('pressing Enter with an impossible price does not call the update mutation and keeps the inline error visible', async () => {
    render(<EditTradeSheet trade={makeTrade()} onClose={onClose} onSaved={onSaved} />);

    const input = screen.getByLabelText('American odds');

    // Type an impossible price (inside the -100..+100 dead zone) then press Enter.
    await user.clear(input);
    await user.type(input, '50');
    await user.keyboard('{Enter}');

    // The early-return guard in save() must have fired — no mutation call.
    expect(updateMutate).not.toHaveBeenCalled();

    // The inline validation message must still be visible.
    expect(screen.getByText(inlineError)).toBeDefined();
  });

  it('surfaces the server rejection inline instead of closing the sheet', async () => {
    updateImpl = (_vars, opts) =>
      opts?.onError?.({ data: { error: 'American odds cannot be between -99 and +99.' } });
    render(<EditTradeSheet trade={makeTrade()} onClose={onClose} onSaved={onSaved} />);

    await typeOddsAndSave('-115');

    expect(screen.getByText('American odds cannot be between -99 and +99.')).toBeDefined();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('TradeRow edit affordance', () => {
  it('exposes a labelled edit-price button that opens the sheet', async () => {
    const onEdit = vi.fn<() => void>();
    render(
      <TradeRow trade={makeTrade()} onEdit={onEdit} onDelete={vi.fn()} deleting={false} />,
    );

    await user.click(screen.getByLabelText('Edit price for pick Gerrit Cole Over 6.5'));

    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});
