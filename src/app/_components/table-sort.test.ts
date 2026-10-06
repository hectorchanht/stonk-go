import { describe, expect, it } from "vitest";

import {
  compareSortValues,
  resolveSortToggle,
  sortRows,
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
