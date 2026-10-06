import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createTRPCRouter, protectedProcedure, publicProcedure } from "~/server/api/trpc";
import {
  WebullError,
  getAccountList,
  getBalance,
  getPositions,
  getOrderHistory,
  normalizeWebullSymbol,
  type WebullCredentials,
  type WbTrade,
} from "~/server/webull";
import { computeAnalytics } from "~/server/ibkr-analytics";
import { decryptCredentials, encryptCredentials } from "~/server/crypto";
import type { AppDb } from "~/server/db";

/**
 * Read-only Webull integration.
 *
 * Storage design (no D1 migration needed):
 * - Positions/trades share the Broker* tables with IBKR/Questrade. Rows are
 *   namespaced by accountId prefix "webull:<account_id>" and every
 *   read/write filters or deletes by that prefix, so brokers can never
 *   clobber each other.
 * - The App Key/Secret authenticate EVERY request via HMAC-SHA1 signature
 *   (no session, no rotation). They are stored AES-GCM encrypted in the
 *   existing BrokerCredential table under a namespaced key
 *   "webull:<userId>" (IBKR uses the bare userId), reusing
 *   encryptCredentials(JSON.stringify({appKey, appSecret, accessToken?}), "").
 *
 * Webull has no server-side OAuth for individuals — the user pastes the App
 * Key/Secret from developer.webull.com once. Transient (logged-out) syncs
 * keep the credentials in browser memory only and never persist them.
 */

export const WB_PREFIX = "webull:";
/** Per-user namespacing: rows are NEVER shared across users. */
const wbAccountId = (userId: string, id: string) => `${WB_PREFIX}${userId}:${id}`;
const wbUserPrefix = (userId: string) => `${WB_PREFIX}${userId}:`;
const wbCredKey = (userId: string) => `${WB_PREFIX}${userId}`;

const SETUP_HINT =
  "Webull is not connected. Go to developer.webull.com → apply for individual API access → " +
  "create an app → copy your App Key and App Secret. Paste them below — the credentials " +
  "are read-only and can never place trades.";

const syncInput = z
  .object({
    /** Transient credentials for this sync only — never persisted. */
    appKey: z.string().min(1).max(500).optional(),
    appSecret: z.string().min(1).max(500).optional(),
    /** Only when the deployment has token check enabled. */
    accessToken: z.string().min(1).max(2000).optional(),
    /** Sync a specific account; defaults to the first account returned. */
    accountId: z.string().min(1).max(100).optional(),
  })
  .optional();

interface WbSyncPosition {
  symbol: string;
  quantity: number;
  costPrice: number | null;
  currency: string;
  instrumentType: string | null;
}

interface WbSyncBalance {
  accountNumber: string;
  currency: string;
  cash: number | null;
  marketValue: number | null;
  netLiquidation: number | null;
}

/** Delete only THIS USER's Webull rows (the D1 adapter implements it; the
 *  local Prisma fallback does not — broker syncs need the D1 binding). */
async function deleteWebullRows(db: AppDb, userPrefix: string): Promise<void> {
  const bp = db.brokerPosition;
  const bt = db.brokerTrade;
  const bc = db.brokerCashFlow;
  if (!bp.deleteByAccountPrefix || !bt.deleteByAccountPrefix || !bc.deleteByAccountPrefix) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Webull sync needs the D1 database binding (not available in this runtime).",
    });
  }
  // Bound calls — the methods stay attached to their table objects.
  await bp.deleteByAccountPrefix(userPrefix);
  await bt.deleteByAccountPrefix(userPrefix);
  await bc.deleteByAccountPrefix(userPrefix);
}

const wbRows = <T extends { accountId: string }>(rows: T[], userPrefix: string): T[] =>
  rows.filter((r) => r.accountId.startsWith(userPrefix));

function errMessage(e: unknown): string {
  // Never leak credentials into error messages.
  return e instanceof WebullError ? e.message : "Webull sync failed unexpectedly.";
}

interface SavedWbCreds {
  appKey: string;
  appSecret: string;
  accessToken?: string;
}

function parseSavedCreds(raw: string): SavedWbCreds | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const r = parsed as Record<string, unknown>;
  if (typeof r.appKey !== "string" || r.appKey === "" || typeof r.appSecret !== "string" || r.appSecret === "") {
    return null;
  }
  const out: SavedWbCreds = { appKey: r.appKey, appSecret: r.appSecret };
  if (typeof r.accessToken === "string" && r.accessToken !== "") {
    out.accessToken = r.accessToken;
  }
  return out;
}

/**
 * Credential resolution:
 * 1. appKey/appSecret passed with the request — transient, never persisted
 *    (used by logged-out users and by "don't save" syncs).
 * 2. Saved encrypted credentials for a logged-in user.
 */
async function resolveCreds(
  db: AppDb,
  userId: string | undefined,
  input: z.infer<typeof syncInput>,
): Promise<{ creds: WebullCredentials; transient: boolean }> {
  const appKey = input?.appKey?.trim();
  const appSecret = input?.appSecret?.trim();
  if (appKey && appSecret) {
    const accessToken = input?.accessToken?.trim();
    return {
      creds: {
        appKey,
        appSecret,
        ...(accessToken ? { accessToken } : {}),
      },
      transient: true,
    };
  }
  if (userId) {
    const row = await db.brokerCredential.findUnique({
      where: { userId: wbCredKey(userId) },
    });
    if (row) {
      try {
        const dec = await decryptCredentials(row.iv, row.encToken, row.encQueryId);
        const parsed = parseSavedCreds(dec.token);
        if (parsed) return { creds: parsed, transient: false };
      } catch {
        // fall through to the precondition error below
      }
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "Saved Webull credentials could not be decrypted (the server key may have changed). Please connect again.",
      });
    }
  }
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: SETUP_HINT });
}

export const webullRouter = createTRPCRouter({
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
    const userPrefix = wbUserPrefix(userId);
    const saved = await ctx.db.brokerCredential.findUnique({
      where: { userId: wbCredKey(userId) },
    });
    const rows = wbRows(
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
    const userId = ctx.session?.user?.id;
    const { creds, transient } = await resolveCreds(ctx.db, userId, input);

    const now = new Date();
    const oneYearAgo = new Date(now.getTime() - 365 * 24 * 3600 * 1000);
    const cutoffYmd =
      `${oneYearAgo.getUTCFullYear()}` +
      `${String(oneYearAgo.getUTCMonth() + 1).padStart(2, "0")}` +
      `${String(oneYearAgo.getUTCDate()).padStart(2, "0")}`;

    let accounts;
    try {
      accounts = await getAccountList(creds);
    } catch (e) {
      throw new TRPCError({ code: "BAD_REQUEST", message: errMessage(e) });
    }
    if (accounts.length === 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Webull returned no accounts." });
    }
    const rawAccountId = input?.accountId?.trim();
    const accountId = rawAccountId ? rawAccountId : accounts[0]!.accountId;
    if (!accounts.some((a) => a.accountId === accountId)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Unknown Webull account "${accountId}".`,
      });
    }

    let positions: Awaited<ReturnType<typeof getPositions>>;
    let balance: Awaited<ReturnType<typeof getBalance>>;
    let orderTrades: WbTrade[];
    try {
      [positions, balance, orderTrades] = await Promise.all([
        getPositions(creds, accountId),
        getBalance(creds, accountId),
        getOrderHistory(creds, accountId),
      ]);
    } catch (e) {
      throw new TRPCError({ code: "BAD_REQUEST", message: errMessage(e) });
    }

    // Client-side 1-year filter on order history; orders without a parseable
    // date can't be stored (brokerTrade requires tradeDate).
    const trades = orderTrades.filter(
      (t): t is WbTrade & { tradeDate: string } =>
        t.tradeDate !== null && t.tradeDate >= cutoffYmd,
    );

    // Persist only for logged-in users syncing with SAVED credentials.
    // Transient syncs (pasted keys, or logged-out) return the data without
    // touching the database — one user's sync can never wipe another's rows.
    const persisted = !transient && userId != null;
    if (persisted && userId) {
      const userPrefix = wbUserPrefix(userId);
      await deleteWebullRows(ctx.db, userPrefix);
      const syncPositions: WbSyncPosition[] = positions.map((p) => ({
        symbol: normalizeWebullSymbol(p.symbol),
        quantity: p.quantity,
        costPrice: p.costPrice,
        currency: p.currency ?? "USD",
        instrumentType: p.instrumentType,
      }));
      if (syncPositions.length > 0) {
        await ctx.db.brokerPosition.createMany({
          data: syncPositions.map((p) => ({
            accountId: wbAccountId(userId, accountId),
            symbol: p.symbol,
            description: null,
            assetCategory: "STK",
            currency: p.currency,
            quantity: p.quantity,
            markPrice: null, // Webull positions carry no quote; prices come from the quote feed
          })),
        });
      }
      if (trades.length > 0) {
        await ctx.db.brokerTrade.createMany({
          data: trades.map((t) => ({
            accountId: wbAccountId(userId, accountId),
            symbol: normalizeWebullSymbol(t.symbol),
            description: null,
            assetCategory: "STK",
            currency: t.currency ?? "USD",
            tradeDate: t.tradeDate,
            quantity: t.quantity,
            tradePrice: t.tradePrice,
            commission: null,
          })),
        });
      }
    }

    const syncPositions: WbSyncPosition[] = positions.map((p) => ({
      symbol: normalizeWebullSymbol(p.symbol),
      quantity: p.quantity,
      costPrice: p.costPrice,
      currency: p.currency ?? "USD",
      instrumentType: p.instrumentType,
    }));

    const syncBalances: WbSyncBalance[] = [
      {
        accountNumber: accountId,
        currency: balance.currency ?? "USD",
        cash: balance.totalCashBalance,
        marketValue: balance.totalMarketValue,
        netLiquidation: balance.totalNetLiquidationValue,
      },
    ];

    return {
      persisted,
      accountId,
      positions: syncPositions,
      balances: syncBalances,
      trades: trades.length,
      syncedAt: now,
    };
  }),

  /**
   * First-time connect: validate the pasted App Key/Secret with a live
   * account-list call, then save them encrypted. Transient syncs never
   * touch this.
   */
  saveCredentials: protectedProcedure
    .input(
      z.object({
        appKey: z.string().trim().min(1).max(500),
        appSecret: z.string().trim().min(1).max(500),
        accessToken: z.string().trim().min(1).max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const creds: WebullCredentials = {
        appKey: input.appKey,
        appSecret: input.appSecret,
        ...(input.accessToken ? { accessToken: input.accessToken } : {}),
      };
      try {
        await getAccountList(creds);
      } catch (e) {
        throw new TRPCError({ code: "BAD_REQUEST", message: errMessage(e) });
      }
      const userId = ctx.session.user.id;
      const payload = JSON.stringify({
        appKey: input.appKey,
        appSecret: input.appSecret,
        ...(input.accessToken ? { accessToken: input.accessToken } : {}),
      });
      const enc = await encryptCredentials(payload, "");
      await ctx.db.brokerCredential.upsert({
        where: { userId: wbCredKey(userId) },
        update: { encToken: enc.encToken, encQueryId: enc.encQueryId, iv: enc.iv },
        create: {
          userId: wbCredKey(userId),
          encToken: enc.encToken,
          encQueryId: enc.encQueryId,
          iv: enc.iv,
        },
      });
      return { saved: true };
    }),

  /** Whether the caller has saved Webull credentials (never returns them). */
  savedCredentials: protectedProcedure.query(async ({ ctx }) => {
    const row = await ctx.db.brokerCredential.findUnique({
      where: { userId: wbCredKey(ctx.session.user.id) },
    });
    return { saved: row != null };
  }),

  /** Delete the caller's saved Webull credentials AND their synced rows. */
  clearCredentials: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.session.user.id;
    const key = wbCredKey(userId);
    const row = await ctx.db.brokerCredential.findUnique({ where: { userId: key } });
    if (row) {
      await ctx.db.brokerCredential.delete({ where: { userId: key } });
    }
    await deleteWebullRows(ctx.db, wbUserPrefix(userId));
    return { cleared: true };
  }),

  /** Analytics over this broker's synced trades (native currency → USD via
   *  explicit FX rates, same as IBKR/Questrade). */
  analytics: publicProcedure.query(async ({ ctx }) => {
    const userId = ctx.session?.user?.id;
    if (!userId) return computeAnalytics([], []);
    const userPrefix = wbUserPrefix(userId);
    const trades = wbRows(
      await ctx.db.brokerTrade.findMany({ orderBy: [{ tradeDate: "desc" }] }),
      userPrefix,
    );
    const cashFlows = wbRows(
      await ctx.db.brokerCashFlow.findMany({ orderBy: [{ dateTime: "desc" }] }),
      userPrefix,
    );
    return computeAnalytics(trades, cashFlows);
  }),
});
