import { useMemo, useState, useCallback } from "react";

export type SortDir = "asc" | "desc";
export type ColumnType = "text" | "number" | "date";

export interface SortColumn<T> {
  key: string;
  type?: ColumnType;
  /**
   * Pulls the sortable value out of a row. Return null for "no value" — those
   * rows sink to the bottom in both directions, so a book that never quoted a
   * price can't outrank one that did.
   */
  accessor: (row: T) => unknown;
}

export interface SortState {
  key: string | null;
  dir: SortDir;
}

function toComparable(value: unknown, type: ColumnType): number | string | null {
  if (value == null || value === "") return null;
  if (type === "number") {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isNaN(n) ? null : n;
  }
  if (type === "date") {
    const t = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
    return Number.isNaN(t) ? null : t;
  }
  return String(value).toLowerCase();
}

/**
 * Next sort state when a column is clicked: ascending, then descending, then
 * back to the table's natural order. That third state matters because the
 * server already returns edges ranked by EV and confidence, so "no sort" is a
 * meaningful view worth being able to return to without a reload.
 */
export function nextSortState(current: SortState, key: string): SortState {
  if (current.key !== key) return { key, dir: "asc" };
  if (current.dir === "asc") return { key, dir: "desc" };
  return { key: null, dir: "asc" };
}

export function sortRows<T>(rows: T[], columns: SortColumn<T>[], sort: SortState): T[] {
  if (!sort.key) return rows;
  const col = columns.find((c) => c.key === sort.key);
  if (!col) return rows;
  const type = col.type ?? "text";
  const dir = sort.dir === "asc" ? 1 : -1;

  // Copy first: the source array is React Query cache data and must not be
  // sorted in place.
  return [...rows].sort((a, b) => {
    const av = toComparable(col.accessor(a), type);
    const bv = toComparable(col.accessor(b), type);
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
}

/** Click-to-sort state plus the sorted rows. */
export function useTableSort<T>(rows: T[], columns: SortColumn<T>[]) {
  // Key and direction live in one state object so a click derives both from a
  // single snapshot; updating them separately lets a StrictMode double-invoke
  // advance the direction twice per click.
  const [sort, setSort] = useState<SortState>({ key: null, dir: "asc" });

  const toggleSort = useCallback((key: string) => {
    setSort((current: SortState) => nextSortState(current, key));
  }, []);

  const sorted = useMemo(() => sortRows(rows, columns, sort), [rows, columns, sort]);

  return { rows: sorted, sortKey: sort.key, sortDir: sort.dir, toggleSort };
}
