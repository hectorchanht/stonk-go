import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createTRPCRouter, protectedProcedure, publicProcedure } from "~/server/api/trpc";
import {
  ExchangeError,
  binancePriceFetcherFromTickers,
  computeBinanceCostBasis,
  fetchBinanceBalances,
  fetchBinancePrice,
  fetchCoinbaseBalances,
  fetchCoinbasePrice,
  fetchKrakenBalances,
  fetchKrakenPrice,
  validateBinanceDirectPayload,
  validateBinanceTradesPayload,
  valuate,
  type BinanceSpotTrade,
  type ExchangeName,
  type NativeBalance,
  type PriceFetcher,
  type Valuation,
} from "~/server/exchanges";
import { decryptCredentials, encryptCredentials } from "~/server/crypto";
import type { AppDb } from "~/server/db";

const exchangeEnum = z.enum(["coinbase", "binance", "kraken"]);

const SETUP_HINTS: Record<ExchangeName, string> = {
  coinbase:
    "Coinbase is not connected. On coinbase.com go to your profile → API (or Settings → API), create an API key with only portfolio/read permissions — never enable trading or transfers. Paste the API key + secret below.",
  binance:
    "Binance is not connected. On binance.com go to Profile → API Management, create an API key with ONLY 'Enable Reading' checked (leave trading and withdrawals OFF; an IP whitelist is recommended). Paste the API key + secret below.",
  kraken:
    "Kraken is not connected. On kraken.com go to Settings → API, create an API key with ONLY 'Query Funds' permission (leave all trading, deposit and withdrawal permissions OFF). Paste the API key + secret below.",
};

const keySchema = z.string().min(1).max(500);
const secretSchema = z.string().min(1).max(2000);

function priceFetcherFor(exchange: ExchangeName): PriceFetcher {
  if (exchange === "coinbase") return (asset) => fetchCoinbasePrice(asset);
  if (exchange === "kraken") return (asset) => fetchKrakenPrice(asset);
  return (asset) => fetchBinancePrice(asset);
}

async function fetchBalances(
  exchange: ExchangeName,
  apiKey: string,
  apiSecret: string,
): Promise<NativeBalance[]> {
  try {
    if (exchange === "coinbase") return await fetchCoinbaseBalances(apiKey, apiSecret);
    if (exchange === "kraken") return await fetchKrakenBalances(apiKey, apiSecret);
    return await fetchBinanceBalances(apiKey, apiSecret);
  } catch (e) {
    // ExchangeError messages never contain key material (only status codes
    // and the exchange's own error text).
    const message =
      e instanceof ExchangeError ? e.message : `${exchange} sync failed unexpectedly.`;
    throw new TRPCError({ code: "BAD_REQUEST", message });
  }
}

/** cents stored as text -> JSON-safe integer number. Exact while |v| < 2^53. */
function centsToNumber(centsText: string): number {
  return Number(BigInt(centsText));
}

interface ResolvedCreds {
  apiKey: string;
  apiSecret: string;
  /** True when the keys were pasted for this sync only (never persisted). */
  transient: boolean;
}

async function resolveCreds(
  ctx: { db: AppDb; session: { user?: { id: string } } | null },
  exchange: ExchangeName,
  input?: { apiKey?: string; apiSecret?: string },
): Promise<ResolvedCreds> {
  if (input?.apiKey && input?.apiSecret) {
    return { apiKey: input.apiKey, apiSecret: input.apiSecret, transient: true };
  }
  const userId = ctx.session?.user?.id;
  if (userId) {
    const row = await ctx.db.exchangeCredential.findFirst({
      where: { userId, exchange },
    });
    if (row) {
      try {
        // encryptCredentials stores (token=apiKey, queryId=apiSecret).
        const dec = await decryptCredentials(row.iv, row.encKey, row.encSecret);
        return { apiKey: dec.token, apiSecret: dec.queryId, transient: false };
      } catch {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Saved credentials could not be decrypted (the server key may have changed). Please save them again.",
        });
      }
    }
  }
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: SETUP_HINTS[exchange] });
}

function toValuationJson(v: Valuation, costByAsset?: Map<string, { avgCostUsd: string | null; tradeCount: number }>) {
  return {
    items: v.items.map((i) => ({
      asset: i.asset,
      quantity: i.quantity,
      priceUsd: i.priceUsd,
      priceSource: i.priceSource,
      priceAt: i.priceAt,
      valueCents: i.valueCents == null ? null : Number(i.valueCents),
      avgCostUsd: costByAsset?.get(i.asset)?.avgCostUsd ?? null,
      costTradeCount: costByAsset?.get(i.asset)?.tradeCount ?? null,
    })),
    totalCents: Number(v.totalCents),
    driftCents: Number(v.driftCents),
    reconciled: v.reconciled,
    pricedCount: v.pricedCount,
    unpriced: v.unpriced,
    costAssets: costByAsset ? [...costByAsset.values()].filter((c) => c.avgCostUsd != null).length : 0,
    costTrades: costByAsset ? [...costByAsset.values()].reduce((s, c) => s + c.tradeCount, 0) : 0,
  };
}

/**
 * Real cost basis per asset from browser-posted myTrades history.
 * Returns a map asset -> { avgCostUsd, tradeCount }. Empty map when no
 * trades were posted — every asset then honestly reports unknown cost.
 */
function binanceCostByAsset(tradesJson: unknown): Map<string, { avgCostUsd: string | null; tradeCount: number }> {
  const out = new Map<string, { avgCostUsd: string | null; tradeCount: number }>();
  let perPair: Array<{ symbol: string; trades: BinanceSpotTrade[] }>;
  try {
    perPair = validateBinanceTradesPayload(tradesJson);
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid Binance trades payload." });
  }
  for (const b of computeBinanceCostBasis(perPair)) {
    out.set(b.asset, { avgCostUsd: b.avgCostUsd, tradeCount: b.tradeCount });
  }
  return out;
}

export const exchangesRouter = createTRPCRouter({
  /**
   * Per-exchange connection + last-sync state for the caller.
   * Logged-out visitors get { configured: false } for both.
   */
  status: publicProcedure.query(async ({ ctx }) => {
    const userId = ctx.session?.user?.id;
    const out: Record<
      ExchangeName,
      {
        configured: boolean;
        keyLast4: string | null;
        assetCount: number;
        pricedCount: number;
        totalCents: number | null;
        driftCents: number | null;
        reconciled: boolean | null;
        lastSyncedAt: Date | null;
        unpriced: string[];
      }
    > = {
      coinbase: emptyStatus(),
      binance: emptyStatus(),
      kraken: emptyStatus(),
    };
    if (!userId) return { exchanges: out };

    const creds = await ctx.db.exchangeCredential.findMany({ where: { userId } });
    for (const exchange of ["coinbase", "binance", "kraken"] as const) {
      const cred = creds.find((c) => c.exchange === exchange);
      if (!cred) continue;
      let keyLast4: string | null = null;
      try {
        const dec = await decryptCredentials(cred.iv, cred.encKey, cred.encSecret);
        keyLast4 = dec.token.slice(-4);
      } catch {
        keyLast4 = null;
      }
      const [balances, sync] = await Promise.all([
        ctx.db.exchangeBalance.findMany({ where: { userId, exchange } }),
        ctx.db.exchangeSync.findFirst({
          where: { userId, exchange },
          orderBy: { syncedAt: "desc" },
        }),
      ]);
      const priced = balances.filter((b) => b.valueCents != null);
      out[exchange] = {
        configured: true,
        keyLast4,
        assetCount: balances.length,
        pricedCount: priced.length,
        totalCents: sync ? centsToNumber(sync.totalCents) : null,
        driftCents: sync ? centsToNumber(sync.driftCents) : null,
        reconciled: sync ? sync.ok : null,
        lastSyncedAt: sync ? sync.syncedAt : null,
        unpriced: balances.filter((b) => b.valueCents == null).map((b) => b.asset),
      };
    }
    return { exchanges: out };
  }),

  /** Stored balances for the caller's exchange (persisted syncs only). */
  balances: publicProcedure
    .input(z.object({ exchange: exchangeEnum }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.session?.user?.id;
      if (!userId) return { items: [] };
      const rows = await ctx.db.exchangeBalance.findMany({
        where: { userId, exchange: input.exchange },
      });
      return {
        items: rows.map((r) => ({
          asset: r.asset,
          quantity: r.quantity,
          priceUsd: r.priceUsd,
          priceSource: r.priceSource,
          priceAt: r.priceAt,
          valueCents: r.valueCents == null ? null : centsToNumber(r.valueCents),
          avgCostUsd: r.avgCostUsd,
          costTradeCount: r.costTradeCount,
          currency: r.currency,
          syncedAt: r.syncedAt,
        })),
      };
    }),

  /**
   * Pull balances + spot prices, reconcile totals, and (for saved-credential
   * syncs) persist. Transient syncs (keys pasted in the form) never touch
   * the database.
   */
  sync: publicProcedure
    .input(
      z.object({
        exchange: exchangeEnum,
        apiKey: keySchema.optional(),
        apiSecret: secretSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { apiKey, apiSecret, transient } = await resolveCreds(ctx, input.exchange, input);
      const balances = await fetchBalances(input.exchange, apiKey, apiSecret);
      const nowIso = new Date().toISOString();
      const v = await valuate(balances, priceFetcherFor(input.exchange), nowIso);

      if (!v.reconciled) {
        // Surface, don't hide: the per-row total and the once-rounded total
        // disagree beyond the theoretical rounding bound — a math bug.
        console.warn(
          `[exchanges] reconciliation failed for ${input.exchange}: ` +
            `drift=${v.driftCents}c over ${v.pricedCount} priced assets`,
        );
      }

      const userId = ctx.session?.user?.id;
      const persisted = !transient && userId != null;
      if (persisted && userId) {
        await ctx.db.exchangeBalance.deleteMany({
          where: { userId, exchange: input.exchange },
        });
        if (v.items.length > 0) {
          await ctx.db.exchangeBalance.createMany({
            data: v.items.map((i) => ({
              userId,
              exchange: input.exchange,
              asset: i.asset,
              quantity: i.quantity,
              priceUsd: i.priceUsd,
              priceSource: i.priceSource,
              priceAt: i.priceAt,
              valueCents: i.valueCents == null ? null : i.valueCents.toString(),
              currency: "USD",
            })),
          });
        }
        await ctx.db.exchangeSync.create({
          data: {
            userId,
            exchange: input.exchange,
            assetCount: v.items.length,
            pricedCount: v.pricedCount,
            totalCents: v.totalCents.toString(),
            driftCents: v.driftCents.toString(),
            ok: v.reconciled,
            note: v.reconciled
              ? null
              : `Rounding drift ${v.driftCents}c exceeded the ${v.pricedCount}-asset bound`,
          },
        });
      }

      return {
        exchange: input.exchange,
        persisted,
        syncedAt: new Date(),
        ...toValuationJson(v),
      };
    }),

  /**
   * Browser-side Binance sync.
   *
   * Binance's CDN geo-blocks / WAF-blocks api.binance.com from Cloudflare
   * Workers egress IPs (HTTP 403 before the API key is even checked), so the
   * signed account + ticker requests now run in the USER'S BROWSER and only
   * the RESULTS are posted here for valuation + storage. The API secret
   * never leaves the user's device — no credentials are involved in this
   * mutation at all.
   *
   * Client payloads are untrusted: shapes are validated defensively and
   * garbage is rejected with BAD_REQUEST. Number math reuses the exact
   * parseBinanceAccount + valuate pipeline (same as server-side sync), so
   * totals and reconciliation are identical.
   */
  binanceDirectSync: publicProcedure
    .input(
      z.object({
        accountJson: z.unknown(),
        tickersJson: z.unknown(),
        /**
         * Optional raw myTrades history per pair, posted by the browser
         * after the balance sync: [{ symbol: "BTCUSDT", trades: [...] }].
         * The server computes each asset's real average cost basis from
         * these fills (USDT-quoted only — never estimated).
         */
        tradesJson: z.unknown().optional(),
        label: z.string().max(80).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let payload: ReturnType<typeof validateBinanceDirectPayload>;
      try {
        payload = validateBinanceDirectPayload(input.accountJson, input.tickersJson);
      } catch {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid Binance response payload.",
        });
      }
      const nowIso = new Date().toISOString();
      const v = await valuate(
        payload.balances,
        binancePriceFetcherFromTickers(payload.tickers),
        nowIso,
      );
      // Real cost basis from the account's own fill history (best-effort:
      // absent when the browser skipped the trades fetch).
      const costByAsset = binanceCostByAsset(input.tradesJson);

      if (!v.reconciled) {
        console.warn(
          `[exchanges] reconciliation failed for binance (browser sync): ` +
            `drift=${v.driftCents}c over ${v.pricedCount} priced assets`,
        );
      }

      // Persist exactly like exchanges.sync does for binance: same tables,
      // same rows. No credentials exist in this flow, so persistence is
      // driven by login state alone.
      const userId = ctx.session?.user?.id;
      const persisted = userId != null;
      if (persisted && userId) {
        await ctx.db.exchangeBalance.deleteMany({
          where: { userId, exchange: "binance" },
        });
        if (v.items.length > 0) {
          await ctx.db.exchangeBalance.createMany({
            data: v.items.map((i) => ({
              userId,
              exchange: "binance",
              asset: i.asset,
              quantity: i.quantity,
              priceUsd: i.priceUsd,
              priceSource: i.priceSource,
              priceAt: i.priceAt,
              valueCents: i.valueCents == null ? null : i.valueCents.toString(),
              currency: "USD",
              avgCostUsd: costByAsset.get(i.asset)?.avgCostUsd ?? null,
              costTradeCount: costByAsset.get(i.asset)?.tradeCount ?? null,
            })),
          });
        }
        await ctx.db.exchangeSync.create({
          data: {
            userId,
            exchange: "binance",
            assetCount: v.items.length,
            pricedCount: v.pricedCount,
            totalCents: v.totalCents.toString(),
            driftCents: v.driftCents.toString(),
            ok: v.reconciled,
            note: v.reconciled
              ? null
              : `Rounding drift ${v.driftCents}c exceeded the ${v.pricedCount}-asset bound`,
          },
        });
      }

      return {
        exchange: "binance" as const,
        persisted,
        syncedAt: new Date(),
        ...toValuationJson(v, costByAsset),
      };
    }),

  /**
   * Save the caller's read-only API key + secret, AES-GCM encrypted.
   * The keys are verified with a live balances fetch BEFORE saving, so a
   * typo surfaces immediately instead of on the next sync — unless
   * skipVerify is set (Binance: the key was already proven working by a
   * browser-side WebSocket sync; our server IPs are blocked by Binance so
   * a server-side check would always fail).
   * Secrets are never returned by any endpoint except credentialSecret
   * below (only the key's last 4 characters elsewhere).
   */
  saveCredentials: protectedProcedure
    .input(
      z.object({
        exchange: exchangeEnum,
        apiKey: keySchema,
        apiSecret: secretSchema,
        label: z.string().max(100).optional(),
        skipVerify: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Verify the keys work before storing them (unless the caller already
      // proved them — Binance browser sync).
      if (!input.skipVerify) {
        await fetchBalances(input.exchange, input.apiKey, input.apiSecret);
      }
      // encryptCredentials(token, queryId) — we store (apiKey, apiSecret)
      // in those two slots; decryptCredentials maps them back.
      const enc = await encryptCredentials(input.apiKey, input.apiSecret);
      await ctx.db.exchangeCredential.upsert({
        where: { userId_exchange: { userId: ctx.session.user.id, exchange: input.exchange } },
        update: {
          encKey: enc.encToken,
          encSecret: enc.encQueryId,
          iv: enc.iv,
          label: input.label ?? null,
        },
        create: {
          userId: ctx.session.user.id,
          exchange: input.exchange,
          encKey: enc.encToken,
          encSecret: enc.encQueryId,
          iv: enc.iv,
          label: input.label ?? null,
        },
      });
      return { saved: true };
    }),

  /** Whether the caller has saved credentials (never returns them). */
  savedCredentials: protectedProcedure
    .input(z.object({ exchange: exchangeEnum }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.exchangeCredential.findFirst({
        where: { userId: ctx.session.user.id, exchange: input.exchange },
      });
      let keyLast4: string | null = null;
      if (row) {
        try {
          const dec = await decryptCredentials(row.iv, row.encKey, row.encSecret);
          keyLast4 = dec.token.slice(-4);
        } catch {
          keyLast4 = null;
        }
      }
      return { saved: row != null, keyLast4 };
    }),

  /**
   * Return the caller's decrypted API key + secret for an exchange.
   *
   * This deliberately relaxes the "secrets are never returned" rule:
   * Binance can only be synced from the user's own browser (Binance blocks
   * our server IPs), so a second logged-in device needs the secret to sync
   * locally. Only the authenticated owner can fetch their own secrets, and
   * the client only calls this when the user opted into storing online.
   */
  credentialSecret: protectedProcedure
    .input(z.object({ exchange: exchangeEnum }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.exchangeCredential.findFirst({
        where: { userId: ctx.session.user.id, exchange: input.exchange },
      });
      if (!row) return { found: false as const };
      const dec = await decryptCredentials(row.iv, row.encKey, row.encSecret);
      return { found: true as const, apiKey: dec.token, apiSecret: dec.queryId };
    }),

  /** Delete the caller's saved credentials AND their stored balances. */
  clearCredentials: protectedProcedure
    .input(z.object({ exchange: exchangeEnum }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const row = await ctx.db.exchangeCredential.findFirst({
        where: { userId, exchange: input.exchange },
      });
      if (row) {
        await ctx.db.exchangeCredential.delete({
          where: { userId_exchange: { userId, exchange: input.exchange } },
        });
      }
      await ctx.db.exchangeBalance.deleteMany({ where: { userId, exchange: input.exchange } });
      return { cleared: true };
    }),
});

function emptyStatus() {
  return {
    configured: false as const,
    keyLast4: null as string | null,
    assetCount: 0,
    pricedCount: 0,
    totalCents: null as number | null,
    driftCents: null as number | null,
    reconciled: null as boolean | null,
    lastSyncedAt: null as Date | null,
    unpriced: [] as string[],
  };
}
