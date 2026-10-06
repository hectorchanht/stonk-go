/**
 * Pure table-sorting primitives shared by every sortable list in the app.
 * Kept in a .ts module (no JSX) so vitest can import it under the repo's
 * `"jsx": "preserve"` tsconfig — .tsx component files can't be unit-tested
 * directly. ui.tsx re-exports these for the DataTable/useTableSort layer.
 */

export type SortDir = 1 | -1;

export interface TableSortState {
  key: string;
  dir: SortDir;
}

/** Structural subset of DataColumn needed for sorting (no React types). */
export interface SortableColumn<T> {
  key: string;
  sortValue?: (row: T) => string | number | bigint | null | undefined;
  /** Direction used the first time this column is clicked. Default: descending. */
  sortDescFirst?: boolean;
}

export type SortValue = string | number | bigint | null | undefined;

function isNullish(v: unknown): boolean {
  return v == null || (typeof v === "number" && Number.isNaN(v));
}

/**
 * Compare two raw sort values. Null/undefined/NaN always sort last,
 * regardless of direction. Numbers and bigints compare numerically,
 * everything else compares as strings.
 */
export function compareSortValues(a: SortValue, b: SortValue): number {
  const aNull = isNullish(a);
  const bNull = isNullish(b);
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  const aNum = typeof a === "number" || typeof a === "bigint";
  const bNum = typeof b === "number" || typeof b === "bigint";
  if (aNum && bNum) {
    // bigint/number mixing: compare via BigInt-safe path when either is bigint.
    if (typeof a === "bigint" || typeof b === "bigint") {
      try {
        const ab = typeof a === "bigint" ? a : BigInt(Math.trunc(a));
        const bb = typeof b === "bigint" ? b : BigInt(Math.trunc(b));
        return ab < bb ? -1 : ab > bb ? 1 : 0;
      } catch {
        return Number(a) - Number(b);
      }
    }
    return a - b;
  }
  return String(a).localeCompare(String(b));
}

/**
 * Stable view-only sort: ties keep their original order, so sorting never
 * shuffles equal rows. Null/undefined/NaN always sort last in either
 * direction. Never mutates the input array or the rows.
 */
export function sortRows<T>(
  rows: T[],
  sortValue: (row: T) => SortValue,
  dir: SortDir,
): T[] {
  return rows
    .map((r, i) => ({ r, i, v: sortValue(r) }))
    .sort((x, y) => {
      const aNull = isNullish(x.v);
      const bNull = isNullish(y.v);
      if (aNull && bNull) return x.i - y.i;
      if (aNull) return 1;
      if (bNull) return -1;
      const cmp = compareSortValues(x.v, y.v) * dir;
      return cmp === 0 ? x.i - y.i : cmp;
    })
    .map(({ r }) => r);
}

/**
 * Pure next-state for a header click: same column toggles direction,
 * new column starts at its preferred direction (descending by default,
 * ascending when the column opts out via sortDescFirst: false).
 * Non-sortable columns leave state unchanged.
 */
export function resolveSortToggle<T>(
  prev: TableSortState | null,
  key: string,
  columns: SortableColumn<T>[],
): TableSortState | null {
  const col = columns.find((c) => c.key === key);
  if (!col?.sortValue) return prev;
  if (prev?.key === key) {
    return { key, dir: prev.dir === 1 ? -1 : 1 };
  }
  return { key, dir: col.sortDescFirst === false ? 1 : -1 };
}
