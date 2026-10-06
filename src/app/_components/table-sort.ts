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

/* ---------------- search + column filters ---------------- */

/** Structural subset of DataColumn needed for search/filter (no React types). */
export interface FilterableColumn<T> {
  key: string;
  /** Text matched by the toolbar search box (case-insensitive substring). */
  searchValue?: (row: T) => string;
  /** Categorical value for the toolbar's filter dropdown for this column. */
  filterValue?: (row: T) => string | null | undefined;
  /** Explicit filter options; when omitted they are derived from the rows. */
  filterOptions?: { value: string; label: string }[];
}

export interface FilterOption {
  value: string;
  label: string;
  count: number;
}

/** Case-insensitive substring match across every column with a searchValue. */
export function matchesSearch<T>(
  row: T,
  columns: FilterableColumn<T>[],
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return columns.some((c) => {
    if (!c.searchValue) return false;
    let v: string;
    try {
      v = c.searchValue(row);
    } catch {
      return false;
    }
    return typeof v === "string" && v.toLowerCase().includes(q);
  });
}

/** Every active column filter must match (AND). Unknown keys are ignored. */
export function matchesFilters<T>(
  row: T,
  columns: FilterableColumn<T>[],
  filters: Record<string, string>,
): boolean {
  for (const [key, selected] of Object.entries(filters)) {
    if (!selected) continue; // "" = All
    const col = columns.find((c) => c.key === key);
    if (!col?.filterValue) continue;
    let v: string | null | undefined;
    try {
      v = col.filterValue(row);
    } catch {
      return false;
    }
    if ((v ?? "") !== selected) return false;
  }
  return true;
}

/** Search + column filters, applied together. Never mutates the input. */
export function applyTableFilters<T>(
  rows: T[],
  columns: FilterableColumn<T>[],
  search: string,
  filters: Record<string, string>,
): T[] {
  const q = search.trim();
  const hasFilters = Object.values(filters).some((v) => v !== "");
  if (!q && !hasFilters) return rows;
  return rows.filter(
    (r) => matchesSearch(r, columns, q) && matchesFilters(r, columns, filters),
  );
}

/**
 * Build dropdown options for every filterable column from the full row
 * list. Explicit filterOptions win; otherwise unique filterValue results
 * become options, sorted by count desc then label asc, with per-option
 * counts. Null/empty values are grouped under "—".
 */
export function deriveFilterOptions<T>(
  rows: T[],
  columns: FilterableColumn<T>[],
): Record<string, FilterOption[]> {
  const out: Record<string, FilterOption[]> = {};
  for (const col of columns) {
    if (!col.filterValue && !col.filterOptions) continue;
    if (col.filterOptions) {
      const counts = new Map<string, number>();
      if (col.filterValue) {
        for (const r of rows) {
          let v: string | null | undefined;
          try {
            v = col.filterValue(r);
          } catch {
            continue;
          }
          const key = v ?? "";
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      out[col.key] = col.filterOptions.map((o) => ({
        value: o.value,
        label: o.label,
        count: counts.get(o.value) ?? 0,
      }));
      continue;
    }
    const counts = new Map<string, number>();
    for (const r of rows) {
      let v: string | null | undefined;
      try {
        v = col.filterValue!(r);
      } catch {
        continue;
      }
      const key = v ?? "";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    out[col.key] = [...counts.entries()]
      .map(([value, count]) => ({
        value,
        label: value === "" ? "—" : value,
        count,
      }))
      .sort(
        (a, b) => b.count - a.count || a.label.localeCompare(b.label),
      );
  }
  return out;
}
