import { describe, expect, it } from "vitest";

import {
  HOLDINGS_ALL_COLUMNS,
  HOLDINGS_COLUMNS_KEY,
  HOLDINGS_DEFAULT_COLUMNS,
  isHoldingColumnKey,
  parseStoredColumns,
  toggleColumnKey,
} from "./holdings-columns";

describe("holdings column model", () => {
  it("defaults to every optional column on, including Cost", () => {
    expect(HOLDINGS_DEFAULT_COLUMNS).toContain("cost");
    expect(HOLDINGS_DEFAULT_COLUMNS).toHaveLength(HOLDINGS_ALL_COLUMNS.length);
    expect(HOLDINGS_COLUMNS_KEY).toBe("holdr.holdings.columns");
  });

  it("accepts a valid persisted selection", () => {
    expect(parseStoredColumns('["qty","cost","weight"]')).toEqual([
      "qty",
      "cost",
      "weight",
    ]);
  });

  it("drops unknown keys but keeps the valid ones", () => {
    expect(parseStoredColumns('["qty","nope","weight"]')).toEqual([
      "qty",
      "weight",
    ]);
  });

  it("falls back to null on absent, corrupt, or empty selections", () => {
    expect(parseStoredColumns(null)).toBeNull();
    expect(parseStoredColumns("")).toBeNull();
    expect(parseStoredColumns("not json")).toBeNull();
    expect(parseStoredColumns('{"qty":true}')).toBeNull();
    expect(parseStoredColumns("[]")).toBeNull();
    expect(parseStoredColumns('["nope"]')).toBeNull();
  });

  it("isHoldingColumnKey guards the key space", () => {
    expect(isHoldingColumnKey("cost")).toBe(true);
    expect(isHoldingColumnKey("symbol")).toBe(false);
    expect(isHoldingColumnKey(42)).toBe(false);
    expect(isHoldingColumnKey(null)).toBe(false);
  });
});

describe("toggleColumnKey", () => {
  it("removes a visible column", () => {
    expect(toggleColumnKey(["qty", "cost", "weight"], "cost")).toEqual([
      "qty",
      "weight",
    ]);
  });

  it("re-inserts a hidden column in canonical order, not at the end", () => {
    expect(toggleColumnKey(["qty", "weight"], "cost")).toEqual([
      "qty",
      "cost",
      "weight",
    ]);
    expect(toggleColumnKey(["weight"], "qty")).toEqual(["qty", "weight"]);
  });

  it("refuses to uncheck the last visible column", () => {
    expect(toggleColumnKey(["cost"], "cost")).toEqual(["cost"]);
  });
});
