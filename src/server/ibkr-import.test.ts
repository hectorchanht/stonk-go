import { describe, expect, it } from "vitest";

import { recomputeHolding, mergeCurveLegs } from "./ibkr-import";
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
