import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { getQuote, getQuotes, type Quote } from "~/server/market";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { type AppDb } from "~/server/db";

/**
 * Portfolio domain.
 *
 * The transaction log is the source of truth: every buy/sell (or deletion)
 * recomputes the affected Holding from scratch, so positions can never drift
 * out of sync with the log.
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

/** Recompute a holding from its full transaction history. */
async function recomputeHolding(tx: AppDb, symbol: string) {
  const txns = await tx.transaction.findMany({
    where: { symbol },
    orderBy: [{ executedAt: "asc" }, { id: "asc" }],
  });

  let quantity = 0;
  let costBasis = 0;
  for (const t of txns) {
    if (t.type === "BUY") {
      costBasis += t.quantity * t.price + t.fees;
      quantity += t.quantity;
    } else {
      if (t.quantity > quantity + 1e-9) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Cannot sell ${t.quantity} ${symbol}: only ${quantity} held`,
        });
      }
      const ratio = quantity > 0 ? t.quantity / quantity : 0;
      costBasis -= costBasis * ratio;
      quantity -= t.quantity;
    }
  }

  if (quantity <= 1e-9) {
    await tx.holding.deleteMany({ where: { symbol } });
  } else {
    await tx.holding.upsert({
      where: { symbol },
      update: { quantity, avgCost: costBasis / quantity },
      create: { symbol, quantity, avgCost: costBasis / quantity },
    });
  }
}

export interface HoldingRow {
  id: string;
  symbol: string;
  name: string | null;
  quantity: number;
  avgCost: number;
  costBasis: number;
  price: number | null;
  marketValue: number | null;
  dayPL: number | null;
  dayChangePct: number | null;
  totalPL: number | null;
  totalPLPct: number | null;
  weightPct: number | null;
}

export interface Summary {
  rows: HoldingRow[];
  totals: {
    costBasis: number;
    marketValue: number;
    dayPL: number | null;
    totalPL: number;
    totalPLPct: number | null;
    holdingsCount: number;
    pricedCount: number;
  };
}

async function buildSummary(ctx: { db: AppDb }): Promise<Summary> {
  const holdings = await ctx.db.holding.findMany({ orderBy: { symbol: "asc" } });
  const quotes = await getQuotes(holdings.map((h) => h.symbol));
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
    };
  });

  const marketValue = rows.reduce((s, r) => s + (r.marketValue ?? 0), 0);
  const costBasis = rows.reduce((s, r) => s + r.costBasis, 0);
  const dayPLValues = rows
    .map((r) => r.dayPL)
    .filter((v): v is number => v != null);
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
      holdingsCount: rows.length,
      pricedCount: rows.filter((r) => r.marketValue != null).length,
    },
  };
}

export const portfolioRouter = createTRPCRouter({
  /** Full dashboard data: holdings with live prices + portfolio totals. */
  summary: publicProcedure.query(async ({ ctx }) => buildSummary(ctx)),

  /** Live quote for one symbol (used by the add-transaction form). */
  quote: publicProcedure
    .input(z.object({ symbol: symbolSchema }))
    .query(async ({ input }) => getQuote(input.symbol)),

  /** Transaction history, newest first. */
  transactions: publicProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }))
    .query(({ ctx, input }) =>
      ctx.db.transaction.findMany({
        orderBy: [{ executedAt: "desc" }, { id: "desc" }],
        take: input.limit,
      })
    ),

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
