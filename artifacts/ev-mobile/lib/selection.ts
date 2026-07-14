import type { EdgeOpportunity } from '@workspace/api-client-react';

/**
 * Bet-log selection label matching the web convention: player props log as
 * "Aaron Judge Over 1.5"-style "<player> <selection>", while game-level edges
 * (no player) keep the raw selection. The server's duplicate-open-bet guard
 * keys off this string, so web and mobile must build it identically.
 */
export const propSelectionLabel = (edge: EdgeOpportunity): string =>
  edge.player ? `${edge.player} ${edge.selection}` : edge.selection;
