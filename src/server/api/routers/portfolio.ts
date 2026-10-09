import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  getQuote,
  getQuotes,
  getFxRates,
  toUsd,
  inferCurrency,
  canonicalSymbol,
  type Quote,
} from "~/server/market";
import { createTRPCRouter, protectedProcedure, publicProcedure } from "~/server/api/trpc";
import { xirr as computeXirr } from "~/server/xirr";
import {
  buildInvestedCurve,
  downsamplePoints,
  buildDailyHoldings,
  aggregateDailyValue,
  buildSourcedDailyHoldings,
  aggregateDailyValueBySource,
  bucketMonthly,
  latestBarOnOrBefore,
  utcDay,
  type CashFlow,
  type CurvePoint,
  type MonthCell,
  type PricedDay,
  type PriceBar,
} from "~/server/performance";
import { getPriceHistory } from "~/server/price-history";
import { countBuyStreak, maxDrawdown } from "~/server/hands";
import { computeFlair } from "~/server/wsb";
import { generateInsights } from "~/server/ai";
import {
  importIbkrTrades as mergeIbkrTrades,
  curveTradeLegs,
  recomputeHolding,
} from "~/server/ibkr-import";
import { type AppDb } from "~/server/db";

/**
 * Portfolio domain.
 *
 * The transaction log is the source of truth: every buy/sell (or deletion)
 * recomputes the affected Holding from scratch, so positions can never drift
 * out of sync with the log. IBKR Flex syncs merge their trades into this
 * same log (source="ibkr", see ~/server/ibkr-import.ts) instead of living in
 * a separate display — so a sell in the brokerage updates holdings and cost
 * basis like any hand-logged trade.
 *
 * Live prices are fetched server-side (see ~/server/market.ts) and cached
 * briefly — the client never calls the quote providers directly.
 */

const symbolSchema = z
  .string()
  .trim()
  .min(1)
  .max(16)
  .transform((s) => s.toUpperCase().replace(/\s+/g, ""));

/** Broker positions pushed from the client's IBKR snapshot (never stored). */
const brokerPositionInput = z.object({
  symbol: symbolSchema,
  quantity: z.number(),
  markPrice: z.number().nullable(),
  costBasisPrice: z.number().nullable().optional(),
  /** Source label for the Holdings badge ("IBKR", "COINBASE", "BINANCE"). */
  label: z.string().max(16).nullable().optional(),
  currency: z.string().max(8).optional(),
});

const summaryInput = z.object({
  brokerPositions: z.array(brokerPositionInput).max(500).default([]),
});

const DAY_MS = 86_400_000;

/**
 * Record a tombstone for a transaction BEFORE it is deleted. IBKR auto-sync
 * re-imports any trade whose externalId is missing from the log — without
 * the tombstone the user's delete is silently undone ("restored") on the
 * next sync. Idempotent: re-deleting an already-tombstoned row is a no-op.
 */
async function tombstoneTransaction(
  db: AppDb,
  t: {
    symbol: string;
    type: string;
    quantity: number;
    price: number;
    executedAt: Date | string;
    externalId: string | null;
  },
) {
  const stones = await db.deletedTransaction.findMany();
  if (t.externalId) {
    if (stones.some((s) => s.externalId === t.externalId)) return;
  } else {
    const day = new Date(t.executedAt).toISOString().slice(0, 10);
    if (
      stones.some(
        (s) =>
          s.externalId == null &&
          s.symbol === t.symbol &&
          s.type === t.type &&
          s.quantity === t.quantity &&
          s.price === t.price &&
          new Date(s.executedAt).toISOString().slice(0, 10) === day,
      )
    )
      return;
  }
  await db.deletedTransaction.create({
    data: {
      symbol: t.symbol,
      type: t.type,
      quantity: t.quantity,
      price: t.price,
      executedAt: t.executedAt,
      externalId: t.externalId,
    },
  });
}

/**
 * Trade-log cash flows in a single currency (USD). Trade prices are stored
 * in native currency (HKD for HKEX), while the terminal market value is
 * USD — mixing them corrupts any money-weighted math, so every flow is
 * converted here. Negative = money in (buy), positive = money out.
 */
function txnsToUsdFlows(
  txns: {
    symbol: string;
    type: string;
    quantity: number;
    price: number;
    fees: number | null;
    executedAt: Date | string;
  }[],
  fx: Record<string, number>,
): CashFlow[] {
  return txns.map((t) => {
    const native =
      t.type === "BUY"
        ? -(t.quantity * t.price + (t.fees ?? 0))
        : t.quantity * t.price - (t.fees ?? 0);
    return {
      date: new Date(t.executedAt),
      amount: toUsd(native, inferCurrency(t.symbol), fx),
    };
  });
}

export interface HoldingRow {
  id: string;
  symbol: string;
  name: string | null;
  quantity: number;
  /** Native trading currency (HKD for HKEX, USD otherwise). */
  currency: string;
  /** Null for broker rows when the Flex query lacks the Cost Basis column. */
  avgCost: number | null;
  /** Null for broker rows when the Flex query lacks the Cost Basis column. */
  costBasis: number | null;
  price: number | null;
  marketValue: number | null;
  dayPL: number | null;
  dayChangePct: number | null;
  totalPL: number | null;
  totalPLPct: number | null;
  weightPct: number | null;
  source: "manual" | "broker";
  /** Source label for broker rows ("IBKR", "COINBASE", "BINANCE"); null for manual. */
  brokerLabel: string | null;
}

export interface Summary {
  rows: HoldingRow[];
  totals: {
    costBasis: number;
    marketValue: number;
    dayPL: number | null;
    /** Current value minus total cost. Positions without a recorded cost count as $0. */
    totalPL: number;
    totalPLPct: number | null;
    /** Per-platform snapshot: Manual + each broker/exchange label. */
    byPlatform: Array<{
      platform: string;
      count: number;
      marketValue: number;
      costBasis: number;
      dayPL: number | null;
      totalPL: number;
    }>;
    holdingsCount: number;
    pricedCount: number;
    brokerCount: number;
    /** Broker rows with a market value but no cost basis. */
    brokerMissingBasis: number;
  };
}

function platformOf(r: HoldingRow): string {
  return r.source === "manual" ? "Manual" : (r.brokerLabel ?? "IBKR");
}

/**
 * Map a summary row to its curve-leg source key (lowercase). Must match the
 * source values produced by curveTradeLegs ("ibkr", "manual") so the live
 * side and the history side of a performance comparison cover the same
 * universe.
 */
function legSourceOf(r: HoldingRow): string {
  return r.source === "manual" ? "manual" : (r.brokerLabel ?? "IBKR").toLowerCase();
}

/** Per-platform snapshot totals for the Platforms widget. */
function buildByPlatform(rows: HoldingRow[]) {
  const map = new Map<
    string,
    { count: number; marketValue: number; costBasis: number; dayPL: number }
  >();
  for (const r of rows) {
    const p = platformOf(r);
    const e = map.get(p) ?? { count: 0, marketValue: 0, costBasis: 0, dayPL: 0 };
    e.count += 1;
    e.marketValue += r.marketValue ?? 0;
    e.costBasis += r.costBasis ?? 0;
    e.dayPL += r.dayPL ?? 0;
    map.set(p, e);
  }
  return [...map.entries()]
    .map(([platform, e]) => ({
      platform,
      count: e.count,
      marketValue: e.marketValue,
      costBasis: e.costBasis,
      dayPL: e.dayPL,
      totalPL: e.marketValue - e.costBasis,
    }))
    .sort((a, b) => b.marketValue - a.marketValue);
}

async function buildSummary(
  ctx: { db: AppDb },
  brokerPositions: z.infer<typeof brokerPositionInput>[],
): Promise<Summary> {
  const holdings = await ctx.db.holding.findMany({ orderBy: { symbol: "asc" } });
  // Canonicalized: IBKR reports "700" where a manual entry says "0700.HK".
  const manualSymbols = new Set(holdings.map((h) => canonicalSymbol(h.symbol)));
  // The manual log wins on overlap — the same symbol must never be
  // double-counted in both the manual portfolio and the broker snapshot.
  const broker = brokerPositions.filter(
    (b) => !manualSymbols.has(canonicalSymbol(b.symbol)),
  );

  // Crypto-exchange positions are NEVER priced by the stock quote feed: a
  // delisted Binance token like "SLP" would otherwise pick up the Yahoo price
  // of Simulations Plus (the US stock sharing its ticker), inventing millions
  // in phantom portfolio value. They use the exchange's own markPrice; without
  // one they honestly show as no-price instead of a stranger's stock price.
  const CRYPTO_LABELS = new Set(["BINANCE", "COINBASE", "KRAKEN"]);
  const quotes = await getQuotes([
    ...holdings.map((h) => h.symbol),
    ...broker
      .filter((b) => !CRYPTO_LABELS.has((b.label ?? "").toUpperCase()))
      .map((b) => b.symbol),
  ]);
  const bySymbol = new Map<string, Quote>(quotes.map((q) => [q.symbol, q]));
  const fx = await getFxRates();

  const rows: HoldingRow[] = holdings.map((h) => {
    const q = bySymbol.get(h.symbol);
    const currency = inferCurrency(h.symbol);
    const costBasisNative = h.quantity * h.avgCost;
    const costBasis = toUsd(costBasisNative, currency, fx);
    const price = q?.price ?? null;
    // Quote price is in native currency; convert market value to USD.
    const marketValueNative = price != null ? h.quantity * price : null;
    const marketValue =
      marketValueNative != null ? toUsd(marketValueNative, currency, fx) : null;
    const dayPLNative =
      price != null && q?.prevClose != null
        ? h.quantity * (price - q.prevClose)
        : null;
    const dayPL =
      dayPLNative != null ? toUsd(dayPLNative, currency, fx) : null;
    const totalPL = marketValue != null ? marketValue - costBasis : null;
    return {
      id: h.id,
      symbol: h.symbol,
      currency,
      name: q?.name ?? h.name ?? null,
      quantity: h.quantity,
      avgCost: h.avgCost,
      costBasis,
      price,
      marketValue,
      dayPL,
      dayChangePct: q?.dayChangePct ?? null,
      totalPL,
      totalPLPct:
        totalPL != null && costBasis !== 0
          ? (totalPL / costBasis) * 100
          : null,
      weightPct: null, // filled below once portfolio value is known
      source: "manual" as const,
      brokerLabel: null,
    };
  });

  for (const b of broker) {
    const q = bySymbol.get(b.symbol);
    const currency = b.currency ?? inferCurrency(b.symbol);
    // Broker's own mark price first (the value the user sees in IBKR) —
    // Yahoo is the fallback only when the broker sent no price.
    const price = b.markPrice ?? q?.price ?? null;
    const marketValueNative = price != null ? b.quantity * price : null;
    const marketValue =
      marketValueNative != null ? toUsd(marketValueNative, currency, fx) : null;
    const dayPLNative =
      q?.price != null && q?.prevClose != null
        ? b.quantity * (q.price - q.prevClose)
        : null;
    const dayPL = dayPLNative != null ? toUsd(dayPLNative, currency, fx) : null;
    const costBasisNative =
      b.costBasisPrice != null ? b.quantity * b.costBasisPrice : null;
    const costBasis =
      costBasisNative != null ? toUsd(costBasisNative, currency, fx) : null;
    const totalPL =
      marketValue != null && costBasis != null ? marketValue - costBasis : null;
    rows.push({
      // Label in the id: the same symbol can live on two brokers
      // (e.g. BTC on Binance + Coinbase) — bare-symbol ids would collide.
      id: `broker:${(b.label ?? "IBKR").toUpperCase()}:${b.symbol}`,
      symbol: b.symbol,
      currency,
      name: q?.name ?? null,
      quantity: b.quantity,
      avgCost: b.costBasisPrice ?? null,
      costBasis,
      price,
      marketValue,
      dayPL,
      dayChangePct: q?.dayChangePct ?? null,
      totalPL,
      totalPLPct:
        totalPL != null && costBasis ? (totalPL / costBasis) * 100 : null,
      weightPct: null,
      source: "broker" as const,
      brokerLabel: b.label ?? null,
    });
  }

  const marketValue = rows.reduce((s, r) => s + (r.marketValue ?? 0), 0);
  const costBasis = rows.reduce((s, r) => s + (r.costBasis ?? 0), 0);
  const dayPLValues = rows
    .map((r) => r.dayPL)
    .filter((v): v is number => v != null);
  const brokerMissingBasis = rows.filter(
    (r) => r.source === "broker" && r.marketValue != null && r.costBasis == null,
  ).length;
  // Total P/L is simply value minus cost. Positions without a recorded
  // cost basis count as $0 cost (the info tooltip says so) — holders expect
  // this number to match Value − Cost at a glance.
  const totalPL = marketValue - costBasis;

  for (const r of rows) {
    r.weightPct =
      r.marketValue != null && marketValue > 0
        ? (r.marketValue / marketValue) * 100
        : null;
  }

  return {
    rows,
    totals: {
      costBasis,
      marketValue,
      dayPL: dayPLValues.length > 0 ? dayPLValues.reduce((a, b) => a + b, 0) : null,
      totalPL,
      totalPLPct: costBasis > 0 ? (totalPL / costBasis) * 100 : null,
      byPlatform: buildByPlatform(rows),
      holdingsCount: rows.length,
      pricedCount: rows.filter((r) => r.marketValue != null).length,
      brokerCount: broker.length,
      brokerMissingBasis,
    },
  };
}

/**
 * True historical value curve: daily holdings from the full trade log ×
 * Yahoo daily (adjusted) closes, converted to USD via historical FX.
 *
 * Prices come from the D1 read-through cache (getPriceHistory), which
 * degrades to direct Yahoo fetches when its table isn't migrated yet.
 * Returns null when no honest curve can be built (no price history at all)
 * — the caller then falls back to snapshots / the invested step function.
 */
async function buildTrueCurve(
  db: AppDb,
  txns: Array<{
    symbol: string;
    type: string;
    quantity: number;
    price: number;
    fees: number | null;
    executedAt: Date;
    source: string;
  }>,
  liveValueUsd: number,
  days: number,
): Promise<{
  points: Array<CurvePoint & { invested: number }>;
  missingSymbols: Array<{ symbol: string; name: string | null }>;
  /**
   * Symbols with no price history, valued at their known average cost from
   * the trade log (flat, honest). The UI labels them separately from the
   * truly-missing ones.
   */
  estimatedSymbols: Array<{ symbol: string; name: string | null }>;
  /** source key → downsampled daily {date, value, invested} (trade-log only). */
  perSource: Record<string, PricedDay[]>;
  /** Monthly buckets from the full-resolution series (all history). */
  monthly: MonthCell[];
  /** Distinct normalized leg sources in the curve (e.g. ["ibkr","manual"]). */
  legSources: string[];
} | null> {
  const symbols = [
    ...new Set(txns.map((t) => t.symbol.trim().toUpperCase())),
  ].filter(Boolean);
  if (symbols.length === 0) return null;
  const firstMs = Math.min(
    ...txns.map((t) => new Date(t.executedAt).getTime()),
  );
  if (!Number.isFinite(firstMs)) return null;
  const fromISO = utcDay(new Date(firstMs));
  const toISO = utcDay(new Date());

  const needsHkd = symbols.some((s) => inferCurrency(s) === "HKD");

  // Price histories in parallel; a symbol whose fetch fails prices nothing
  // (reported via missingSymbols) instead of killing the whole curve.
  const settled: Array<[string, PriceBar[]]> = await Promise.all(
    [...symbols, ...(needsHkd ? ["HKD=X"] : [])].map(async (s) => {
      try {
        const { bars } = await getPriceHistory(db, s, fromISO, toISO);
        return [s, bars] as [string, PriceBar[]];
      } catch {
        return [s, []] as [string, PriceBar[]];
      }
    }),
  );
  const closesBySymbol: Record<string, PriceBar[]> = {};
  for (const [s, bars] of settled) {
    if (s !== "HKD=X") closesBySymbol[s] = bars;
  }
  const fxBars = settled.find(([s]) => s === "HKD=X")?.[1] ?? [];

  // Historical FX with a current-rate fallback. If HKD is needed and no FX
  // exists anywhere, bail out — converting HKD as USD would be ~7.8× wrong.
  const fxNow = await getFxRates();
  const hkdNow = fxNow.hkd;
  if (needsHkd && fxBars.length === 0 && !(hkdNow && hkdNow > 0)) return null;
  const fxToUsd = (date: string, currency: string): number => {
    if (currency === "USD") return 1;
    const bar = latestBarOnOrBefore(fxBars, date);
    if (bar && bar.close > 0) return 1 / bar.close;
    const r = fxNow[currency.toLowerCase()];
    return r && r > 0 ? 1 / r : 1;
  };

  const holdings = buildDailyHoldings(txns, fxToUsd);
  if (holdings.length === 0) return null;
  const {
    priced,
    missingSymbols: missingTotal,
    estimatedSymbols: estimatedTotal,
  } = aggregateDailyValue(holdings, closesBySymbol, fxToUsd);

  // Per-source breakdown for the By Source view: same price data, grouped by
  // each trade's origin. A separate cheap walk; the tested path above is
  // untouched.
  const sourcedDays = buildSourcedDailyHoldings(txns, fxToUsd);
  const bySource = aggregateDailyValueBySource(
    sourcedDays,
    closesBySymbol,
    fxToUsd,
  );
  const missingKeys = [
    ...new Set([...missingTotal, ...bySource.missingSymbols]),
  ];
  const estimatedKeys = [
    ...new Set([...estimatedTotal, ...bySource.estimatedSymbols]),
  ];
  // Resolve display names for the "prices missing" modal. Best-effort:
  // getQuote never throws (unavailable → name null) and rides the 60s quote
  // cache, so this only costs network on the rare non-empty case.
  // Estimated symbols get names too — they're shown in the same modal with
  // their own "valued at cost" label.
  let missingSymbols: Array<{ symbol: string; name: string | null }> =
    missingKeys.map((symbol) => ({ symbol, name: null }));
  let estimatedSymbols: Array<{ symbol: string; name: string | null }> =
    estimatedKeys.map((symbol) => ({ symbol, name: null }));
  const nameKeys = [...new Set([...missingKeys, ...estimatedKeys])];
  if (nameKeys.length > 0) {
    try {
      const quotes = await getQuotes(nameKeys);
      const names = new Map(quotes.map((q) => [q.symbol, q.name]));
      missingSymbols = missingKeys.map((symbol) => ({
        symbol,
        name: names.get(symbol) ?? null,
      }));
      estimatedSymbols = estimatedKeys.map((symbol) => ({
        symbol,
        name: names.get(symbol) ?? null,
      }));
    } catch {
      /* names stay null — symbols still listed */
    }
  }

  // Endpoint: today's live value replaces the last close (labels say so).
  // Monthly buckets come from the full-resolution series, so the in-progress
  // month ends at today's live value.
  priced[priced.length - 1]!.value = liveValueUsd;
  const monthly = bucketMonthly(priced);

  let points = priced;
  let cutoff: string | null = null;
  if (days > 0) {
    const c = utcDay(new Date(Date.now() - days * DAY_MS));
    cutoff = c;
    points = points.filter((p) => p.date >= c);
  }
  // A permanently-zero curve is never useful — let the fallback handle it.
  if (points.length < 2 || points.every((p) => p.value === 0)) return null;

  // Per-source series for the By Source view. Deliberately NOT grafted with
  // the live endpoint — these decompose the trade-log curve itself, and the
  // chart caption says so.
  const perSource: Record<string, PricedDay[]> = {};
  const cut = cutoff;
  for (const [src, series] of Object.entries(bySource.perSource)) {
    const inRange = cut ? series.filter((p) => p.date >= cut) : series;
    if (inRange.length >= 2) perSource[src] = downsamplePoints(inRange, 180);
  }

  return {
    points: downsamplePoints(points, 180),
    missingSymbols,
    estimatedSymbols,
    perSource,
    monthly,
    legSources: [...new Set(txns.map((t) => t.source.trim().toLowerCase()))],
  };
}

export const portfolioRouter = createTRPCRouter({
  /** Full dashboard data: manual holdings + broker snapshot, live prices, totals. */
  summary: publicProcedure
    .input(summaryInput)
    .query(async ({ ctx, input }) => buildSummary(ctx, input.brokerPositions)),

  /** Live quote for one symbol (used by the add-transaction form). */
  quote: publicProcedure
    .input(z.object({ symbol: symbolSchema }))
    .query(async ({ input }) => getQuote(input.symbol)),

  /**
   * WSB flair per symbol, judged from the full transaction log.
   * Manual holdings only — broker snapshots have no trade history,
   * so they get no badge.
   */
  flair: publicProcedure
    .input(z.object({ symbols: z.array(symbolSchema).max(500).default([]) }))
    .query(({ ctx, input }) => computeFlair(ctx.db, input.symbols)),

  /** Transaction history, newest first. */
  transactions: publicProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }))
    .query(({ ctx, input }) =>
      ctx.db.transaction.findMany({
        orderBy: [{ executedAt: "desc" }, { id: "desc" }],
        take: input.limit,
      })
    ),

  /**
   * Diamond-hands stats: per-position tenure + dip survival from the
   * transaction log and Yahoo history (D1-cached), plus the buy streak.
   * Drawdown is computed for the top 8 positions by value to bound cost;
   * a symbol with no history returns nulls, never an error.
   */
  handsStats: publicProcedure
    .input(summaryInput)
    .query(async ({ ctx, input }) => {
      const s = await buildSummary(ctx, input.brokerPositions);
      const rows = s.rows.filter((r) => r.quantity > 0 && (r.marketValue ?? 0) > 0);
      const txns = await ctx.db.transaction.findMany({
        orderBy: [{ executedAt: "asc" }],
        take: 10000,
      });

      const todayISO = new Date().toISOString().slice(0, 10);
      const firstBuy = new Map<string, string>();
      const buyMonths = new Set<string>();
      for (const t of txns) {
        const raw = t.executedAt instanceof Date ? t.executedAt.toISOString() : String(t.executedAt);
        const day = raw.slice(0, 10);
        if (t.type !== "BUY") continue;
        buyMonths.add(day.slice(0, 7));
        if (!firstBuy.has(t.symbol)) firstBuy.set(t.symbol, day);
      }

      const top = [...rows]
        .sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0))
        .slice(0, 8);

      const positions = await Promise.all(
        top.map(async (r) => {
          const fb = firstBuy.get(r.symbol) ?? null;
          const daysHeld =
            fb != null
              ? Math.max(0, Math.round((Date.parse(todayISO) - Date.parse(fb)) / DAY_MS))
              : null;
          let maxDrawdownPct: number | null = null;
          if (fb != null) {
            try {
              const hist = await getPriceHistory(ctx.db, r.symbol, fb, todayISO);
              maxDrawdownPct = maxDrawdown(hist.bars.map((b) => b.adjclose ?? b.close));
            } catch {
              maxDrawdownPct = null;
            }
          }
          return {
            symbol: r.symbol,
            name: r.name,
            marketValue: r.marketValue ?? 0,
            weightPct: r.weightPct ?? 0,
            firstBuyDate: fb,
            daysHeld,
            maxDrawdownPct,
          };
        }),
      );

      const withTenure = positions.filter((p) => p.daysHeld != null);
      const longestHeld =
        withTenure.length > 0
          ? withTenure.reduce((a, b) => ((b.daysHeld ?? 0) > (a.daysHeld ?? 0) ? b : a))
          : null;
      const withDip = positions.filter((p) => p.maxDrawdownPct != null);
      const deepestDip =
        withDip.length > 0
          ? withDip.reduce((a, b) => ((b.maxDrawdownPct ?? 0) > (a.maxDrawdownPct ?? 0) ? b : a))
          : null;

      return {
        positions,
        longestHeld,
        deepestDip,
        buyStreakMonths: countBuyStreak(buyMonths),
        buyMonths: buyMonths.size,
      };
    }),


  /**
   * Record today's portfolio snapshot for the equity curve. Called
   * client-side (once per day on dashboard load) because broker positions
   * live in the browser's IBKR snapshot, not on the server.
   */
  recordSnapshot: publicProcedure
    .input(summaryInput)
    .mutation(async ({ ctx, input }) => {
      const s = await buildSummary(ctx, input.brokerPositions);
      const t = s.totals;
      // Local calendar date — one row per day, re-recording overwrites.
      const date = new Date().toLocaleDateString("en-CA");
      await ctx.db.portfolioSnapshot.upsert({
        where: { date },
        create: {
          date,
          marketValue: t.marketValue,
          costBasis: t.costBasis,
          totalPL: t.totalPL,
          dayPL: t.dayPL,
          holdingsCount: t.holdingsCount,
        },
        update: {
          marketValue: t.marketValue,
          costBasis: t.costBasis,
          totalPL: t.totalPL,
          dayPL: t.dayPL,
          holdingsCount: t.holdingsCount,
        },
      });
      return { date };
    }),

  /**
   * Wipe all daily snapshots. The chart rebuilds from trade history, so
   * snapshots are only a fallback for accounts with no trade log —
   * resetting gives a clean series under the current valuation logic.
   */
  clearSnapshots: publicProcedure.mutation(async ({ ctx }) => {
    const r = await ctx.db.portfolioSnapshot.deleteMany();
    return { ok: true, cleared: r.count };
  }),

  /**
   * Equity curve for the Performance section — works from day one.
   *
   * Source priority:
   * 1. "true" — true historical value: daily holdings from the full trade
   *    log × Yahoo daily (adjusted) closes, USD via historical FX.
   * 2. "snapshots" — true daily snapshots when at least 2 exist in range.
   * 3. "trades" — fallback: net USD invested per day from the trade log,
   *    ending at today's live value.
   * days=0 → all.
   */
  equityCurve: publicProcedure
    .input(
      z
        .object({
          days: z.number().int().min(0).max(3650).default(90),
          /**
           * Restrict the curve to these leg sources (e.g. ["manual","ibkr"]).
           * The dashboard passes the sources present in the live summary so
           * a disconnected platform's history can't inflate the comparison —
           * performance always reflects the connected portfolio. Empty =
           * no filtering.
           */
          onlySources: z.array(z.string()).max(20).default([]),
        })
        .merge(summaryInput),
    )
    .query(async ({ ctx, input }) => {
      // Curve legs = Transaction log + raw Flex BrokerTrade rows, so the
      // true curve covers IBKR positions whose trades never made it into
      // the log (mergeIbkrTrades skips unreconciled symbols). See
      // mergeCurveLegs for the honesty rules.
      const { legs: txns } = await curveTradeLegs(ctx.db, input.onlySources);

      // Filtered to a universe with no history at all — no curve, and the
      // snapshots/invested fallbacks below would show the WRONG (unfiltered)
      // portfolio, so stop here.
      if (input.onlySources.length > 0 && txns.length === 0) {
        return { source: "none" as const, points: [], legSources: [] as string[] };
      }

      // 1. True historical value curve. Yahoo/FX failures fall through to
      // the older sources — never a broken chart.
      if (txns.length > 0) {
        try {
          const s = await buildSummary(ctx, input.brokerPositions);
          const tru = await buildTrueCurve(
            ctx.db,
            txns,
            s.totals.marketValue,
            input.days,
          );
          if (tru) {
            return {
              source: "true" as const,
              points: tru.points,
              missingSymbols: tru.missingSymbols,
              estimatedSymbols: tru.estimatedSymbols,
              perSource: tru.perSource,
              monthly: tru.monthly,
              legSources: tru.legSources,
            };
          }
        } catch {
          /* fall through */
        }
      }

      const cutoff =
        input.days > 0
          ? new Date(Date.now() - input.days * DAY_MS).toLocaleDateString(
              "en-CA",
            )
          : null;
      const snapshots = await ctx.db.portfolioSnapshot.findMany({
        orderBy: [{ date: "asc" }],
      });
      const inRange = cutoff
        ? snapshots.filter((r) => r.date >= cutoff)
        : snapshots;
      if (inRange.length >= 2) {
        return {
          source: "snapshots" as const,
          points: downsamplePoints(
            inRange.map((r) => ({ date: r.date, value: r.marketValue })),
          ),
          legSources: [...new Set(txns.map((t) => t.source.trim().toLowerCase()))],
        };
      }
      if (txns.length === 0) return { source: "none" as const, points: [], legSources: [] as string[] };
      const fx = await getFxRates();
      const flows = txnsToUsdFlows(txns, fx);
      const s = await buildSummary(ctx, input.brokerPositions);
      const points = buildInvestedCurve(flows, s.totals.marketValue, {
        startDaysAgo: input.days > 0 ? input.days : undefined,
      });
      const source: "trades" | "none" =
        points.length >= 2 ? "trades" : "none";
      return {
        source,
        points,
        legSources: [...new Set(txns.map((t) => t.source.trim().toLowerCase()))],
      };
    }),

  /**
   * Annualized internal rate of return from the transaction log. Buys are
   * outflows, sells are inflows, today's market value is the terminal
   * inflow — all converted to USD. Excludes dividends (they aren't in the
   * log). XIRR stays null until 30 days of history exist: annualizing a
   * shorter span explodes into noise (a 1% weekly wobble reads as ±68%
   * "annualized").
   *
   * `onlySources` restricts both the legs and the terminal value to the
   * same platform universe as the equity curve, so XIRR stays consistent
   * with the connected portfolio.
   */
  xirr: publicProcedure
    .input(
      summaryInput.merge(
        z.object({ onlySources: z.array(z.string()).max(20).default([]) }),
      ),
    )
    .query(async ({ ctx, input }) => {
    // Same legs as the curve — XIRR and the chart must tell one story.
    const { legs: txns } = await curveTradeLegs(ctx.db, input.onlySources);
    const fx = await getFxRates();
    const flows = txnsToUsdFlows(txns, fx);
    const s = await buildSummary(ctx, input.brokerPositions);
    // Terminal value over the same universe as the legs — a disconnected
    // platform's history must not be measured against a live value that
    // doesn't contain it (or vice versa).
    const allow = new Set(input.onlySources.map((x) => x.trim().toLowerCase()));
    const terminalValue =
      input.onlySources.length === 0
        ? s.totals.marketValue
        : s.rows
            .filter((r) => allow.has(legSourceOf(r)))
            .reduce((sum, r) => sum + (r.marketValue ?? 0), 0);
    if (terminalValue > 0) {
      flows.push({ date: new Date(), amount: terminalValue });
    }
    const times = flows.map((f) => f.date.getTime());
    const spanDays =
      times.length >= 2
        ? (Math.max(...times) - Math.min(...times)) / DAY_MS
        : 0;
    const contributions = txns
      .filter((t) => t.type === "BUY")
      .reduce(
        (a, t) =>
          a +
          toUsd(
            t.quantity * t.price + (t.fees ?? 0),
            inferCurrency(t.symbol),
            fx,
          ),
        0,
      );
    const withdrawals = txns
      .filter((t) => t.type === "SELL")
      .reduce(
        (a, t) =>
          a +
          toUsd(
            t.quantity * t.price - (t.fees ?? 0),
            inferCurrency(t.symbol),
            fx,
          ),
        0,
      );
    return {
      xirr: spanDays >= 30 ? computeXirr(flows) : null,
      spanDays,
      contributions,
      withdrawals,
      currentValue: s.totals.marketValue,
    };
  }),

  /**
   * AI-generated portfolio insights via Cloudflare Workers AI.
   * Takes a compact client-built snapshot (USD) — the client caches
   * results in localStorage for 24h so we don't regenerate on every load.
   */
  insights: publicProcedure
    .input(
      z.object({
        positions: z
          .array(
            z.object({
              symbol: z.string().max(12),
              marketValue: z.number(),
              totalPL: z.number(),
              totalPLPct: z.number().nullable(),
              dayPL: z.number().nullable(),
              weightPct: z.number(),
            }),
          )
          .max(200),
        totals: z.object({
          marketValue: z.number(),
          dayPL: z.number().nullable(),
          totalPL: z.number(),
          totalPLPct: z.number().nullable(),
        }),
        recentTrades: z
          .array(
            z.object({
              symbol: z.string().max(12),
              type: z.string().max(4),
              quantity: z.number(),
              price: z.number(),
              date: z.string().max(10),
            }),
          )
          .max(10)
          .default([]),
        // Reply language for the AI insights (see ~/server/ai.ts).
        locale: z.enum(["en", "zh-Hant", "zh-Hans"]).default("en"),
      }),
    )
    .query(async ({ input }) => {
      // Defense in depth: cap the prompt at the top 200 positions by
      // value (zod already enforces .max(200) on the input).
      const positions = [...input.positions]
        .sort((a, b) => b.marketValue - a.marketValue)
        .slice(0, 200);
      const result = await generateInsights({ ...input, positions });
      return { ...result, generatedAt: new Date().toISOString() };
    }),

  /** Log a buy or sell. Recomputes the holding from the full history. */
  recordTransaction: publicProcedure
    .input(
      z.object({
        symbol: symbolSchema,
        type: z.enum(["BUY", "SELL"]),
        quantity: z.number().positive(),
        price: z.number().positive(),
        fees: z.number().min(0).default(0),
        executedAt: z.date().default(() => new Date()),
        note: z.string().trim().max(280).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // NOTE: no interactive $transaction here — Cloudflare D1 does not
      // support them ("Cloudflare D1 does not support interactive
      // transactions"). The statements run sequentially instead; D1 is
      // single-writer so this is safe for a personal portfolio app.
      const db = ctx.db;
      const txn = await db.transaction.create({
        data: {
          symbol: input.symbol,
          type: input.type,
          quantity: input.quantity,
          price: input.price,
          fees: input.fees,
          executedAt: input.executedAt,
          note: input.note ? input.note : undefined,
        },
      });
      // Throws BAD_REQUEST if a sell exceeds the held quantity.
      await recomputeHolding(db, input.symbol);

      // Backfill the company name from the quote feed when we learn it.
      try {
        const quote = await getQuote(input.symbol);
        if (quote.name) {
          await db.holding.updateMany({
            where: { symbol: input.symbol, name: null },
            data: { name: quote.name },
          });
        }
      } catch {
        /* name backfill is best-effort */
      }

      return txn;
    }),

  /**
   * Merge IBKR-synced trades into the transaction log (owner only).
   * Idempotent — re-importing the same Flex report is a no-op thanks to the
   * stable externalId on each trade. Manual entries are never touched;
   * trades the user already logged by hand are skipped as duplicates.
   */
  importIbkrTrades: protectedProcedure
    .input(
      z.object({
        trades: z
          .array(
            z.object({
              symbol: z.string().max(16),
              tradeDate: z.string().regex(/^\d{8}$/),
              quantity: z.number().finite(),
              tradePrice: z.number().nullable(),
              commission: z.number().nullable(),
              transactionId: z.string().max(64).nullable(),
            }),
          )
          .max(2000),
        positions: z
          .array(
            z.object({
              symbol: z.string().max(16),
              quantity: z.number().finite(),
              costBasisPrice: z.number().nullable(),
            }),
          )
          .max(2000)
          .default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return mergeIbkrTrades(ctx.db, input.trades, input.positions);
    }),

  /** Delete one transaction; the holding is recomputed from the rest. */
  deleteTransaction: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      // Sequential, not an interactive $transaction (unsupported on D1).
      const db = ctx.db;
      const existing = await db.transaction.findUnique({
        where: { id: input.id },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Transaction not found" });
      }
      // Tombstone first: otherwise the next IBKR auto-sync re-imports the
      // row and the user's delete is silently undone.
      await tombstoneTransaction(db, existing);
      await db.transaction.delete({ where: { id: input.id } });
      await recomputeHolding(db, existing.symbol);
      return { ok: true };
    }),

  /**
   * Edit one transaction in place (fix typos without delete + re-add);
   * the holding is recomputed from the full log afterwards.
   */
  updateTransaction: publicProcedure
    .input(
      z.object({
        id: z.string().min(1),
        type: z.enum(["BUY", "SELL"]),
        quantity: z.number().positive(),
        price: z.number().positive(),
        fees: z.number().min(0).default(0),
        executedAt: z.date(),
        note: z.string().trim().max(280).default(""),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Sequential, not an interactive $transaction (unsupported on D1).
      const existing = await ctx.db.transaction.findUnique({
        where: { id: input.id },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Transaction not found" });
      }
      await ctx.db.transaction.update({
        where: { id: input.id },
        data: {
          type: input.type,
          quantity: input.quantity,
          price: input.price,
          fees: input.fees,
          executedAt: input.executedAt,
          note: input.note === "" ? null : input.note,
        },
      });
      // Throws BAD_REQUEST if the edited sell exceeds the held quantity.
      await recomputeHolding(ctx.db, existing.symbol);
      return { ok: true };
    }),

  /** Delete a holding AND its entire transaction history for that symbol. */
  deleteHolding: publicProcedure
    .input(z.object({ symbol: symbolSchema }))
    .mutation(async ({ ctx, input }) => {
      // Sequential, not an interactive $transaction (unsupported on D1).
      // Tombstone every row first — otherwise the next IBKR auto-sync
      // re-imports the whole history and the delete is silently undone.
      const rows = await ctx.db.transaction.findMany({
        where: { symbol: input.symbol },
        orderBy: [{ executedAt: "asc" }],
      });
      for (const r of rows) {
        await tombstoneTransaction(ctx.db, r);
      }
      await ctx.db.transaction.deleteMany({ where: { symbol: input.symbol } });
      await ctx.db.holding.deleteMany({ where: { symbol: input.symbol } });
      return { ok: true };
    }),

  /**
   * Export the minimal backup: just enough to fully restore the user's
   * config and data.
   * - transactions: the source of truth (holdings recompute from these).
   * - priceAlerts: user config (when logged in).
   * - clientPrefs: embedded client-side (allowlisted UI config only).
   * Deliberately excluded: holdings (recomputed), broker/exchange
   * snapshots + Yahoo bars (re-synced/re-fetched), credentials (never).
   */
  exportBackup: publicProcedure.query(async ({ ctx }) => {
    const session = ctx.session;
    const userId = session?.user?.id;
    const [transactions, priceAlerts] = await Promise.all([
      ctx.db.transaction.findMany({ orderBy: [{ executedAt: "desc" }] }),
      userId
        ? ctx.db.priceAlert.findMany({
            where: { userId },
            orderBy: [{ createdAt: "asc" }],
          })
        : Promise.resolve([]),
    ]);
    return {
      version: 3,
      exportedAt: new Date().toISOString(),
      transactions,
      priceAlerts: priceAlerts.map((a) => ({
        symbol: a.symbol,
        targetPrice: a.targetPrice,
        direction: a.direction,
        active: a.active,
      })),
    };
  }),

  /** Restore data from a backup JSON. Replaces all existing data. */
  importBackup: publicProcedure
    .input(
      z.object({
        version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        transactions: z.array(
          z.object({
            symbol: z.string(),
            type: z.string(),
            quantity: z.number(),
            price: z.number(),
            fees: z.number().optional(),
            executedAt: z.union([z.string(), z.date()]),
            note: z.string().nullable().optional(),
            source: z.string().optional(),
            externalId: z.string().nullable().optional(),
          }),
        ),
        // Legacy payloads (accepted, ignored): v1 exported holdings,
        // v2 exported brokerPositions for verification — neither was ever
        // restored, and v3 no longer exports them.
        holdings: z.array(z.unknown()).optional(),
        brokerPositions: z.array(z.unknown()).optional(),
        // v3: user price-alert config.
        priceAlerts: z
          .array(
            z.object({
              symbol: z.string(),
              targetPrice: z.number(),
              direction: z.string(),
              active: z.boolean().optional(),
            }),
          )
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Clear existing per symbol (D1 adapter requires where clause)
      const existing = await ctx.db.transaction.findMany({
        orderBy: [{ executedAt: "desc" }],
      });
      const symbols = [...new Set(existing.map((t) => t.symbol))];
      for (const s of symbols) {
        await ctx.db.transaction.deleteMany({ where: { symbol: s } });
      }
      const hExisting = await ctx.db.holding.findMany({
        orderBy: { symbol: "asc" },
      });
      for (const h of hExisting) {
        await ctx.db.holding.deleteMany({ where: { symbol: h.symbol } });
      }
      // Restore one by one (no createMany on D1 adapter)
      for (const t of input.transactions) {
        await ctx.db.transaction.create({
          data: {
            symbol: t.symbol,
            type: t.type,
            quantity: t.quantity,
            price: t.price,
            fees: t.fees ?? 0,
            executedAt: t.executedAt,
            note: t.note ?? null,
            source: t.source ?? "manual",
            externalId: t.externalId ?? null,
          },
        });
      }
      // Holdings are recomputed from transactions via recomputeHolding
      for (const t of input.transactions) {
        await recomputeHolding(ctx.db, t.symbol);
      }
      // Restore price alerts (v3, logged-in users only).
      let alertsRestored = 0;
      const session = ctx.session;
      const userId = session?.user?.id;
      if (userId && session && input.priceAlerts) {
        const aExisting = await ctx.db.priceAlert.findMany({
          where: { userId },
        });
        for (const a of aExisting) {
          await ctx.db.priceAlert.delete({ where: { id: a.id } });
        }
        const email = session.user.email ?? "";
        for (const pa of input.priceAlerts) {
          if (pa.direction !== "above" && pa.direction !== "below") continue;
          const created = await ctx.db.priceAlert.create({
            data: {
              userId,
              email,
              symbol: pa.symbol,
              targetPrice: pa.targetPrice,
              direction: pa.direction,
            },
          });
          if (pa.active === false) {
            await ctx.db.priceAlert.update({
              where: { id: created.id },
              data: { active: false },
            });
          }
          alertsRestored++;
        }
      }
      return {
        ok: true,
        restored: input.transactions.length,
        alertsRestored,
      };
    }),

  clearManualData: publicProcedure
    .input(z.object({ includeIbkr: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      // One-click cleanup of the manual section: delete hand-entered trades
      // (or the whole log on a full reset, including IBKR-imported rows) and
      // rebuild whatever holdings survive. Broker snapshots are untouched.
      const all = await ctx.db.transaction.findMany({
        orderBy: [{ executedAt: "desc" }],
        take: 100000,
      });
      const doomed = input.includeIbkr
        ? all
        : all.filter((t) => t.source === "manual");
      for (const t of doomed) {
        // Tombstone IBKR-imported rows before deleting: otherwise the next
        // auto-sync re-imports them and the reset is silently undone.
        if (t.externalId) await tombstoneTransaction(ctx.db, t);
        await ctx.db.transaction.delete({ where: { id: t.id } });
      }
      const failed: string[] = [];
      if (input.includeIbkr) {
        const holdings = await ctx.db.holding.findMany({
          orderBy: { symbol: "asc" },
        });
        for (const h of holdings) {
          await ctx.db.holding.deleteMany({ where: { symbol: h.symbol } });
        }
      } else {
        // Delete ALL holdings in the manual section — the user asked to
        // clear them and rebuild from IBKR full history afterwards.
        // (Recomputing from the current incomplete log would just resurrect
        // the same stale rows.)
        const holdings = await ctx.db.holding.findMany({
          orderBy: { symbol: "asc" },
        });
        for (const h of holdings) {
          await ctx.db.holding.deleteMany({ where: { symbol: h.symbol } });
        }
      }
      return { deletedTrades: doomed.length, failed };
    }),
});
