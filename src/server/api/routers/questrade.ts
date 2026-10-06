import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createTRPCRouter, protectedProcedure, publicProcedure } from "~/server/api/trpc";
import {
  QuestradeError,
  exchangeRefreshToken,
  getAccounts,
  getPositions,
  getBalances,
  getActivities,
  resolvePositionCurrencies,
  activityToTrade,
  activityToCashFlow,
  reconcileAccount,
  type QtActivity,
  type QtBalance,
  type QtPosition,
  type ReconciliationIssue,
} from "~/server/questrade";
import {
  computeAnalytics,
  type CashFlowLike,
  type TradeLike,
} from "~/server/ibkr-analytics";
import { decryptCredentials, encryptCredentials } from "~/server/crypto";
import type { AppDb } from "~/server/db";

/**
 * Read-only Questrade integration.
 *
 * Storage design (no D1 migration needed):
 * - Positions/trades/cash flows share the Broker* tables with IBKR. Rows
 *   are namespaced by accountId prefix "questrade:<number>" and every
 *   read/write filters or deletes by that prefix, so the two brokers can
 *   never clobber each other.
 * - Refresh tokens rotate on EVERY exchange, so env secrets can't work.
 *   They are stored AES-GCM encrypted in the existing BrokerCredential
 *   table under a namespaced key "questrade:<userId>" (IBKR uses the bare
 *   userId), reusing encryptCredentials(refreshToken, apiServer).
 *
 * Currency: accounts routinely hold CAD and USD. Totals are computed PER
 * CURRENCY and never summed across currencies; the shared analytics
 * converts to USD with explicit FX rates (see ibkr-analytics).
 */

export const QT_PREFIX = "questrade:";
const qtAccountId = (n: string) => `${QT_PREFIX}${n}`;
const qtCredKey = (userId: string) => `${QT_PREFIX}${userId}`;

const SETUP_HINT =
  "Questrade is not connected. Log in to Questrade → top-right menu → API centre → " +
  "register a personal app → New manual authorization → Generate new token → Copy token. " +
  "Paste it below — the first sync exchanges it and stores the rotated token encrypted.";

const syncInput = z
  .object({
    /** Current refresh token (browser flow: kept in localStorage, rotated each sync). */
    refreshToken: z.string().min(1).max(4000).optional(),
    /** Use the practice (paper-trading) login host. */
    practice: z.boolean().optional(),
  })
  .optional();

interface QtSyncPosition {
  accountNumber: string;
  symbol: string;
  currency: string | null;
  quantity: number;
  currentPrice: number | null;
  marketValue: number;
  averageEntryPrice: number | null;
  totalCost: number | null;
  openPnl: number | null;
  dayPnl: number | null;
  assetCategory: string;
}

interface QtSyncBalance extends QtBalance {
  accountNumber: string;
}

/** Delete only this broker's rows (the D1 adapter implements it; the local
 *  Prisma fallback does not — broker syncs need the D1 binding). */
async function deleteQuestradeRows(db: AppDb): Promise<void> {
  const bp = db.brokerPosition;
  const bt = db.brokerTrade;
  const bc = db.brokerCashFlow;
  if (!bp.deleteByAccountPrefix || !bt.deleteByAccountPrefix || !bc.deleteByAccountPrefix) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Questrade sync needs the D1 database binding (not available in this runtime).",
    });
  }
  // Bound calls — the methods stay attached to their table objects.
  await bp.deleteByAccountPrefix(QT_PREFIX);
  await bt.deleteByAccountPrefix(QT_PREFIX);
  await bc.deleteByAccountPrefix(QT_PREFIX);
}

const qtRows = <T extends { accountId: string }>(rows: T[]): T[] =>
  rows.filter((r) => r.accountId.startsWith(QT_PREFIX));

function errMessage(e: unknown): string {
  // Never leak tokens into error messages.
  return e instanceof QuestradeError ? e.message : "Questrade sync failed unexpectedly.";
}

export const questradeRouter = createTRPCRouter({
  status: publicProcedure.query(async ({ ctx }) => {
    const userId = ctx.session?.user?.id;
    const saved = userId
      ? await ctx.db.brokerCredential.findUnique({ where: { userId: qtCredKey(userId) } })
      : null;
    const rows = qtRows(
      await ctx.db.brokerPosition.findMany({ orderBy: [{ symbol: "asc" }] }),
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
        accountNumber: r.accountId.slice(QT_PREFIX.length),
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
    // 1. refreshToken passed with the request (browser flow — the rotated
    //    token comes back in the response so the client can store it).
    // 2. Saved encrypted credentials for a logged-in user.
    let refreshToken = input?.refreshToken;
    const practice = input?.practice ?? false;
    const userId = ctx.session?.user?.id;

    if (!refreshToken && userId) {
      const row = await ctx.db.brokerCredential.findUnique({
        where: { userId: qtCredKey(userId) },
      });
      if (row) {
        try {
          const dec = await decryptCredentials(row.iv, row.encToken, row.encQueryId);
          refreshToken = dec.token;
        } catch {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Saved Questrade credentials could not be decrypted (the server key may have changed). Please connect again.",
          });
        }
      }
    }
    if (!refreshToken) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: SETUP_HINT });
    }

    // Every exchange rotates the refresh token — persist the NEW one.
    let creds;
    try {
      creds = await exchangeRefreshToken(refreshToken, { practice });
    } catch (e) {
      throw new TRPCError({ code: "BAD_REQUEST", message: errMessage(e) });
    }
    if (userId) {
      const enc = await encryptCredentials(creds.refreshToken, creds.apiServer);
      await ctx.db.brokerCredential.upsert({
        where: { userId: qtCredKey(userId) },
        update: { encToken: enc.encToken, encQueryId: enc.encQueryId, iv: enc.iv },
        create: {
          userId: qtCredKey(userId),
          encToken: enc.encToken,
          encQueryId: enc.encQueryId,
          iv: enc.iv,
        },
      });
    }

    const now = new Date();
    const oneYearAgo = new Date(now.getTime() - 365 * 24 * 3600 * 1000);

    let accounts;
    try {
      accounts = await getAccounts(creds.apiServer, creds.accessToken);
    } catch (e) {
      throw new TRPCError({ code: "BAD_REQUEST", message: errMessage(e) });
    }
    if (accounts.length === 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Questrade returned no accounts." });
    }

    // Fetch per account (sequential across accounts; parallel within one).
    const perAccount: {
      number: string;
      rawPositions: Awaited<ReturnType<typeof getPositions>>;
      balances: QtBalance[];
      activities: QtActivity[];
    }[] = [];
    try {
      for (const acct of accounts) {
        const [rawPositions, balances, activities] = await Promise.all([
          getPositions(creds.apiServer, creds.accessToken, acct.number),
          getBalances(creds.apiServer, creds.accessToken, acct.number),
          getActivities(creds.apiServer, creds.accessToken, acct.number, oneYearAgo, now),
        ]);
        perAccount.push({ number: acct.number, rawPositions, balances, activities });
      }
    } catch (e) {
      throw new TRPCError({ code: "BAD_REQUEST", message: errMessage(e) });
    }

    // Positions carry no currency — resolve per symbolId, with a fallback:
    // when an account's market value sits in a single currency bucket, an
    // unresolvable symbol must be in that currency.
    const allSymbolIds = perAccount.flatMap((a) => a.rawPositions.map((p) => p.symbolId));
    let currencyMap: Awaited<ReturnType<typeof resolvePositionCurrencies>>;
    try {
      currencyMap = await resolvePositionCurrencies(creds.apiServer, creds.accessToken, allSymbolIds);
    } catch (e) {
      throw new TRPCError({ code: "BAD_REQUEST", message: errMessage(e) });
    }

    const positions: QtSyncPosition[] = [];
    const balances: QtSyncBalance[] = [];
    const reconciliation: ReconciliationIssue[] = [];
    const tradeLikes: TradeLike[] = [];
    const cashLikes: CashFlowLike[] = [];
    /** DB rows keep their account number alongside the analytics shape. */
    const tradeAccounts: string[] = [];
    const cashAccounts: string[] = [];

    for (const a of perAccount) {
      const nonzero = a.balances.filter((b) => b.marketValue > 0);
      const fallbackCurrency = nonzero.length === 1 ? nonzero[0]!.currency : null;

      const enriched: QtPosition[] = a.rawPositions.map((p) => {
        const info = currencyMap.get(p.symbolId);
        return {
          ...p,
          currency: info?.currency ?? fallbackCurrency,
          assetCategory: info?.assetCategory ?? "STK",
        };
      });

      reconciliation.push(...reconcileAccount(a.number, enriched, a.balances));
      for (const b of a.balances) balances.push({ ...b, accountNumber: a.number });

      let ti = 0;
      let ci = 0;
      for (const act of a.activities) {
        const t = activityToTrade(act, a.number);
        if (t) {
          tradeLikes.push({
            id: `qt-${a.number}-${ti++}`,
            symbol: t.symbol,
            tradeDate: t.tradeDate,
            quantity: t.quantity,
            tradePrice: t.tradePrice,
            commission: t.commission,
            realizedPnl: null, // Questrade activities don't report per-trade realized P/L
            openClose: null,
            currency: t.currency,
          });
          tradeAccounts.push(a.number);
        }
        const c = activityToCashFlow(act, a.number);
        if (c) {
          cashLikes.push({
            id: `qt-${a.number}-${ci++}`,
            type: c.type,
            symbol: c.symbol,
            dateTime: c.dateTime,
            amount: c.amount,
            currency: c.currency,
          });
          cashAccounts.push(a.number);
        }
      }

      for (const p of enriched) {
        positions.push({
          accountNumber: p.accountNumber,
          symbol: p.symbol,
          currency: p.currency,
          quantity: p.openQuantity,
          currentPrice: p.currentPrice,
          marketValue: p.currentMarketValue,
          averageEntryPrice: p.averageEntryPrice,
          totalCost: p.totalCost,
          openPnl: p.openPnl,
          dayPnl: p.dayPnl,
          assetCategory: p.assetCategory,
        });
      }
    }

    // Persist: replace only this broker's rows. Positions without a resolved
    // currency are kept out of the tables (they'd poison currency math) but
    // stay visible in the response + reconciliation.
    await deleteQuestradeRows(ctx.db);
    const storable = positions.filter(
      (p): p is QtSyncPosition & { currency: string } => p.currency !== null,
    );
    if (storable.length > 0) {
      await ctx.db.brokerPosition.createMany({
        data: storable.map((p) => ({
          accountId: qtAccountId(p.accountNumber),
          symbol: p.symbol,
          description: null,
          assetCategory: p.assetCategory,
          currency: p.currency,
          quantity: p.quantity,
          markPrice: p.currentPrice,
        })),
      });
    }
    if (tradeLikes.length > 0) {
      await ctx.db.brokerTrade.createMany({
        data: tradeLikes.map((t, i) => ({
          accountId: qtAccountId(tradeAccounts[i] ?? ""),
          symbol: t.symbol,
          description: null,
          assetCategory: "STK",
          currency: t.currency ?? "CAD",
          tradeDate: t.tradeDate,
          quantity: t.quantity,
          tradePrice: t.tradePrice,
          commission: t.commission,
        })),
      });
    }
    if (cashLikes.length > 0) {
      await ctx.db.brokerCashFlow.createMany({
        data: cashLikes.map((c, i) => ({
          accountId: qtAccountId(cashAccounts[i] ?? ""),
          symbol: c.symbol,
          description: null,
          currency: c.currency ?? "CAD",
          dateTime: c.dateTime,
          amount: c.amount,
          type: c.type,
        })),
      });
    }

    if (reconciliation.length > 0) {
      console.warn(
        `[questrade] ${reconciliation.length} reconciliation issue(s):`,
        reconciliation.map((r) => r.message).join(" | "),
      );
    }

    const analytics = await computeAnalytics(tradeLikes, cashLikes);

    return {
      persisted: true,
      positions,
      balances,
      reconciliation,
      analytics,
      syncedAt: now,
      /** The ROTATED refresh token — the client must store this, not the old one. */
      newRefreshToken: creds.refreshToken,
    };
  }),

  /**
   * First-time connect: validate a pasted manual authorization token by
   * exchanging it immediately, then save the rotated token encrypted.
   */
  saveCredentials: protectedProcedure
    .input(
      z.object({
        refreshToken: z.string().min(1).max(4000),
        practice: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let creds;
      try {
        creds = await exchangeRefreshToken(input.refreshToken, {
          practice: input.practice ?? false,
        });
      } catch (e) {
        throw new TRPCError({ code: "BAD_REQUEST", message: errMessage(e) });
      }
      const userId = ctx.session.user.id;
      const enc = await encryptCredentials(creds.refreshToken, creds.apiServer);
      await ctx.db.brokerCredential.upsert({
        where: { userId: qtCredKey(userId) },
        update: { encToken: enc.encToken, encQueryId: enc.encQueryId, iv: enc.iv },
        create: {
          userId: qtCredKey(userId),
          encToken: enc.encToken,
          encQueryId: enc.encQueryId,
          iv: enc.iv,
        },
      });
      return { saved: true };
    }),

  /** Whether the caller has saved Questrade credentials (never returns them). */
  savedCredentials: protectedProcedure.query(async ({ ctx }) => {
    const row = await ctx.db.brokerCredential.findUnique({
      where: { userId: qtCredKey(ctx.session.user.id) },
    });
    return { saved: row != null };
  }),

  /**
   * Return the caller's decrypted Questrade refresh token + api server so
   * they can back them up. Same deliberate exception as IBKR's export: it
   * is the user's own credential, and Questrade personal tokens are
   * read-only (they cannot place trades).
   */
  exportCredentials: protectedProcedure.query(async ({ ctx }) => {
    const row = await ctx.db.brokerCredential.findUnique({
      where: { userId: qtCredKey(ctx.session.user.id) },
    });
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: "No saved credentials" });
    }
    const dec = await decryptCredentials(row.iv, row.encToken, row.encQueryId);
    return { refreshToken: dec.token, apiServer: dec.queryId };
  }),

  /** Delete the caller's saved Questrade credentials. */
  clearCredentials: protectedProcedure.mutation(async ({ ctx }) => {
    const key = qtCredKey(ctx.session.user.id);
    const row = await ctx.db.brokerCredential.findUnique({ where: { userId: key } });
    if (row) {
      await ctx.db.brokerCredential.delete({ where: { userId: key } });
    }
    return { cleared: true };
  }),

  /** Analytics over this broker's synced trades/cash flows (native currency
   *  → USD via explicit FX rates, same as IBKR). */
  analytics: publicProcedure.query(async ({ ctx }) => {
    const trades = qtRows(
      await ctx.db.brokerTrade.findMany({ orderBy: [{ tradeDate: "desc" }] }),
    );
    const cashFlows = qtRows(
      await ctx.db.brokerCashFlow.findMany({ orderBy: [{ dateTime: "desc" }] }),
    );
    return computeAnalytics(trades, cashFlows);
  }),
});
