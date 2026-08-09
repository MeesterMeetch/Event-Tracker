import type { EdgeOpportunity } from "@workspace/api-client-react";
import type { CsvColumn } from "./csv";

/**
 * The CSV shape of a scanner edge, shared by every board that shows them.
 *
 * Generic over the row so the same definitions serve a bare edge on Live Edges
 * and Player Props, and a Top Play that wraps one. Without that the column list
 * gets copied per page and drifts, which for an export is a quiet failure: the
 * files simply stop lining up when you pile them into one sheet.
 */
export function edgeColumns<T>(
  getEdge: (row: T) => EdgeOpportunity,
  scannedAt?: string,
): CsvColumn<T>[] {
  const e = getEdge;
  const columns: CsvColumn<T>[] = [
    { header: "evPercent", value: (r) => e(r).evPercent },
    { header: "confidenceTier", value: (r) => e(r).confidenceTier },
    { header: "confidenceScore", value: (r) => e(r).confidenceScore },
    { header: "book", value: (r) => e(r).book },
    { header: "americanOdds", value: (r) => e(r).americanOdds },
    { header: "dkOdds", value: (r) => e(r).dkOdds },
    { header: "fairOdds", value: (r) => e(r).fairOdds },
    { header: "marketProb", value: (r) => e(r).marketProb },
    { header: "sharpProb", value: (r) => e(r).sharpProb },
    { header: "publicProb", value: (r) => e(r).publicProb },
    { header: "dispersionPercent", value: (r) => e(r).dispersionPercent },
    { header: "bookCount", value: (r) => e(r).bookCount },
    { header: "sport", value: (r) => e(r).sport },
    { header: "market", value: (r) => e(r).market },
    { header: "player", value: (r) => e(r).player },
    { header: "selection", value: (r) => e(r).selection },
    { header: "point", value: (r) => e(r).point },
    { header: "awayTeam", value: (r) => e(r).awayTeam },
    { header: "homeTeam", value: (r) => e(r).homeTeam },
    { header: "commenceTime", value: (r) => e(r).commenceTime },
    { header: "gameId", value: (r) => e(r).gameId },
    { header: "confidenceReasons", value: (r) => e(r).confidenceReasons.join("; ") },
  ];

  // Stamped onto every row rather than a header line, so the file stays a clean
  // import and can still say when it was taken. These prices move in minutes.
  if (scannedAt != null) columns.push({ header: "scannedAt", value: () => scannedAt });
  return columns;
}
