import { describe, expect, it } from 'vitest';
import type { EdgeOpportunity } from '@workspace/api-client-react';

import { propSelectionLabel } from './selection';

/**
 * The bet-log selection label is the string the server's duplicate-open-bet
 * guard keys off, so mobile must build it exactly like the web app does:
 * "<player> <selection>" for props, raw selection for game-level edges.
 */

function makeEdge(overrides: Partial<EdgeOpportunity>): EdgeOpportunity {
  return {
    sport: 'baseball_mlb',
    gameId: 'g1',
    commenceTime: '2026-07-14T23:10:00Z',
    homeTeam: 'NYY',
    awayTeam: 'BOS',
    market: 'batter_home_runs',
    selection: 'Over',
    point: 0.5,
    americanOdds: 320,
    fairOdds: 290,
    evPercent: 4.2,
    book: 'fanduel',
    player: 'Aaron Judge',
    ...overrides,
  } as EdgeOpportunity;
}

describe('propSelectionLabel', () => {
  it('prefixes the player name for player props', () => {
    expect(propSelectionLabel(makeEdge({ player: 'Aaron Judge', selection: 'Over' }))).toBe(
      'Aaron Judge Over',
    );
  });

  it('falls back to the raw selection when there is no player', () => {
    expect(propSelectionLabel(makeEdge({ player: null, selection: 'NYY -1.5' }))).toBe('NYY -1.5');
    expect(propSelectionLabel(makeEdge({ player: undefined, selection: 'Under' }))).toBe('Under');
  });
});
