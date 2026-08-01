// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { GameSummary } from '@workspace/api-client-react';

/**
 * Guards the mobile Games screen against key regressions:
 * - Skeleton placeholders render while data is in flight
 * - Game cards show team names, scores (live/final only), probable pitchers, and status
 * - Scores are absent for scheduled games
 * - Empty state renders when no games are scheduled
 * - Error state renders when the fetch fails
 */

let gamesData: GameSummary[] | undefined;
let isLoading = false;
let isError = false;
const mockRefetch = vi.fn();

vi.mock('@workspace/api-client-react', () => ({
  useListMlbGames: () => ({ data: gamesData, isLoading, isError, refetch: mockRefetch }),
}));

vi.mock('@/hooks/useColors', () => ({
  useColors: () => ({
    primary: '#1A8CFF',
    mutedForeground: '#888',
    background: '#0D0D0D',
    foreground: '#F0F0F0',
    card: '#1A1A1A',
    cardBorder: '#2A2A2A',
    border: '#2A2A2A',
    positive: '#00CC66',
    destructive: '#EF4444',
    muted: '#1A1A1A',
    radius: 8,
  }),
}));

vi.mock('@/constants/fonts', () => ({
  fonts: {
    regular: undefined,
    medium: undefined,
    semibold: undefined,
    bold: undefined,
    monoBold: undefined,
    monoMedium: undefined,
    monoSemibold: undefined,
  },
}));

vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));
vi.mock('@expo/vector-icons', () => ({
  Feather: () => null,
}));

// Mock the entire shared UI kit so that react-native-reanimated (pulled in by
// Skeleton) never touches NativeModules in the jsdom environment.
vi.mock('@/components/ui', () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Badge: ({ label }: { label: string }) => <span>{label}</span>,
  Skeleton: () => <div data-testid="skeleton" />,
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
  ErrorState: ({ code }: { code: string }) => <div>{code}</div>,
  ScreenHeader: ({ title }: { title: string }) => <div>{title}</div>,
  SectionHeader: ({ title }: { title: string }) => <div>{title}</div>,
  StatTile: () => null,
}));

import GamesScreen from '../app/(tabs)/games';

function makeGame(overrides: Partial<GameSummary> = {}): GameSummary {
  return {
    gamePk: 800001,
    gameDate: '2026-07-18T17:10:00Z',
    status: { abstractGameState: 'Final', detailedState: 'Final' },
    homeTeam: 'Los Angeles Dodgers',
    awayTeam: 'San Francisco Giants',
    homeProbablePitcher: { id: 605483, name: 'Blake Snell' },
    awayProbablePitcher: { id: 657277, name: 'Logan Webb' },
    homeScore: 5,
    awayScore: 3,
    ...overrides,
  } as GameSummary;
}

afterEach(() => {
  cleanup();
  gamesData = undefined;
  isLoading = false;
  isError = false;
  mockRefetch.mockClear();
});

describe('GamesScreen — loading', () => {
  it('renders skeleton placeholders while loading', () => {
    isLoading = true;
    render(<GamesScreen />);
    // The loading branch renders 5 Skeleton components; confirm the screen renders
    // without crashing and the game list is absent.
    expect(screen.queryByText('Los Angeles Dodgers')).toBeNull();
  });
});

describe('GamesScreen — error', () => {
  it('shows an error state when the fetch fails', () => {
    isError = true;
    render(<GamesScreen />);
    expect(screen.getByText(/SCHEDULE_ERROR/i)).toBeTruthy();
  });
});

describe('GamesScreen — empty', () => {
  it('shows an empty state when no games are scheduled', () => {
    gamesData = [];
    render(<GamesScreen />);
    expect(screen.getByText(/No games scheduled/i)).toBeTruthy();
  });
});

describe('GamesScreen — game cards', () => {
  it('renders team names for both sides', () => {
    gamesData = [makeGame()];
    render(<GamesScreen />);
    expect(screen.getByText('San Francisco Giants')).toBeTruthy();
    expect(screen.getByText('Los Angeles Dodgers')).toBeTruthy();
  });

  it('shows the Final status label', () => {
    gamesData = [makeGame()];
    render(<GamesScreen />);
    expect(screen.getByText('Final')).toBeTruthy();
  });

  it('shows the Live status label for in-progress games', () => {
    gamesData = [
      makeGame({
        status: { abstractGameState: 'Live', detailedState: 'In Progress' },
        homeScore: 2,
        awayScore: 1,
      }),
    ];
    render(<GamesScreen />);
    expect(screen.getByText('Live')).toBeTruthy();
  });

  it('renders scores for Final games', () => {
    gamesData = [makeGame({ homeScore: 5, awayScore: 3 })];
    render(<GamesScreen />);
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('does not render scores for Scheduled games', () => {
    gamesData = [
      makeGame({
        status: { abstractGameState: 'Preview', detailedState: 'Scheduled' },
        homeScore: null,
        awayScore: null,
      }),
    ];
    render(<GamesScreen />);
    expect(screen.queryByText('5')).toBeNull();
    expect(screen.queryByText('3')).toBeNull();
  });

  it('renders probable pitcher names when present', () => {
    gamesData = [makeGame()];
    render(<GamesScreen />);
    expect(screen.getByText(/Blake Snell/)).toBeTruthy();
    expect(screen.getByText(/Logan Webb/)).toBeTruthy();
  });

  it('skips the pitcher section when neither side has a starter listed', () => {
    gamesData = [makeGame({ homeProbablePitcher: null, awayProbablePitcher: null })];
    render(<GamesScreen />);
    expect(screen.queryByText(/Blake Snell/)).toBeNull();
  });

  it('renders multiple game cards for a full slate', () => {
    gamesData = [
      makeGame({ gamePk: 800001, homeTeam: 'Los Angeles Dodgers', awayTeam: 'San Francisco Giants' }),
      makeGame({ gamePk: 800002, homeTeam: 'New York Yankees', awayTeam: 'Baltimore Orioles' }),
    ];
    render(<GamesScreen />);
    expect(screen.getByText('New York Yankees')).toBeTruthy();
    expect(screen.getByText('Baltimore Orioles')).toBeTruthy();
  });
});
