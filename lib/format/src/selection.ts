/**
 * Bet-log selection label shared by web and mobile: player props log as
 * "Aaron Judge Over 1.5"-style "<player> <selection>", while game-level edges
 * (no player) keep the raw selection. The server's duplicate-open-bet guard
 * keys off this string, so both surfaces must build it identically.
 *
 * Structurally typed so any edge-like object (e.g. the generated
 * EdgeOpportunity) can be passed without this package depending on the API
 * client.
 */
export const propSelectionLabel = (edge: {
  player?: string | null;
  selection: string;
}): string => (edge.player ? `${edge.player} ${edge.selection}` : edge.selection);
