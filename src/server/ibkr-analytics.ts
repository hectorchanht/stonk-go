import type { BrokerCashFlowRow, BrokerTradeRow } from "~/server/d1db";
import { inferCurrency, getFxRates, toUsd } from "~/server/market";

export type TradeLike = Pick<
  BrokerTradeRow,
  | "id"
  | "symbol"
  | "tradeDate"
  | "quantity"
  | "tradePrice"
  | "commission"
  | "realizedPnl"
  | "openClose"
  | "currency"
>;

export type CashFlowLike = Pick<
  BrokerCashFlowRow,
  "id" | "type" | "symbol" | "dateTime" | "amount" | "currency"
>;

/** Pure analytics over synced IBKR records. Shared by `analytics` and transient `sync`. */
export async function computeAnalytics(
  trades: TradeLike[],
  cashFlows: CashFlowLike[],
) {
  const fx = await getFxRates();
  // Convert each amount to USD before summing — never mix HKD and USD raw.
  const toUsdSafe = (v: number | null, currency: string | null | undefined) =>
    v == null ? 0 : toUsd(v, currency ?? inferCurrency(""), fx);
  const sumFx = (
    items: Array<{ v: number | null; c: string | null | undefined }>,
  ) => items.reduce<number>((a, x) => a + toUsdSafe(x.v, x.c), 0);

  const realizedPnl = sumFx(
    trades.map((t) => ({
      v: t.realizedPnl,
      c: t.currency ?? inferCurrency(t.symbol),
    })),
  );
  const commissions = sumFx(
    trades.map((t) => ({
      v: t.commission ? Math.abs(t.commission) : 0,
      c: t.currency ?? inferCurrency(t.symbol),
    })),
  );
  const hasRealized = trades.some((t) => t.realizedPnl != null);

  const dividends = sumFx(
    cashFlows
      .filter((c) => /dividend/i.test(c.type))
      .map((c) => ({ v: c.amount, c: c.currency })),
  );
  const withholding = sumFx(
    cashFlows
      .filter((c) => /withholding/i.test(c.type))
      .map((c) => ({ v: c.amount, c: c.currency })),
  );

  const bySymbol = new Map<
    string,
    {
      symbol: string;
      trades: number;
      realizedPnl: number;
      commissions: number;
      qty: number;
      currency: string | null;
    }
  >();
  for (const t of trades) {
    const e = bySymbol.get(t.symbol) ?? {
      symbol: t.symbol,
      trades: 0,
      realizedPnl: 0,
      commissions: 0,
      qty: 0,
      currency: null,
    };
    e.trades += 1;
    e.realizedPnl += t.realizedPnl ?? 0;
    e.commissions += t.commission ? Math.abs(t.commission) : 0;
    e.qty += t.quantity;
    // Native currency of the trades (e.g. HKD for HKEX stocks). A symbol
    // should only ever trade in one currency; first one wins. Falls back to
    // the exchange region (numeric = HKEX = HKD) when IBKR didn't report one.
    if (e.currency == null) e.currency = t.currency ?? inferCurrency(t.symbol);
    bySymbol.set(t.symbol, e);
  }
  const symbols = [...bySymbol.values()].sort(
    (a, b) => Math.abs(b.realizedPnl) - Math.abs(a.realizedPnl),
  );

  return {
    totals: {
      trades: trades.length,
      realizedPnl: hasRealized ? realizedPnl : null,
      commissions,
      dividends,
      withholding,
    },
    symbols,
    recentTrades: trades.slice(0, 20).map((t) => ({
      id: t.id,
      symbol: t.symbol,
      tradeDate: t.tradeDate,
      quantity: t.quantity,
      tradePrice: t.tradePrice,
      commission: t.commission,
      realizedPnl: t.realizedPnl,
      openClose: t.openClose,
      currency: t.currency ?? inferCurrency(t.symbol),
    })),
    recentCashFlows: cashFlows.slice(0, 20).map((c) => ({
      id: c.id,
      type: c.type,
      symbol: c.symbol,
      dateTime: c.dateTime,
      amount: c.amount,
      currency: c.currency,
    })),
  };
}
