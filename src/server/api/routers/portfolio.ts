import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  getQuote,
  getQuotes,
  getFxRates,
  toUsd,
  inferCurrency,
  type Quote,
} from "~/server/market";
import { createTRPCRouter, protectedProcedure, publicProcedure } from "~/server/api/trpc";
import { computeFlair } from "~/server/wsb";
import { generateInsights } from "~/server/ai";
import {
  importIbkrTrades as mergeIbkrTrades,
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
  currency: z.string().max(8).optional(),
});

const summaryInput = z.object({
  brokerPositions: z.array(brokerPositionInput).max(500).default([]),
});

export interface HoldingRow {
  id: string;
  symbol: string;
  name: string | null;
  quantity: number;
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
}

export interface Summary {
  rows: HoldingRow[];
  totals: {
    costBasis: number;
    marketValue: number;
    dayPL: number | null;
    /** Null when broker positions lack cost basis — can't be computed honestly. */
    totalPL: number | null;
    totalPLPct: number | null;
    holdingsCount: number;
    pricedCount: number;
    brokerCount: number;
    /** Broker rows with a market value but no cost basis. */
    brokerMissingBasis: number;
  };
}

async function buildSummary(
  ctx: { db: AppDb },
  brokerPositions: z.infer<typeof brokerPositionInput>[],
): Promise<Summary> {
  const holdings = await ctx.db.holding.findMany({ orderBy: { symbol: "asc" } });
  const manualSymbols = new Set(holdings.map((h) => h.symbol));
  // The manual log wins on overlap — the same symbol must never be
  // double-counted in both the manual portfolio and the broker snapshot.
  const broker = brokerPositions.filter((b) => !manualSymbols.has(b.symbol));

  const quotes = await getQuotes([
    ...holdings.map((h) => h.symbol),
    ...broker.map((b) => b.symbol),
  ]);
  const bySymbol = new Map<string, Quote>(quotes.map((q) => [q.symbol, q]));

  const rows: HoldingRow[] = holdings.map((h) => {
    const q = bySymbol.get(h.symbol);
    const costBasis = h.quantity * h.avgCost;
    const price = q?.price ?? null;
    const marketValue = price != null ? h.quantity * price : null;
    const dayPL =
      price != null && q?.prevClose != null
        ? h.quantity * (price - q.prevClose)
        : null;
    const totalPL = marketValue != null ? marketValue - costBasis : null;
    return {
      id: h.id,
      symbol: h.symbol,
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
    };
  });

  for (const b of broker) {
    const q = bySymbol.get(b.symbol);
    // Live quote when available, otherwise IBKR's end-of-day mark price.
    const price = q?.price ?? b.markPrice;
    const marketValue = price != null ? b.quantity * price : null;
    const dayPL =
      q?.price != null && q?.prevClose != null
        ? b.quantity * (q.price - q.prevClose)
        : null;
    const costBasis =
      b.costBasisPrice != null ? b.quantity * b.costBasisPrice : null;
    const totalPL =
      marketValue != null && costBasis != null ? marketValue - costBasis : null;
    rows.push({
      id: `broker:${b.symbol}`,
      symbol: b.symbol,
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
  // Without every position's cost basis, a total P/L number would be a lie —
  // show it only when it's complete (manual-only portfolios are unaffected).
  const totalPL =
    brokerMissingBasis > 0
      ? null
      : rows.reduce((s, r) => s + (r.marketValue ?? 0), 0) - costBasis;

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
      totalPLPct:
        totalPL != null && costBasis > 0 ? (totalPL / costBasis) * 100 : null,
      holdingsCount: rows.length,
      pricedCount: rows.filter((r) => r.marketValue != null).length,
      brokerCount: broker.length,
      brokerMissingBasis,
    },
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
      // Defense in depth: the client sends the top 30, but never let a
      // huge position list blow up the prompt — keep the top 30 by value.
      const positions = [...input.positions]
        .sort((a, b) => b.marketValue - a.marketValue)
        .slice(0, 30);
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
      await db.transaction.delete({ where: { id: input.id } });
      await recomputeHolding(db, existing.symbol);
      return { ok: true };
    }),

  /** Delete a holding AND its entire transaction history for that symbol. */
  deleteHolding: publicProcedure
    .input(z.object({ symbol: symbolSchema }))
    .mutation(async ({ ctx, input }) => {
      // Sequential, not an interactive $transaction (unsupported on D1).
      await ctx.db.transaction.deleteMany({ where: { symbol: input.symbol } });
      await ctx.db.holding.deleteMany({ where: { symbol: input.symbol } });
      return { ok: true };
    }),
});
