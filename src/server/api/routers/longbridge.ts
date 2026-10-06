import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createTRPCRouter, protectedProcedure, publicProcedure } from "~/server/api/trpc";
import {
  LongbridgeError,
  getStockPositions,
  getAccountBalance,
  getHistoryOrders,
  type LbBalance,
  type LbPosition,
  type LbTrade,
} from "~/server/longbridge";
import {
  computeAnalytics,
  type CashFlowLike,
  type TradeLike,
} from "~/server/ibkr-analytics";
import { decryptCredentials, encryptCredentials } from "~/server/crypto";
import type { AppDb } from "~/server/db";

/**
 * Read-only Longbridge (長橋證券) integration.
 *
 * Longbridge publishes an official cloud OpenAPI, so unlike Questrade there
 * is no rotating token: the user's App Key + App Secret + Access Token
 * (from open.longportapp.com → user center) are long-lived. They are
 * stored AES-GCM encrypted in the existing BrokerCredential table under a
 * namespaced key "longbridge:<userId>", with all three secrets packed as
 * JSON into the token slot (encryptCredentials only has two slots).
 *
 * Storage design (no D1 migration needed):
 * - Positions/trades share the Broker* tables with IBKR/Questrade. Rows
 *   are namespaced by accountId prefix "longbridge:<account_channel>" and
 *   every read/write filters or deletes by that prefix, so brokers can
 *   never clobber each other.
 *
 * Currency: accounts routinely hold HKD and USD. Totals are computed PER
 * CURRENCY and never summed across currencies; the shared analytics
 * converts to USD with explicit FX rates (see ibkr-analytics).
 *
 * The client is read-only by construction — no order/trading endpoints
 * exist in ~/server/longbridge.
 */

export const LB_PREFIX = "longbridge:";
/** Per-user namespacing: rows are NEVER shared across users. */
const lbAccountId = (userId: string, channel: string) => `${LB_PREFIX}${userId}:${channel}`;
const lbUserPrefix = (userId: string) => `${LB_PREFIX}${userId}:`;
const lbCredKey = (userId: string) => `${LB_PREFIX}${userId}`;

const SETUP_HINT =
  "Longbridge is not connected. Log in at open.longportapp.com → user center → " +
  "create an app → copy the App Key, App Secret and Access Token. " +
  "Paste all three below — the credentials are verified live, then stored encrypted.";

const syncInput = z
  .object({
    /** Transient credentials for this sync only (never persisted). */
    appKey: z.string().min(1).max(500).optional(),
    appSecret: z.string().min(1).max(500).optional(),
    accessToken: z.string().min(1).max(2000).optional(),
  })
  .optional()
  .refine(
    (v) =>
      !v ||
      (v.appKey !== undefined && v.appSecret !== undefined && v.accessToken !== undefined),
    {
      message:
        "Provide appKey, appSecret and accessToken together, or none to use saved credentials.",
    },
  );

interface LbSyncPosition extends LbPosition {
  assetCategory: string;
}

interface LbCredentials {
  appKey: string;
  appSecret: string;
  accessToken: string;
}

function parseStoredCredentials(json: string): LbCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Saved Longbridge credentials are corrupt. Please connect again.",
    });
  }
  const r =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  if (
    typeof r?.appKey !== "string" ||
    typeof r?.appSecret !== "string" ||
    typeof r?.accessToken !== "string" ||
    !r.appKey ||
    !r.appSecret ||
    !r.accessToken
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Saved Longbridge credentials are corrupt. Please connect again.",
    });
  }
  return { appKey: r.appKey, appSecret: r.appSecret, accessToken: r.accessToken };
}

/** Delete only THIS USER's Longbridge rows (the D1 adapter implements it;
 *  the local Prisma fallback does not — broker syncs need the D1 binding). */
async function deleteLongbridgeRows(db: AppDb, userPrefix: string): Promise<void> {
  const bp = db.brokerPosition;
  const bt = db.brokerTrade;
  const bc = db.brokerCashFlow;
  if (!bp.deleteByAccountPrefix || !bt.deleteByAccountPrefix || !bc.deleteByAccountPrefix) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Longbridge sync needs the D1 database binding (not available in this runtime).",
    });
  }
  // Bound calls — the methods stay attached to their table objects.
  await bp.deleteByAccountPrefix(userPrefix);
  await bt.deleteByAccountPrefix(userPrefix);
  await bc.deleteByAccountPrefix(userPrefix);
}

const lbRows = <T extends { accountId: string }>(rows: T[], userPrefix: string): T[] =>
  rows.filter((r) => r.accountId.startsWith(userPrefix));

function errMessage(e: unknown): string {
  // Never leak credentials into error messages.
  return e instanceof LongbridgeError ? e.message : "Longbridge sync failed unexpectedly.";
}

export const longbridgeRouter = createTRPCRouter({
  status: publicProcedure.query(async ({ ctx }) => {
    const userId = ctx.session?.user?.id;
    // Rows are namespaced per user — logged-out visitors see nothing.
    if (!userId) {
      return {
        configured: false,
        positionCount: 0,
        lastSyncedAt: null,
        positions: [],
      };
    }
    const userPrefix = lbUserPrefix(userId);
    const saved = await ctx.db.brokerCredential.findUnique({
      where: { userId: lbCredKey(userId) },
    });
    const rows = lbRows(
      await ctx.db.brokerPosition.findMany({ orderBy: [{ symbol: "asc" }] }),
      userPrefix,
    );
    const lastSyncedAt = rows.reduce<Date | null>(
      (max, r) => (max == null || r.syncedAt > max ? r.syncedAt : max),
      null,
    );
    return {
      configured: saved != null,
      positionCount: rows.length,
      lastSyncedAt,
      positions: rows.map((r) => ({
        id: r.id,
        accountNumber: r.accountId.slice(userPrefix.length),
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
    // Credential resolution:
    // 1. appKey/appSecret/accessToken passed with the request — transient,
    //    used for this sync only, never persisted.
    // 2. Saved encrypted credentials for a logged-in user.
    let creds: LbCredentials | null =
      input?.appKey && input?.appSecret && input?.accessToken
        ? { appKey: input.appKey, appSecret: input.appSecret, accessToken: input.accessToken }
        : null;
    const transient = creds !== null;
    const userId = ctx.session?.user?.id;

    if (!creds && userId) {
      const row = await ctx.db.brokerCredential.findUnique({
        where: { userId: lbCredKey(userId) },
      });
      if (row) {
        try {
          const dec = await decryptCredentials(row.iv, row.encToken, row.encQueryId);
          creds = parseStoredCredentials(dec.token);
        } catch (e) {
          if (e instanceof TRPCError) throw e;
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Saved Longbridge credentials could not be decrypted (the server key may have changed). Please connect again.",
          });
        }
      }
    }
    if (!creds) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: SETUP_HINT });
    }

    const now = new Date();
    const oneYearAgo = new Date(now.getTime() - 365 * 24 * 3600 * 1000);

    let rawPositions: LbPosition[];
    let balances: LbBalance[];
    let trades: LbTrade[];
    try {
      [rawPositions, balances, trades] = await Promise.all([
        getStockPositions(creds.appKey, creds.appSecret, creds.accessToken),
        getAccountBalance(creds.appKey, creds.appSecret, creds.accessToken),
        getHistoryOrders(creds.appKey, creds.appSecret, creds.accessToken, oneYearAgo, now),
      ]);
    } catch (e) {
      throw new TRPCError({ code: "BAD_REQUEST", message: errMessage(e) });
    }

    const positions: LbSyncPosition[] = rawPositions.map((p) => ({
      ...p,
      assetCategory: "STK",
    }));
    const syncBalances: LbBalance[] = balances;

    const tradeLikes: TradeLike[] = trades.map((t, i) => ({
      id: `lb-${t.orderId}-${i}`,
      symbol: t.symbol,
      tradeDate: t.tradeDate,
      quantity: t.quantity,
      tradePrice: t.tradePrice,
      commission: null,
      realizedPnl: null, // order history doesn't report per-trade realized P/L
      openClose: null,
      currency: t.currency ?? "HKD",
    }));
    const cashLikes: CashFlowLike[] = [];

    // Persist: replace only THIS USER's rows. Transient syncs (pasted
    // credentials, or logged-out) return the data without touching the DB.
    const persisted = !transient && userId != null;
    // Order history doesn't always report its account channel — fall back
    // to the single channel when all positions share one.
    const channels = [...new Set(positions.map((p) => p.accountChannel))];
    const fallbackChannel = channels.length === 1 ? channels[0]! : "orders";
    if (persisted && userId) {
      const userPrefix = lbUserPrefix(userId);
      await deleteLongbridgeRows(ctx.db, userPrefix);
      // Positions without a resolved currency are kept out of the tables
      // (they'd poison currency math) but stay visible in the response.
      const storable = positions.filter(
        (p): p is LbSyncPosition & { currency: string } => p.currency !== null,
      );
      const nonzero = storable.filter((p) => p.quantity !== 0);
      if (nonzero.length > 0) {
        await ctx.db.brokerPosition.createMany({
          data: nonzero.map((p) => ({
            accountId: lbAccountId(userId, p.accountChannel),
            symbol: p.symbol,
            description: p.description,
            assetCategory: p.assetCategory,
            currency: p.currency,
            quantity: p.quantity,
            // /v1/asset/stock reports cost but no mark price.
            markPrice: null,
          })),
        });
      }
      if (tradeLikes.length > 0) {
        await ctx.db.brokerTrade.createMany({
          data: tradeLikes.map((t, i) => ({
            accountId: lbAccountId(userId, trades[i]?.accountChannel ?? fallbackChannel),
            symbol: t.symbol,
            description: null,
            assetCategory: "STK",
            currency: t.currency ?? "HKD",
            tradeDate: t.tradeDate,
            quantity: t.quantity,
            tradePrice: t.tradePrice,
            commission: t.commission,
          })),
        });
      }
    }

    const analytics = await computeAnalytics(tradeLikes, cashLikes);

    return {
      persisted,
      positions,
      balances: syncBalances,
      trades,
      tradeCount: trades.length,
      analytics,
      syncedAt: now,
    };
  }),

  /**
   * First-time connect: verify the pasted credentials with a live
   * getStockPositions call, then save them encrypted.
   */
  saveCredentials: protectedProcedure
    .input(
      z.object({
        appKey: z.string().min(1).max(500),
        appSecret: z.string().min(1).max(500),
        accessToken: z.string().min(1).max(2000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await getStockPositions(input.appKey, input.appSecret, input.accessToken);
      } catch (e) {
        throw new TRPCError({ code: "BAD_REQUEST", message: errMessage(e) });
      }
      const userId = ctx.session.user.id;
      const enc = await encryptCredentials(
        JSON.stringify({
          appKey: input.appKey,
          appSecret: input.appSecret,
          accessToken: input.accessToken,
        }),
        "",
      );
      await ctx.db.brokerCredential.upsert({
        where: { userId: lbCredKey(userId) },
        update: { encToken: enc.encToken, encQueryId: enc.encQueryId, iv: enc.iv },
        create: {
          userId: lbCredKey(userId),
          encToken: enc.encToken,
          encQueryId: enc.encQueryId,
          iv: enc.iv,
        },
      });
      return { saved: true };
    }),

  /** Whether the caller has saved Longbridge credentials (never returns them). */
  savedCredentials: protectedProcedure.query(async ({ ctx }) => {
    const row = await ctx.db.brokerCredential.findUnique({
      where: { userId: lbCredKey(ctx.session.user.id) } },
    );
    return { saved: row != null };
  }),

  /** Delete the caller's saved Longbridge credentials and THEIR synced rows. */
  clearCredentials: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.session.user.id;
    const key = lbCredKey(userId);
    const row = await ctx.db.brokerCredential.findUnique({ where: { userId: key } });
    if (row) {
      await ctx.db.brokerCredential.delete({ where: { userId: key } });
    }
    await deleteLongbridgeRows(ctx.db, lbUserPrefix(userId));
    return { cleared: true };
  }),

  /** Analytics over this broker's synced trades (native currency → USD via
   *  explicit FX rates, same as IBKR/Questrade). */
  analytics: publicProcedure.query(async ({ ctx }) => {
    const userId = ctx.session?.user?.id;
    if (!userId) return computeAnalytics([], []);
    const userPrefix = lbUserPrefix(userId);
    const trades = lbRows(
      await ctx.db.brokerTrade.findMany({ orderBy: [{ tradeDate: "desc" }] }),
      userPrefix,
    );
    const cashFlows = lbRows(
      await ctx.db.brokerCashFlow.findMany({ orderBy: [{ dateTime: "desc" }] }),
      userPrefix,
    );
    return computeAnalytics(trades, cashFlows);
  }),
});
