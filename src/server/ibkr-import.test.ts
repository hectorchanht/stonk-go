import { describe, expect, it } from "vitest";

import { recomputeHolding, mergeCurveLegs, importIbkrTrades } from "./ibkr-import";
import type { AppDb } from "./d1db";

interface Txn {
  id: string;
  symbol: string;
  type: string;
  quantity: number;
  price: number;
  fees: number | null;
  executedAt: Date;
  externalId: string | null;
}

function mockDb(allTxns: Txn[]) {
  const state = {
    deleted: [] as unknown[],
    upserted: null as null | {
      update: { quantity: number; avgCost: number };
      create: { symbol: string; quantity: number; avgCost: number };
    },
  };
  const db = {
    transaction: {
      findMany: async (args: { where: { symbol: string } }) =>
        allTxns.filter((t) => t.symbol === args.where.symbol),
    },
    holding: {
      deleteMany: async (args: unknown) => {
        state.deleted.push(args);
      },
      upsert: async (args: {
        update: { quantity: number; avgCost: number };
        create: { symbol: string; quantity: number; avgCost: number };
      }) => {
        state.upserted = { update: args.update, create: args.create };
        return args.create;
      },
    },
  };
  return { db: db as unknown as AppDb, state };
}

const txn = (
  symbol: string,
  type: string,
  quantity: number,
  price: number,
  fees: number | null = 0,
): Txn => ({
  id: `${symbol}-${type}-${quantity}`,
  symbol,
  type,
  quantity,
  price,
  fees,
  executedAt: new Date("2026-01-01T12:00:00Z"),
  externalId: null,
});

describe("recomputeHolding average-cost basis", () => {
  it("folds buy price and fees into avgCost", async () => {
    const { db, state } = mockDb([txn("AAPL", "BUY", 10, 100, 10)]);
    await recomputeHolding(db, "AAPL");
    expect(state.deleted).toHaveLength(0);
    // (10 × 100 + 10) / 10 = 101
    expect(state.upserted!.create.quantity).toBe(10);
    expect(state.upserted!.create.avgCost).toBeCloseTo(101, 10);
  });

  it("reduces cost basis proportionally on sells (average-cost method)", async () => {
    const { db, state } = mockDb([
      txn("AAPL", "BUY", 10, 100, 10),
      txn("AAPL", "SELL", 4, 150, 0),
    ]);
    await recomputeHolding(db, "AAPL");
    // costBasis 1010 − 1010 × 0.4 = 606; avgCost stays 101
    expect(state.upserted!.create.quantity).toBe(6);
    expect(state.upserted!.create.avgCost).toBeCloseTo(101, 10);
    expect(state.upserted!.create.quantity * state.upserted!.create.avgCost).toBeCloseTo(
      606,
      8,
    );
  });

  it("deletes the holding when everything is sold", async () => {
    const { db, state } = mockDb([
      txn("AAPL", "BUY", 5, 10),
      txn("AAPL", "SELL", 5, 12),
    ]);
    await recomputeHolding(db, "AAPL");
    expect(state.deleted).toHaveLength(1);
    expect(state.upserted).toBeNull();
  });

  it("throws on oversell (sell exceeds logged holding)", async () => {
    const { db } = mockDb([txn("AAPL", "BUY", 2, 10), txn("AAPL", "SELL", 3, 10)]);
    await expect(recomputeHolding(db, "AAPL")).rejects.toThrow(/Cannot sell/);
  });

  it("per-position costs reconcile to the portfolio total", async () => {
    // AAPL: 10 @ 100 → cost 1000. MSFT: 5 @ 50 + 5 fees → cost 255.
    const txns = [txn("AAPL", "BUY", 10, 100), txn("MSFT", "BUY", 5, 50, 5)];
    const totals = new Map<string, number>();
    for (const symbol of ["AAPL", "MSFT"]) {
      const { db, state } = mockDb(txns);
      await recomputeHolding(db, symbol);
      totals.set(
        symbol,
        state.upserted!.create.quantity * state.upserted!.create.avgCost,
      );
    }
    const sum = [...totals.values()].reduce((a, b) => a + b, 0);
    // Same reduce the portfolio summary totals use over row costBasis.
    expect(sum).toBeCloseTo(1255, 8);
  });
});

describe("mergeCurveLegs", () => {
  const txn = (
    symbol: string,
    type: string,
    quantity: number,
    price: number,
    date: string,
  ) => ({
    symbol,
    type,
    quantity,
    price,
    fees: null,
    executedAt: new Date(`${date}T12:00:00Z`),
    source: "ibkr",
  });
  const flex = (
    symbol: string,
    tradeDate: string,
    quantity: number,
    tradePrice: number | null,
  ) => ({ symbol, tradeDate, quantity, tradePrice, commission: null });

  it("prefers the Transaction log for covered symbols (split safety)", () => {
    // NAKA: log has the split-adjusted buy; Flex still has the pre-split row.
    const { legs, stats } = mergeCurveLegs(
      [txn("NAKA", "BUY", 34.017, 12.2, "2026-02-06")],
      [
        flex("NAKA", "20251003", 500, 1.11),
        flex("NAKA", "20260206", 34.017, 12.2),
      ],
    );
    expect(legs).toHaveLength(1);
    expect(legs[0]!.quantity).toBeCloseTo(34.017, 6);
    expect(stats.fromTransactions).toBe(1);
    expect(stats.fromBrokerTrades).toBe(0);
    expect(stats.symbolsCoveredByLog).toBe(1);
  });

  it("contributes raw Flex trades for symbols missing from the log", () => {
    const { legs, stats } = mergeCurveLegs(
      [txn("CIFR", "BUY", 88, 16.65, "2026-01-27")],
      [
        flex("GDRX", "20251003", 111, 4.5),
        flex("MRVL", "20251003", 3, 86.34),
        flex("GDRX", "20251101", -11, 5.0),
      ],
    );
    // 1 log leg + 3 flex legs, sorted by date
    expect(legs).toHaveLength(4);
    expect(stats.fromTransactions).toBe(1);
    expect(stats.fromBrokerTrades).toBe(3);
    const gdrxSell = legs.find(
      (l) => l.symbol === "GDRX" && l.type === "SELL",
    )!;
    expect(gdrxSell.quantity).toBe(11);
    expect(gdrxSell.source).toBe("ibkr");
    expect(legs[0]!.executedAt.toISOString().slice(0, 10)).toBe("2025-10-03");
  });

  it("skips FX conversions, zero qty, null prices and bad dates", () => {
    const { legs, stats } = mergeCurveLegs([], [
      flex("USD.HKD", "20251003", 1000, 7.8),
      flex("AAA", "20251003", 0, 10),
      flex("BBB", "20251003", 5, null),
      flex("CCC", "not-a-date", 5, 10),
      flex("DDD", "20251003", 5, -3),
    ]);
    expect(legs).toHaveLength(0);
    expect(stats.unusableSkipped).toBe(4); // USD.HKD filtered before counting
  });
});

describe("mergeCurveLegs opening balances", () => {
  const flex = (
    symbol: string,
    tradeDate: string,
    quantity: number,
    tradePrice: number | null,
  ) => ({ symbol, tradeDate, quantity, tradePrice, commission: null });
  const pos = (symbol: string, quantity: number, costBasisPrice: number | null) => ({
    symbol,
    quantity,
    costBasisPrice,
  });

  it("anchors positions with no Flex trades at broker cost (window start)", () => {
    // NVDA: bought before the Flex window, 3 shares @ $187.72 real cost.
    const { legs, stats } = mergeCurveLegs([], [flex("GDRX", "20251003", 111, 4.5)], [
      pos("NVDA", 3, 187.72),
    ]);
    const nvda = legs.filter((l) => l.symbol === "NVDA");
    expect(nvda).toHaveLength(1);
    expect(nvda[0]).toMatchObject({
      type: "BUY",
      quantity: 3,
      price: 187.72,
      source: "ibkr",
    });
    expect(nvda[0]!.executedAt.toISOString().slice(0, 10)).toBe("2025-10-03");
    expect(stats.openingBalances).toBe(1);
  });

  it("adds pre-window remainder + in-window trades for partials (NTLA)", () => {
    // NTLA: position 98, Flex net -40 (sold 98, bought 58 in-window).
    const { legs, stats } = mergeCurveLegs(
      [],
      [flex("NTLA", "20251014", 58, 10), flex("NTLA", "20251020", -98, 12)],
      [pos("NTLA", 98, 11)],
    );
    const ntla = legs.filter((l) => l.symbol === "NTLA");
    // opening 138 @ 11 + buy 58 + sell 98 = final 98, never negative
    expect(ntla).toHaveLength(3);
    expect(ntla[0]).toMatchObject({ type: "BUY", quantity: 138, price: 11 });
    let qty = 0;
    for (const l of ntla) qty += l.type === "BUY" ? l.quantity : -l.quantity;
    expect(qty).toBe(98);
    expect(stats.openingBalances).toBe(1);
    expect(stats.fromBrokerTrades).toBe(2);
  });

  it("uses pure cost anchor when a split scrambles quantities (NVX)", () => {
    // NVX: position 69, Flex net 698.1 (reverse split) — raw trades unusable.
    const { legs, stats } = mergeCurveLegs(
      [],
      [flex("NVX", "20251003", 698.1, 1)],
      [pos("NVX", 69, 10.46)],
    );
    const nvx = legs.filter((l) => l.symbol === "NVX");
    expect(nvx).toHaveLength(1);
    expect(nvx[0]).toMatchObject({ type: "BUY", quantity: 69, price: 10.46 });
    expect(stats.openingBalances).toBe(1);
    expect(stats.fromBrokerTrades).toBe(0);
  });

  it("never lets a symbol go negative mid-history", () => {
    const { legs } = mergeCurveLegs(
      [],
      [flex("NTLA", "20251014", 58, 10), flex("NTLA", "20251020", -98, 12)],
      [pos("NTLA", 98, 11)],
    );
    let qty = 0;
    for (const l of legs.filter((x) => x.symbol === "NTLA")) {
      qty += l.type === "BUY" ? l.quantity : -l.quantity;
      expect(qty).toBeGreaterThanOrEqual(0);
    }
  });

  it("skips opening when the broker reports no cost basis", () => {
    const { legs, stats } = mergeCurveLegs([], [], [pos("XYZ", 10, null)]);
    expect(legs.filter((l) => l.symbol === "XYZ")).toHaveLength(0);
    expect(stats.noCostBasis).toBe(1);
  });

  it("round-trips Flex symbols with no current position (AAPL sold off)", () => {
    const { legs, stats } = mergeCurveLegs(
      [],
      [flex("AAPL", "20251003", 2, 258.6), flex("AAPL", "20260123", -2, 249.3)],
      [],
    );
    expect(legs).toHaveLength(2);
    expect(stats.fromBrokerTrades).toBe(2);
    expect(stats.openingBalances).toBe(0);
  });
});

describe("importIbkrTrades tombstones (deleted trades stay deleted)", () => {
  interface Stone {
    symbol: string;
    type: string;
    quantity: number;
    price: number;
    executedAt: Date;
    externalId: string | null;
  }
  function importDb(stones: Stone[]) {
    const inserted: unknown[] = [];
    const db = {
      deletedTransaction: {
        findMany: async () => stones,
      },
      transaction: {
        findMany: async () => [],
        create: async (args: { data: unknown }) => {
          inserted.push(args.data);
          return args.data;
        },
        delete: async () => ({}),
      },
      holding: {
        deleteMany: async () => ({}),
        upsert: async (args: { create: unknown }) => args.create,
      },
    };
    return { db: db as unknown as AppDb, inserted };
  }
  const trade = (over: Record<string, unknown> = {}) => ({
    symbol: "AAPL",
    tradeDate: "20260105",
    quantity: 10,
    tradePrice: 150,
    commission: 1,
    transactionId: "txn-1",
    ...over,
  });

  it("skips a trade whose externalId was tombstoned", async () => {
    const { db, inserted } = importDb([
      {
        symbol: "AAPL",
        type: "BUY",
        quantity: 10,
        price: 150,
        executedAt: new Date("2026-01-05T12:00:00Z"),
        externalId: "ibkr:txn-1",
      },
    ]);
    const stats = await importIbkrTrades(db, [trade()], []);
    expect(inserted).toHaveLength(0);
    expect(stats.imported).toBe(0);
    expect(stats.duplicatesSkipped).toBe(1);
  });

  it("skips a manually-deleted trade that matches by fields (no externalId)", async () => {
    const { db, inserted } = importDb([
      {
        symbol: "AAPL",
        type: "BUY",
        quantity: 10,
        price: 150,
        executedAt: new Date("2026-01-05T12:00:00Z"),
        externalId: null,
      },
    ]);
    // Different IBKR transaction id, same economics — must not resurrect.
    const stats = await importIbkrTrades(db, [trade({ transactionId: "txn-9" })], []);
    expect(inserted).toHaveLength(0);
    expect(stats.imported).toBe(0);
    expect(stats.duplicatesSkipped).toBe(1);
  });

  it("still imports a trade that was never deleted", async () => {
    const { db, inserted } = importDb([]);
    const stats = await importIbkrTrades(db, [trade()], []);
    expect(inserted).toHaveLength(1);
    expect(stats.imported).toBe(1);
  });
});
