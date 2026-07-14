// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { DashboardSummary } from '@workspace/api-client-react';

/**
 * Locks in the ledger card's "no green zero before results" rule on the
 * mobile Bet Log screen: the all-time P&L and ROI tiles must stay muted
 * (with the "awaiting results" hint) until there is realized settled stake —
 * keyed off summary.totalUnits > 0, NOT the W-L-P count. This covers the API
 * edge case where a bet is settled but its pnl is still null (totalUnits 0):
 * an unmuted "+0.00u / 0%" must never render next to a non-zero record.
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

// The shared UI kit pulls in reanimated; replace StatTile with a probe that
// serializes the exact props under test (tone / muted / hint) into text.
vi.mock('@/components/ui', () => ({
  Badge: ({ label }: { label: string }) => <span>{label}</span>,
  Card: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  EmptyState: () => null,
  ErrorState: () => null,
  ScreenHeader: () => null,
  SectionHeader: ({ title }: { title: string }) => <div>{title}</div>,
  Skeleton: () => null,
  StatTile: ({
    label,
    value,
    tone,
    muted,
    hint,
  }: {
    label: string;
    value: string;
    tone?: string;
    muted?: boolean;
    hint?: string;
  }) => (
    <div>{`${label}|${value}|tone:${tone ?? 'none'}|muted:${muted ? 'yes' : 'no'}|hint:${hint ?? '-'}`}</div>
  ),
}));

// The screen's summary hook is swapped per test via this holder.
let summaryData: DashboardSummary | undefined;

vi.mock('@workspace/api-client-react', () => ({
  useListBets: () => ({
    data: [],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    isRefetching: false,
  }),
  useGetDashboardSummary: () => ({
    data: summaryData,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    isRefetching: false,
  }),
  useListSports: () => ({ data: [] }),
  useUpdateBet: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteBet: () => ({ mutate: vi.fn(), isPending: false }),
  useRestoreBet: () => ({ mutate: vi.fn(), isPending: false }),
  getListBetsQueryKey: () => ['bets'],
  getGetDashboardSummaryQueryKey: () => ['dashboard-summary'],
}));

import BetsScreen from '../app/(tabs)/bets';

function makeSummary(overrides: Partial<DashboardSummary>): DashboardSummary {
  return {
    totalBets: 3,
    won: 0,
    lost: 0,
    push: 0,
    pending: 3,
    totalUnits: 0,
    totalPnl: 0,
    roiPercent: 0,
    avgClvPercent: null,
    clvSampleSize: 0,
    bySport: [],
    ...overrides,
  };
}

function tile(label: string): string {
  const el = screen.getByText(new RegExp(`^${label}\\|`));
  return el.textContent ?? '';
}

// No vitest globals, so testing-library's auto-cleanup never registers —
// unmount explicitly or renders leak across tests.
afterEach(cleanup);

describe('Bet Log ledger card — realized-stake muting', () => {
  it('mutes P&L and ROI with the awaiting-results hint when nothing is settled', () => {
    summaryData = makeSummary({});
    render(<BetsScreen />);

    expect(tile('Total P&L')).toBe('Total P&L|0.00u|tone:none|muted:yes|hint:awaiting results');
    expect(tile('ROI')).toBe('ROI|0.00%|tone:none|muted:yes|hint:on settled stake');
    expect(tile('Settled Stake')).toContain('muted:yes');
  });

  it('stays muted when bets are settled but no stake is realized (pnl still null)', () => {
    // API edge case: W-L-P is non-zero but totalUnits (settled stake with a
    // real pnl) is 0 — the exact "green zero next to a 2-1-0 record" trap.
    summaryData = makeSummary({ won: 2, lost: 1, pending: 0 });
    render(<BetsScreen />);

    expect(screen.getByText(/^Record\|2-1-0\|/).textContent).toContain('muted:no');
    expect(tile('Total P&L')).toContain('tone:none');
    expect(tile('Total P&L')).toContain('muted:yes');
    expect(tile('Total P&L')).toContain('hint:awaiting results');
    expect(tile('ROI')).toContain('tone:none');
    expect(tile('ROI')).toContain('muted:yes');
  });

  it('shows unmuted green P&L and ROI once realized stake is positive', () => {
    summaryData = makeSummary({
      won: 2,
      lost: 1,
      pending: 0,
      totalUnits: 3,
      totalPnl: 1.85,
      roiPercent: 61.7,
    });
    render(<BetsScreen />);

    expect(tile('Total P&L')).toBe('Total P&L|+1.85u|tone:pos|muted:no|hint:all bets, any filter');
    expect(tile('ROI')).toBe('ROI|+61.70%|tone:pos|muted:no|hint:on settled stake');
  });

  it('shows unmuted red P&L and ROI for a losing realized ledger', () => {
    summaryData = makeSummary({
      won: 0,
      lost: 3,
      pending: 0,
      totalUnits: 3,
      totalPnl: -3,
      roiPercent: -100,
    });
    render(<BetsScreen />);

    expect(tile('Total P&L')).toContain('tone:neg');
    expect(tile('Total P&L')).toContain('muted:no');
    expect(tile('ROI')).toContain('tone:neg');
    expect(tile('ROI')).toContain('muted:no');
  });

  it('keeps a realized break-even ledger neutral (no tone) but unmuted', () => {
    summaryData = makeSummary({
      won: 1,
      lost: 1,
      pending: 0,
      totalUnits: 2,
      totalPnl: 0,
      roiPercent: 0,
    });
    render(<BetsScreen />);

    expect(tile('Total P&L')).toContain('tone:none');
    expect(tile('Total P&L')).toContain('muted:no');
    expect(tile('ROI')).toContain('tone:none');
    expect(tile('ROI')).toContain('muted:no');
  });
});
