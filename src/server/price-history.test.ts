import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppDb } from "./d1db";
import { getPriceHistory } from "./price-history";

const { mockGetDailyCloses } = vi.hoisted(() => ({
  mockGetDailyCloses: vi.fn(),
}));

vi.mock("~/server/yahoo", () => ({
  getDailyCloses: mockGetDailyCloses,
}));

function fakeDb(
  rows: Array<{ date: string; close: string; adjclose: string | null }>,
  opts: { throwOnRead?: Error } = {},
) {
  const calls = { findMany: 0, deleteMany: 0, createMany: 0 };
  const db = {
    yahooDailyBar: {
      findMany: async () => {
        calls.findMany++;
        if (opts.throwOnRead) throw opts.throwOnRead;
        return rows.map((r) => ({
          symbol: "AAPL",
          fetchedAt: new Date(),
          ...r,
        }));
      },
      deleteMany: async () => {
        calls.deleteMany++;
        return { count: 0 };
      },
      createMany: async () => {
        calls.createMany++;
        return { count: 1 };
      },
    },
  } as unknown as AppDb;
  return { db, calls };
}

const bar = (date: string, close: number) => ({ date, close, adjclose: null });

describe("getPriceHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("cold: fetches the whole range from Yahoo and persists it", async () => {
    const { db, calls } = fakeDb([]);
    mockGetDailyCloses.mockResolvedValue([bar("2024-01-08", 100)]);
    const res = await getPriceHistory(db, "AAPL", "2024-01-08", "2024-01-10");
    expect(res.cached).toBe(true);
    expect(res.bars).toHaveLength(1);
    expect(mockGetDailyCloses).toHaveBeenCalledTimes(1);
    expect(calls.deleteMany).toBe(1);
    expect(calls.createMany).toBe(1);
  });

  it("warm: re-fetches the recent window and backfills the prefix gap", async () => {
    const { db } = fakeDb([
      { date: "2024-01-05", close: "99", adjclose: null },
    ]);
    mockGetDailyCloses
      .mockResolvedValueOnce([bar("2024-01-08", 100)]) // refresh window
      .mockResolvedValueOnce([bar("2024-01-02", 98)]); // backfill prefix
    const res = await getPriceHistory(db, "aapl", "2024-01-02", "2024-01-10");
    expect(mockGetDailyCloses).toHaveBeenCalledTimes(2);
    expect(res.bars.map((b) => b.date)).toEqual([
      "2024-01-02",
      "2024-01-05",
      "2024-01-08",
    ]);
  });

  it("missing table: direct Yahoo fetch, no crash, no writes", async () => {
    const { db, calls } = fakeDb([], {
      throwOnRead: new Error("D1_ERROR: no such table: YahooDailyBar"),
    });
    mockGetDailyCloses.mockResolvedValue([bar("2024-01-08", 100)]);
    const res = await getPriceHistory(db, "AAPL", "2024-01-08", "2024-01-10");
    expect(res.cached).toBe(false);
    expect(res.bars).toHaveLength(1);
    expect(calls.deleteMany).toBe(0);
    expect(calls.createMany).toBe(0);
  });

  it("propagates Yahoo failures so the caller can fall back", async () => {
    const { db } = fakeDb([]);
    mockGetDailyCloses.mockRejectedValue(new Error("yahoo 429"));
    await expect(
      getPriceHistory(db, "AAPL", "2024-01-08", "2024-01-10"),
    ).rejects.toThrow("yahoo 429");
  });
});
