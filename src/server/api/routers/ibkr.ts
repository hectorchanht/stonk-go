import { TRPCError } from "@trpc/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { z } from "zod";

import { createTRPCRouter, protectedProcedure, publicProcedure } from "~/server/api/trpc";
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
import {
  importIbkrTrades as mergeIbkrTrades,
  type ImportStats,
} from "~/server/ibkr-import";
import { decryptCredentials, encryptCredentials } from "~/server/crypto";
import { resolveSymbolNames } from "~/server/market";

/**
 * Analytics plus display names for HKEX numeric codes (IBKR reports HK
 * stocks by number, e.g. "2225", with no company name). Best-effort —
 * missing names resolve to null and the UI falls back to the raw symbol.
 */
async function analyticsWithNames(
  trades: TradeLike[],
  cashFlows: CashFlowLike[],
) {
  const analytics = await computeAnalytics(trades, cashFlows);
  const names = await resolveSymbolNames([
    ...analytics.symbols.map((s) => s.symbol),
    ...analytics.recentTrades.map((t) => t.symbol),
  ]);
  return { ...analytics, names };
}

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
    // Credential resolution order:
    // 1. Transient per-user mode: credentials travel with the request and
    //    are never persisted.
    // 2. Saved credentials: a logged-in user with stored (encrypted) creds
    //    can sync without re-pasting — still transient (persisted:false).
    // 3. Server mode: the env-configured account, snapshotted to D1
    //    (being phased out; dashboard no longer exposes it).
    let token: string | undefined;
    let queryId: string | undefined;
    let transient = false;

    if (input?.token && input?.queryId) {
      token = input.token;
      queryId = input.queryId;
      transient = true;
    } else {
      const userId = ctx.session?.user?.id;
      if (userId) {
        const row = await ctx.db.brokerCredential.findUnique({
          where: { userId },
        });
        if (row) {
          try {
            const dec = await decryptCredentials(
              row.iv,
              row.encToken,
              row.encQueryId,
            );
            token = dec.token;
            queryId = dec.queryId;
            transient = true;
          } catch {
            // Never leak credential material into the error message.
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "Saved IBKR credentials could not be decrypted (the server key may have changed). Please save them again.",
            });
          }
        }
      }
    }

    const cfg =
      token && queryId ? { token, queryId } : getFlexConfig();
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

    let tradeImport: ImportStats | null = null;
    if (!transient) {
      // Questrade shares these tables under the "questrade:" accountId
      // prefix. The legacy env-mode snapshot replaces the WHOLE table, so
      // it must refuse to run while another broker's rows exist rather
      // than silently wiping them.
      const hasQuestradeRows = (
        await ctx.db.brokerPosition.findMany({ orderBy: [{ symbol: "asc" }] })
      ).some((r) => r.accountId.startsWith("questrade:"));
      if (hasQuestradeRows) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "IBKR server-mode sync is disabled while Questrade data is stored (it would wipe it). " +
            "Sync IBKR from the browser card instead, or disconnect Questrade first.",
        });
      }
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
      // Merge the Flex trades into the transaction log, so holdings and
      // cost basis reflect brokerage activity instead of the snapshot
      // being a separate display next to the manual log. Positions anchor
      // the merge (split adjustment + reconciliation).
      tradeImport = await mergeIbkrTrades(
        ctx.db,
        result.trades,
        result.positions,
      );
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
      currency: t.currency,
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
      analytics: await analyticsWithNames(tradeLikes, cashLikes),
      syncedAt: now,
      // Normalized trades, so the browser can merge them into the
      // transaction log via portfolio.importIbkrTrades (owner only).
      trades: result.trades.map((t) => ({
        symbol: t.symbol,
        tradeDate: t.tradeDate,
        quantity: t.quantity,
        tradePrice: t.tradePrice,
        commission: t.commission,
        transactionId: t.transactionId,
      })),
      // Set when this sync merged trades server-side (non-transient mode).
      tradeImport,
    };
  }),

  /**
   * Save the caller's IBKR Flex credentials, AES-GCM encrypted, keyed by
   * user id. Replaces any previously saved row. Secrets are never returned
   * by any endpoint.
   */
  saveCredentials: protectedProcedure
    .input(
      z.object({
        token: z.string().min(1).max(500),
        queryId: z.string().min(1).max(100),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      // Throws a clear error when CREDENTIALS_KEY is not configured.
      const enc = await encryptCredentials(input.token, input.queryId);
      await ctx.db.brokerCredential.upsert({
        where: { userId },
        update: {
          encToken: enc.encToken,
          encQueryId: enc.encQueryId,
          iv: enc.iv,
        },
        create: {
          userId,
          encToken: enc.encToken,
          encQueryId: enc.encQueryId,
          iv: enc.iv,
        },
      });
      return { saved: true };
    }),

  /** Whether the caller has saved IBKR credentials (never returns them). */
  savedCredentials: protectedProcedure.query(async ({ ctx }) => {
    const row = await ctx.db.brokerCredential.findUnique({
      where: { userId: ctx.session.user.id },
    });
    return { saved: row != null };
  }),

  /**
   * Return the caller's decrypted IBKR credentials so they can back them up
   * (download as a file). Deliberate exception to "never return secrets":
   * it is the user's own credential, and Flex tokens are read-only report
   * tokens (they cannot place trades). Anyone signed into this account could
   * already see the same portfolio data via sync.
   */
  exportCredentials: protectedProcedure.query(async ({ ctx }) => {
    const row = await ctx.db.brokerCredential.findUnique({
      where: { userId: ctx.session.user.id },
    });
    if (!row) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "No saved credentials",
      });
    }
    const dec = await decryptCredentials(row.iv, row.encToken, row.encQueryId);
    return { token: dec.token, queryId: dec.queryId };
  }),

  /** Delete the caller's saved IBKR credentials. */
  clearCredentials: protectedProcedure.mutation(async ({ ctx }) => {
    const row = await ctx.db.brokerCredential.findUnique({
      where: { userId: ctx.session.user.id },
    });
    if (row) {
      await ctx.db.brokerCredential.delete({
        where: { userId: ctx.session.user.id },
      });
    }
    return { cleared: true };
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
    return analyticsWithNames(trades, cashFlows);
  }),
});
