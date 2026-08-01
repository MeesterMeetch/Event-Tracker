import { describe, expect, it } from 'vitest';

import { propSelectionLabel } from './selection';

/**
 * The bet-log selection label is the string the server's duplicate-open-bet
 * guard keys off, so web and mobile must build it exactly the same way:
 * "<player> <selection>" for props, raw selection for game-level edges.
 * (The helper is structurally typed, so these plain objects stand in for the
 * generated EdgeOpportunity shape.)
 */

describe('propSelectionLabel', () => {
  it('prefixes the player name for player props', () => {
    expect(propSelectionLabel({ player: 'Aaron Judge', selection: 'Over' })).toBe(
      'Aaron Judge Over',
    );
  });

  it('falls back to the raw selection when there is no player', () => {
    expect(propSelectionLabel({ player: null, selection: 'NYY -1.5' })).toBe('NYY -1.5');
    expect(propSelectionLabel({ player: undefined, selection: 'Under' })).toBe('Under');
    expect(propSelectionLabel({ selection: 'Under' })).toBe('Under');
  });
});
