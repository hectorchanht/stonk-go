import { TRPCError } from "@trpc/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { z } from "zod";

import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import {
  fetchFlexPositions,
  FlexError,
  type FlexResult,
} from "~/server/ibkr";
import {
  computeAnalytics,
  type CashFlowLike,
  type TradeLike,
} from "~/server/ibkr-analytics";

const SETUP_HINT =
  "IBKR is not connected. In Client Portal: Reports > Flex Queries (create an Activity query with the Open Positions, Trades and Cash Transactions sections, note its ID), then Settings > Reporting > Flex Web Service (generate a token). Set IBKR_FLEX_TOKEN and IBKR_FLEX_QUERY_ID as environment variables/secrets — or paste your token + query ID below; it stays in your browser and is only sent to IBKR when you sync.";

function getFlexConfig(): { token: string; queryId: string } | null {
  let token: unknown;
  let queryId: unknown;
  try {
    // On Cloudflare Workers, dashboard env vars/secrets live on the
    // worker env (process.env is not reliable there).
    const cfEnv = getCloudflareContext().env;
    token = cfEnv.IBKR_FLEX_TOKEN;
    queryId = cfEnv.IBKR_FLEX_QUERY_ID;
  } catch {
    // Not in a worker request scope — local dev falls through to process.env.
  }
  token ??= process.env.IBKR_FLEX_TOKEN;
  queryId ??= process.env.IBKR_FLEX_QUERY_ID;
  if (typeof token !== "string" || !token || typeof queryId !== "string" || !queryId) {
    return null;
  }
  return { token, queryId };
}

const syncInput = z
  .object({
    // Per-user credentials. Sent transiently: used for this sync only,
    // never written to the database. When omitted, the server-wide
    // IBKR_FLEX_TOKEN / IBKR_FLEX_QUERY_ID config is used instead.
    token: z.string().min(1),
    queryId: z.string().min(1),
  })
  .optional();

export const ibkrRouter = createTRPCRouter({
  status: publicProcedure.query(async ({ ctx }) => {
    const cfg = getFlexConfig();
    const rows = await ctx.db.brokerPosition.findMany({
      orderBy: [{ symbol: "asc" }],
    });
    const lastSyncedAt = rows.reduce<Date | null>(
      (max, r) => (max == null || r.syncedAt > max ? r.syncedAt : max),
      null,
    );
    return {
      configured: cfg != null,
      positionCount: rows.length,
      lastSyncedAt,
      positions: rows.map((r) => ({
        id: r.id,
        accountId: r.accountId,
        symbol: r.symbol,
        description: r.description,
        assetCategory: r.assetCategory,
        currency: r.currency,
        quantity: r.quantity,
        markPrice: r.markPrice,
      })),
    };
  }),

  sync: publicProcedure.input(syncInput).mutation(async ({ ctx, input }) => {
    // Transient per-user mode: credentials travel with the request and are
    // never persisted. Server mode: the env-configured account, snapshotted
    // to D1 so the dashboard (and a future cron) can read it without creds.
    const transient = input != null;
    const cfg = transient
      ? { token: input.token, queryId: input.queryId }
      : getFlexConfig();
    if (!cfg) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: SETUP_HINT });
    }

    let result: FlexResult;
    try {
      result = await fetchFlexPositions(cfg.token, cfg.queryId);
    } catch (e) {
      // Never leak the token into the error message.
      const message =
        e instanceof FlexError ? e.message : "IBKR sync failed unexpectedly.";
      throw new TRPCError({ code: "BAD_REQUEST", message });
    }

    if (!transient) {
      // Replace the whole snapshot. Sequential statements: D1 has no
      // interactive transactions, and these lists are small.
      await ctx.db.brokerPosition.deleteMany();
      await ctx.db.brokerTrade.deleteMany();
      await ctx.db.brokerCashFlow.deleteMany();
      if (result.positions.length > 0) {
        await ctx.db.brokerPosition.createMany({
          data: result.positions.map((p) => ({
            accountId: p.accountId,
            symbol: p.symbol,
            description: p.description,
            assetCategory: p.assetCategory,
            currency: p.currency,
            quantity: p.quantity,
            markPrice: p.markPrice,
          })),
        });
      }
      if (result.trades.length > 0) {
        await ctx.db.brokerTrade.createMany({
          data: result.trades.map((t) => ({
            accountId: t.accountId,
            symbol: t.symbol,
            description: t.description,
            assetCategory: t.assetCategory,
            currency: t.currency,
            tradeDate: t.tradeDate,
            quantity: t.quantity,
            tradePrice: t.tradePrice,
            proceeds: t.proceeds,
            commission: t.commission,
            realizedPnl: t.realizedPnl,
            openClose: t.openClose,
            transactionType: t.transactionType,
          })),
        });
      }
      if (result.cashFlows.length > 0) {
        await ctx.db.brokerCashFlow.createMany({
          data: result.cashFlows.map((c) => ({
            accountId: c.accountId,
            symbol: c.symbol,
            description: c.description,
            currency: c.currency,
            dateTime: c.dateTime,
            amount: c.amount,
            type: c.type,
          })),
        });
      }
    }

    const now = new Date();
    const tradeLikes: TradeLike[] = result.trades.map((t, i) => ({
      id: `sync-${i}`,
      symbol: t.symbol,
      tradeDate: t.tradeDate,
      quantity: t.quantity,
      tradePrice: t.tradePrice,
      commission: t.commission,
      realizedPnl: t.realizedPnl,
      openClose: t.openClose,
    }));
    const cashLikes: CashFlowLike[] = result.cashFlows.map((c, i) => ({
      id: `sync-${i}`,
      type: c.type,
      symbol: c.symbol,
      dateTime: c.dateTime,
      amount: c.amount,
      currency: c.currency,
    }));

    return {
      persisted: !transient,
      positions: result.positions,
      analytics: computeAnalytics(tradeLikes, cashLikes),
      syncedAt: now,
    };
  }),

  /**
   * Analytics over the server-side IBKR snapshot (env-configured account).
   * Per-user browser mode gets analytics inline from `sync` instead.
   */
  analytics: publicProcedure.query(async ({ ctx }) => {
    const trades = await ctx.db.brokerTrade.findMany({
      orderBy: [{ tradeDate: "desc" }],
    });
    const cashFlows = await ctx.db.brokerCashFlow.findMany({
      orderBy: [{ dateTime: "desc" }],
    });
    return computeAnalytics(trades, cashFlows);
  }),
});
