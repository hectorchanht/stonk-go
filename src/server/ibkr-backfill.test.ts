import { describe, expect, it, vi } from "vitest";

import type { AppDb } from "./d1db";
import {
  addDaysYmd,
  nextBackfillWindow,
  runBackfillWindow,
} from "./ibkr-backfill";

describe("addDaysYmd", () => {
  it("subtracts days across year boundaries", () => {
    expect(addDaysYmd("20261008", -365)).toBe("20251008");
    expect(addDaysYmd("20250101", -1)).toBe("20241231");
    expect(addDaysYmd("20200101", -1)).toBe("20191231");
  });
});

describe("nextBackfillWindow", () => {
  it("tiles exactly 365-day windows backward", () => {
    const w = nextBackfillWindow("20251008")!;
    expect(w).toEqual({ fd: "20241008", td: "20251008" });
    const w2 = nextBackfillWindow(w.fd)!;
    expect(w2).toEqual({ fd: "20231009", td: "20241008" });
  });

  it("returns null at the floor", () => {
    // fd would land before 2000-01-01 -> nothing more to fetch.
    expect(nextBackfillWindow("20001230")).toBeNull();
    expect(nextBackfillWindow("20000101")).toBeNull();
    // A window ending exactly on the floor is still fetched.
    expect(nextBackfillWindow("20001231")).toEqual({
      fd: "20000101",
      td: "20001231",
    });
  });
});

function fakeDb(state: {
  oldestCovered?: string;
  emptyStreak?: number;
  doneAt?: Date | null;
} | null) {
  let row = state
    ? {
        id: "bf1",
        userId: "u1",
        oldestCovered: state.oldestCovered ?? "20251008",
        emptyStreak: state.emptyStreak ?? 0,
        doneAt: state.doneAt ?? null,
        updatedAt: new Date(),
      }
    : null;
  const histRows: unknown[] = [];
  const db = {
    brokerBackfill: {      findUnique: vi.fn(async () => row),
      upsert: vi.fn(async (args: never) => {
        const a = args as {
          where: { userId: string };
          update: { oldestCovered: string; emptyStreak: number; doneAt?: Date | null };
          create: { userId: string; oldestCovered: string };
        };
        row = {
          id: row?.id ?? "bf1",
          userId: a.where.userId,
          oldestCovered: a.update.oldestCovered,
          emptyStreak: a.update.emptyStreak,
          doneAt: a.update.doneAt ?? null,
          updatedAt: new Date(),
        };
        return row;
      }),
    },
    brokerCashFlowHistory: {
      findMany: vi.fn(async () => []),
      deleteWindow: vi.fn(async () => {
        histRows.length = 0;
        return { count: 0 };
      }),
      createMany: vi.fn(async (args: { data: unknown[] }) => {
        histRows.push(...args.data);
        return { count: args.data.length };
      }),
    },
  } as unknown as AppDb;
  return { db, getRow: () => row };
}

const trade = (tradeDate: string) => ({
  accountId: "a1",
  symbol: "AAPL",
  description: null,
  assetCategory: "STK",
  currency: "USD",
  tradeDate,
  quantity: 10,
  tradePrice: 100,
  proceeds: null,
  commission: 1,
  realizedPnl: null,
  openClose: "O",
  transactionType: "ExchTrade",
  transactionId: `id-${tradeDate}`,
});

describe("runBackfillWindow", () => {
  it("fetches the window before the oldest covered date and advances the cursor", async () => {
    const { db, getRow } = fakeDb({ oldestCovered: "20251008" });
    const fetchWindow = vi.fn(async () => ({
      positions: [],
      trades: [trade("20250601")],
      cashFlows: [],
      generatedAt: null,
    }));
    const mergeTrades = vi.fn(async () => ({ imported: 1 }) as never);

    const progress = await runBackfillWindow(
      db,
      { userId: "u1", token: "t", queryId: "q", positions: [] },
      { fetchWindow: fetchWindow as never, mergeTrades: mergeTrades as never },
    );

    expect(fetchWindow).toHaveBeenCalledTimes(1);
    const [, , fd, td] = fetchWindow.mock.calls[0] as unknown as string[];
    expect(fd).toBe("20241008");
    expect(td).toBe("20251008");
    expect(mergeTrades).toHaveBeenCalledTimes(1);
    expect(getRow()?.oldestCovered).toBe("20241008");
    expect(getRow()?.emptyStreak).toBe(0);
    expect(progress.done).toBe(false);
    expect(progress.tradesFetched).toBe(1);
  });

  it("initializes the cursor at today-365d on first run", async () => {
    const { db } = fakeDb(null);
    const fetchWindow = vi.fn(async () => ({
      positions: [],
      trades: [],
      cashFlows: [],
      generatedAt: null,
    }));
    await runBackfillWindow(
      db,
      { userId: "u1", token: "t", queryId: "q", positions: [] },
      {
        fetchWindow: fetchWindow as never,
        mergeTrades: vi.fn(async () => ({}) as never),
        today: () => "20261008",
      },
    );
    const [, , fd, td] = fetchWindow.mock.calls[0] as unknown as string[];
    expect(td).toBe("20251008");
    expect(fd).toBe("20241008");
  });

  it("marks done after three consecutive empty windows", async () => {
    const { db, getRow } = fakeDb({ oldestCovered: "20251008", emptyStreak: 2 });
    const fetchWindow = vi.fn(async () => ({
      positions: [],
      trades: [],
      cashFlows: [],
      generatedAt: null,
    }));
    const mergeTrades = vi.fn();
    const progress = await runBackfillWindow(
      db,
      { userId: "u1", token: "t", queryId: "q", positions: [] },
      { fetchWindow: fetchWindow as never, mergeTrades: mergeTrades as never },
    );
    expect(progress.done).toBe(true);
    expect(getRow()?.doneAt).not.toBeNull();
    expect(mergeTrades).not.toHaveBeenCalled();
  });

  it("a non-empty window resets the empty streak", async () => {
    const { db, getRow } = fakeDb({ oldestCovered: "20251008", emptyStreak: 2 });
    const fetchWindow = vi.fn(async () => ({
      positions: [],
      trades: [trade("20240101")],
      cashFlows: [],
      generatedAt: null,
    }));
    const progress = await runBackfillWindow(
      db,
      { userId: "u1", token: "t", queryId: "q", positions: [] },
      {
        fetchWindow: fetchWindow as never,
        mergeTrades: vi.fn(async () => ({}) as never),
      },
    );
    expect(progress.done).toBe(false);
    expect(getRow()?.emptyStreak).toBe(0);
  });

  it("skips work when already done", async () => {
    const { db } = fakeDb({ oldestCovered: "20100101", doneAt: new Date() });
    const fetchWindow = vi.fn();
    const progress = await runBackfillWindow(
      db,
      { userId: "u1", token: "t", queryId: "q", positions: [] },
      { fetchWindow: fetchWindow as never },
    );
    expect(progress.done).toBe(true);
    expect(fetchWindow).not.toHaveBeenCalled();
  });

  it("stores the window's cash flows to history (delete-then-insert)", async () => {
    const { db } = fakeDb({ oldestCovered: "20251008" });
    const cashFlow = {
      accountId: "a1",
      symbol: "AAPL",
      description: "Dividend",
      currency: "USD",
      dateTime: "20250615",
      amount: 12.5,
      type: "Dividends",
    };
    const fetchWindow = vi.fn(async () => ({
      positions: [],
      trades: [],
      cashFlows: [cashFlow],
      generatedAt: null,
    }));
    const hist = db.brokerCashFlowHistory;
    const progress = await runBackfillWindow(
      db,
      { userId: "u1", token: "t", queryId: "q", positions: [] },
      {
        fetchWindow: fetchWindow as never,
        mergeTrades: vi.fn(async () => ({}) as never),
      },
    );
    expect(hist.deleteWindow).toHaveBeenCalledWith("u1", "20241008", "20251008");
    expect(hist.createMany).toHaveBeenCalledTimes(1);
    const data = (hist.createMany as ReturnType<typeof vi.fn>).mock.calls[0]![0].data;
    expect(data).toHaveLength(1);
    expect(data[0]!).toMatchObject({ userId: "u1", amount: 12.5, type: "Dividends" });
    expect(progress.cashFlowsStored).toBe(1);
    expect(progress.done).toBe(false); // non-empty: streak reset
  });

  it("reports a fetch failure without throwing or advancing the cursor", async () => {
    const { db, getRow } = fakeDb({ oldestCovered: "20251008" });
    const fetchWindow = vi.fn(async () => {
      throw new Error("IBKR Flex error 1018");
    });
    const before = getRow()?.oldestCovered;
    const progress = await runBackfillWindow(
      db,
      { userId: "u1", token: "t", queryId: "q", positions: [] },
      { fetchWindow: fetchWindow as never },
    );
    expect(progress.error).toContain("1018");
    expect(progress.done).toBe(false);
    expect(getRow()?.oldestCovered).toBe(before);
  });
});
