/**
 * Futu (富途牛牛 / moomoo) integration — server side.
 *
 * Futu has no cloud REST API. The only official API is Futu OpenAPI, which
 * talks to a gateway daemon (OpenD) running on the USER'S OWN machine
 * (127.0.0.1:11111). Our Cloudflare Workers can never reach it, so syncs
 * must originate from the user's machine: the local agent in
 * tools/futu-sync/ pulls positions + history orders via OpenD and POSTs
 * them here as JSON.
 *
 * Security model:
 * - The agent authenticates with a per-user bearer token (SyncToken table).
 *   Only the SHA-256 hash is stored; the plaintext is shown once at
 *   creation and is revocable. Tokens are single-purpose ("futu:ingest").
 * - Futu credentials (account password / trade password) NEVER leave the
 *   user's machine — the agent only unlocks its local OpenD session.
 * - The agent is read-only by construction: it only calls query APIs
 *   (position_list_query, history_order_list_query). No order placement
 *   code exists anywhere in this integration.
 * - Client payloads are untrusted: the zod schema below rejects anything
 *   malformed, oversized, or non-finite before a single row is written.
 * - Rows are namespaced per user: accountId = "futu:<userId>:<accountId>",
 *   so one user's sync can never touch another user's rows.
 */

import { z } from "zod";

import type { AppDb } from "~/server/d1db";

/** Scope string stored on SyncToken rows for this integration. */
export const FUTU_INGEST_SCOPE = "futu:ingest";

/** Account key prefix — every Futu row lives under this namespace. */
export const FUTU_PREFIX = "futu:";

/** Payload schema version the agent must send. Bump when the shape changes. */
export const FUTU_INGEST_VERSION = 1;

/** Hard caps: a sync is one user's accounts, not a data dump. */
const MAX_ACCOUNTS = 10;
const MAX_POSITIONS_PER_ACCOUNT = 500;
const MAX_TRADES_PER_ACCOUNT = 5000;
const MAX_TOKENS_PER_USER = 10;

export { MAX_TOKENS_PER_USER };

const finiteNumber = z.number().finite();
const currencyCode = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/);
const symbolSchema = z
  .string()
  .min(1)
  .max(20)
  .transform((s) => s.trim().toUpperCase())
  .refine((s) => s.length > 0, { message: "symbol must not be blank" });

const futuPositionSchema = z.object({
  /** Normalized symbol, e.g. "00700" (HK) or "AAPL" (US). */
  symbol: symbolSchema,
  /** Display name from Futu (stock_name). */
  name: z.string().max(120).optional(),
  currency: currencyCode,
  quantity: finiteNumber,
  /** Average cost per share, if known. */
  avgCost: finiteNumber.positive().max(1e9).optional().nullable(),
  /** Latest market price per share, if known. */
  markPrice: finiteNumber.positive().max(1e9).optional().nullable(),
});

const futuTradeSchema = z.object({
  symbol: symbolSchema,
  side: z.enum(["BUY", "SELL"]),
  quantity: finiteNumber.positive().max(1e12),
  /** Average dealt price per share. */
  price: finiteNumber.positive().max(1e9),
  currency: currencyCode,
  /** Execution date as YYYYMMDD. */
  tradeDate: z.string().regex(/^\d{8}$/),
  /** Futu order id — informational only (syncs replace, never merge). */
  orderId: z.string().max(64).optional(),
  commission: finiteNumber.min(0).max(1e9).optional().nullable(),
});

const futuAccountSchema = z.object({
  /** Opaque Futu account identifier (never a password). */
  accountId: z.string().min(1).max(64),
  positions: z.array(futuPositionSchema).max(MAX_POSITIONS_PER_ACCOUNT),
  trades: z.array(futuTradeSchema).max(MAX_TRADES_PER_ACCOUNT),
});

export const futuIngestSchema = z.object({
  version: z.literal(FUTU_INGEST_VERSION),
  accounts: z.array(futuAccountSchema).min(1).max(MAX_ACCOUNTS),
});

export type FutuIngestPayload = z.infer<typeof futuIngestSchema>;

/* ---------------- token helpers (Web Crypto — works on Workers) ---------------- */

/** SHA-256 hex of a bearer token. Only the hash is ever stored. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 256-bit random bearer token, base64url-encoded (43 chars, no padding). */
export function generateSyncToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* ---------------- ingest ---------------- */

/**
 * Per-user account key. The raw accountId is user-supplied and opaque, so
 * colons are neutralized to keep the prefix structure unambiguous.
 */
export function futuAccountKey(userId: string, accountId: string): string {
  const safe = accountId.replace(/:/g, "_").slice(0, 64);
  return `${FUTU_PREFIX}${userId}:${safe}`;
}

export interface FutuIngestSummary {
  accounts: number;
  positions: number;
  trades: number;
  accountKeys: string[];
}

/**
 * Replace-all ingest for one user's Futu accounts (same semantics as the
 * Questrade sync): each account's existing rows are deleted, then the fresh
 * snapshot is inserted. Idempotent — re-running a sync changes nothing.
 *
 * Requires the D1 binding (deleteByAccountPrefix); throws a clear error
 * when the scoped delete is unavailable (e.g. local Prisma dev client).
 */
export async function ingestFutuPayload(
  db: AppDb,
  userId: string,
  payload: FutuIngestPayload,
): Promise<FutuIngestSummary> {
  const bp = db.brokerPosition;
  const bt = db.brokerTrade;
  if (
    typeof bp?.deleteByAccountPrefix !== "function" ||
    typeof bt?.deleteByAccountPrefix !== "function"
  ) {
    throw new Error(
      "Futu ingest requires the D1 binding (scoped delete unavailable).",
    );
  }

  const summary: FutuIngestSummary = {
    accounts: 0,
    positions: 0,
    trades: 0,
    accountKeys: [],
  };

  for (const acct of payload.accounts) {
    const key = futuAccountKey(userId, acct.accountId);
    await bp.deleteByAccountPrefix(key);
    await bt.deleteByAccountPrefix(key);

    if (acct.positions.length > 0) {
      await db.brokerPosition.createMany({
        data: acct.positions.map((p) => ({
          accountId: key,
          symbol: p.symbol,
          description: p.name ?? null,
          assetCategory: "STK",
          currency: p.currency,
          quantity: p.quantity,
          markPrice: p.markPrice ?? null,
        })),
      });
    }
    if (acct.trades.length > 0) {
      await db.brokerTrade.createMany({
        data: acct.trades.map((t) => ({
          accountId: key,
          symbol: t.symbol,
          description: t.orderId ? `Futu order ${t.orderId}` : null,
          assetCategory: "STK",
          currency: t.currency,
          tradeDate: t.tradeDate,
          // Signed quantity: buys add, sells remove (matches IBKR import).
          quantity: t.side === "BUY" ? t.quantity : -t.quantity,
          tradePrice: t.price,
          commission: t.commission ?? null,
        })),
      });
    }

    summary.accounts += 1;
    summary.positions += acct.positions.length;
    summary.trades += acct.trades.length;
    summary.accountKeys.push(key);
  }

  return summary;
}
