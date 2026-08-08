/**
 * CSV export for the scan boards.
 *
 * Client side on purpose. A scan is already paid for by the time it is on
 * screen, so serialising what is in memory costs nothing, while an export
 * endpoint would re-run the fan-out and bill for data you already have.
 */

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | boolean | null | undefined;
}

/**
 * Escapes one field.
 *
 * Team names and rationales contain commas and the occasional quote, and a
 * naive join produces a file that opens misaligned and is worse than no export
 * at all. RFC 4180: wrap in quotes when the value contains a comma, quote,
 * newline or carriage return, and double any embedded quotes.
 */
function escapeField(value: string | number | boolean | null | undefined): string {
  if (value == null) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const head = columns.map((c) => escapeField(c.header)).join(",");
  const body = rows.map((row) => columns.map((c) => escapeField(c.value(row))).join(","));
  // Trailing newline: some tools treat a file without one as truncated.
  return [head, ...body].join("\r\n") + "\r\n";
}

/**
 * A filename that sorts chronologically in a folder listing and says what the
 * file is without being opened.
 */
export function csvFilename(prefix: string, at: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}`;
  return `${prefix}-${stamp}.csv`;
}

/**
 * Triggers a browser download. Separated from `toCsv` so the serialisation is
 * testable without a DOM.
 */
export function downloadCsv(filename: string, csv: string): void {
  // The BOM is what makes Excel open a UTF-8 CSV without mangling accented
  // names. Numbers and dates are unaffected.
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
