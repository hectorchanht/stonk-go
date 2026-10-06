import { describe, expect, it } from "vitest";

import {
  applyTableFilters,
  compareSortValues,
  deriveFilterOptions,
  matchesFilters,
  matchesSearch,
  resolveSortToggle,
  sortRows,
  type FilterableColumn,
  type SortableColumn,
} from "./table-sort";

describe("compareSortValues", () => {
  it("compares numbers numerically", () => {
    expect(compareSortValues(2, 10)).toBeLessThan(0);
    expect(compareSortValues(10, 2)).toBeGreaterThan(0);
    expect(compareSortValues(5, 5)).toBe(0);
    expect(compareSortValues(-3, 2)).toBeLessThan(0);
  });

  it("compares numeric strings as strings (callers pass numbers for numeric sort)", () => {
    // "10" < "9" lexicographically — sortValue must return numbers for qty-like fields.
    expect(compareSortValues("10", "9")).toBeLessThan(0);
    expect(compareSortValues("9", "10")).toBeGreaterThan(0);
  });

  it("compares strings alphabetically", () => {
    expect(compareSortValues("AAPL", "MSFT")).toBeLessThan(0);
    expect(compareSortValues("MSFT", "AAPL")).toBeGreaterThan(0);
    expect(compareSortValues("AAPL", "AAPL")).toBe(0);
  });

  it("sorts null, undefined and NaN last", () => {
    expect(compareSortValues(null, 5)).toBeGreaterThan(0);
    expect(compareSortValues(5, null)).toBeLessThan(0);
    expect(compareSortValues(undefined, "a")).toBeGreaterThan(0);
    expect(compareSortValues(Number.NaN, 5)).toBeGreaterThan(0);
    expect(compareSortValues(null, null)).toBe(0);
    expect(compareSortValues(null, undefined)).toBe(0);
  });

  it("compares bigints numerically without throwing", () => {
    expect(compareSortValues(10n, 2n)).toBeGreaterThan(0);
    expect(compareSortValues(2n, 10n)).toBeLessThan(0);
    expect(compareSortValues(5n, 5)).toBe(0);
    expect(compareSortValues(null, 5n)).toBeGreaterThan(0);
  });
});

describe("sortRows", () => {
  const byNum = (r: { v: number | null }) => r.v;
  const byStr = (r: { s: string }) => r.s;

  it("sorts ascending and descending", () => {
    const rows = [{ v: 3 }, { v: 1 }, { v: 2 }];
    expect(sortRows(rows, byNum, 1).map((r) => r.v)).toEqual([1, 2, 3]);
    expect(sortRows(rows, byNum, -1).map((r) => r.v)).toEqual([3, 2, 1]);
  });

  it("keeps nulls last in both directions", () => {
    const rows = [{ v: null }, { v: 3 }, { v: null }, { v: 1 }];
    expect(sortRows(rows, byNum, 1).map((r) => r.v)).toEqual([1, 3, null, null]);
    expect(sortRows(rows, byNum, -1).map((r) => r.v)).toEqual([3, 1, null, null]);
  });

  it("is stable: ties keep original order", () => {
    const rows = [
      { v: 1, id: "a" },
      { v: 1, id: "b" },
      { v: 1, id: "c" },
    ];
    expect(sortRows(rows, byNum, -1).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(sortRows(rows, byNum, 1).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("sorts strings alphabetically and does not mutate input", () => {
    const rows = [{ s: "MSFT" }, { s: "AAPL" }];
    const out = sortRows(rows, byStr, 1);
    expect(out.map((r) => r.s)).toEqual(["AAPL", "MSFT"]);
    expect(rows.map((r) => r.s)).toEqual(["MSFT", "AAPL"]);
  });

  it("handles bigint values (exchange valueCents)", () => {
    const rows = [{ v: 30n }, { v: null }, { v: 10n }];
    const out = sortRows(rows, (r) => r.v, -1);
    expect(out.map((r) => r.v)).toEqual([30n, 10n, null]);
  });
});

describe("resolveSortToggle", () => {
  const cols: SortableColumn<{ a: number; b: string }>[] = [
    { key: "a", sortValue: (r) => r.a },
    {
      key: "b",
      sortValue: (r) => r.b,
      sortDescFirst: false,
    },
    { key: "c" },
  ];

  it("starts a new column at its preferred direction", () => {
    expect(resolveSortToggle(null, "a", cols)).toEqual({ key: "a", dir: -1 });
    expect(resolveSortToggle(null, "b", cols)).toEqual({ key: "b", dir: 1 });
  });

  it("toggles direction when clicking the active column", () => {
    expect(resolveSortToggle({ key: "a", dir: -1 }, "a", cols)).toEqual({
      key: "a",
      dir: 1,
    });
    expect(resolveSortToggle({ key: "a", dir: 1 }, "a", cols)).toEqual({
      key: "a",
      dir: -1,
    });
  });

  it("switching columns resets to the new column's preferred direction", () => {
    expect(resolveSortToggle({ key: "a", dir: 1 }, "b", cols)).toEqual({
      key: "b",
      dir: 1,
    });
  });

  it("leaves state unchanged for non-sortable columns", () => {
    const prev = { key: "a", dir: -1 as const };
    expect(resolveSortToggle(prev, "c", cols)).toBe(prev);
    expect(resolveSortToggle(null, "c", cols)).toBeNull();
    expect(resolveSortToggle(null, "nope", cols)).toBeNull();
  });
});

describe("table search + filters", () => {
  interface Row {
    symbol: string;
    name: string;
    currency: string | null;
    qty: number;
  }
  const rows: Row[] = [
    { symbol: "AAPL", name: "Apple Inc", currency: "USD", qty: 10 },
    { symbol: "0700.HK", name: "Tencent", currency: "HKD", qty: -5 },
    { symbol: "MSFT", name: "Microsoft", currency: "USD", qty: 3 },
    { symbol: "0005.HK", name: "HSBC", currency: null, qty: 100 },
  ];
  const cols: FilterableColumn<Row>[] = [
    {
      key: "symbol",
      searchValue: (r) => `${r.symbol} ${r.name}`,
      filterValue: (r) => (r.symbol.endsWith(".HK") ? "HK" : "US"),
    },
    { key: "qty", filterValue: (r) => (r.qty >= 0 ? "BUY" : "SELL") },
    { key: "currency", filterValue: (r) => r.currency },
  ];

  it("matchesSearch is case-insensitive across searchValue columns", () => {
    expect(matchesSearch(rows[0]!, cols, "aapl")).toBe(true);
    expect(matchesSearch(rows[0]!, cols, "APPLE")).toBe(true);
    expect(matchesSearch(rows[1]!, cols, "tencent")).toBe(true);
    expect(matchesSearch(rows[1]!, cols, "0700")).toBe(true);
    expect(matchesSearch(rows[2]!, cols, "zzz")).toBe(false);
    expect(matchesSearch(rows[0]!, cols, "  ")).toBe(true);
  });

  it("matchesFilters ANDs active filters and ignores unknown keys", () => {
    expect(matchesFilters(rows[0]!, cols, {})).toBe(true);
    expect(matchesFilters(rows[0]!, cols, { symbol: "" })).toBe(true);
    expect(matchesFilters(rows[0]!, cols, { symbol: "US" })).toBe(true);
    expect(matchesFilters(rows[1]!, cols, { symbol: "US" })).toBe(false);
    expect(matchesFilters(rows[0]!, cols, { symbol: "US", qty: "BUY" })).toBe(true);
    expect(matchesFilters(rows[0]!, cols, { symbol: "US", qty: "SELL" })).toBe(false);
    expect(matchesFilters(rows[1]!, cols, { nope: "x" })).toBe(true);
  });

  it("applyTableFilters combines search and filters without mutating", () => {
    const before = [...rows];
    const out = applyTableFilters(rows, cols, "hk", { qty: "BUY" });
    expect(out.map((r) => r.symbol)).toEqual(["0005.HK"]);
    expect(rows).toEqual(before);
    expect(applyTableFilters(rows, cols, "", {})).toBe(rows);
  });

  it("deriveFilterOptions counts values and sorts by count desc", () => {
    const opts = deriveFilterOptions(rows, cols);
    expect(opts.symbol).toEqual([
      { value: "HK", label: "HK", count: 2 },
      { value: "US", label: "US", count: 2 },
    ]);
    expect(opts.qty).toEqual([
      { value: "BUY", label: "BUY", count: 3 },
      { value: "SELL", label: "SELL", count: 1 },
    ]);
    expect(opts.currency).toEqual([
      { value: "USD", label: "USD", count: 2 },
      { value: "", label: "—", count: 1 },
      { value: "HKD", label: "HKD", count: 1 },
    ]);
  });

  it("deriveFilterOptions respects explicit filterOptions", () => {
    const explicit: FilterableColumn<Row>[] = [
      {
        key: "qty",
        filterValue: (r) => (r.qty >= 0 ? "BUY" : "SELL"),
        filterOptions: [
          { value: "BUY", label: "Long" },
          { value: "SELL", label: "Short" },
        ],
      },
    ];
    expect(deriveFilterOptions(rows, explicit).qty).toEqual([
      { value: "BUY", label: "Long", count: 3 },
      { value: "SELL", label: "Short", count: 1 },
    ]);
  });
});
