/**
 * Read-only clients for Coinbase (Advanced Trade), Binance (Spot) and Kraken.
 *
 * Runs on Cloudflare Workers and Node with zero dependencies (WebCrypto +
 * global fetch only). NEVER calls trading/order endpoints — balances, spot
 * trade history (read-only fills, for cost basis) and public prices only.
 *
 * Number discipline (Hector's requirement): exchange balance endpoints return
 * NATIVE asset quantities (e.g. "0.05" BTC), never fiat values. We keep the
 * native quantity as an exact decimal string end-to-end, fetch the exchange's
 * own spot price at sync time, and compute USD values with BigInt decimal
 * math (no float drift). Rounding happens once, to integer cents, half-up.
 * The account total is computed two ways and reconciled — any discrepancy is
 * surfaced, never hidden.
 */

import { z } from "zod";

const te = new TextEncoder();

/* ------------------------------------------------------------------ */
/* Exact decimal math (BigInt-based, no floats)                        */
/* ------------------------------------------------------------------ */

/** An exact decimal: value = int / 10^scale. */
export interface Decimal {
  int: bigint;
  scale: number;
}

const DECIMAL_RE = /^[+-]?(\d+)(\.(\d+))?$/;

/** Parse a decimal string exactly. Throws ExchangeError on garbage input. */
export function parseDecimal(s: string): Decimal {
  const t = s.trim();
  const m = DECIMAL_RE.exec(t);
  if (!m) throw new ExchangeError("coinbase", `Invalid decimal: ${JSON.stringify(t.slice(0, 32))}`);
  const neg = t.startsWith("-");
  const intPart = m[1] ?? "0";
  const fracPart = m[3] ?? "";
  // Strip leading zeros but keep at least one digit.
  const digits = (intPart + fracPart).replace(/^0+(?=\d)/, "");
  return { int: (neg ? -1n : 1n) * BigInt(digits === "" ? "0" : digits), scale: fracPart.length };
}

export function decimalToString(d: Decimal): string {
  const neg = d.int < 0n;
  const digits = (neg ? -d.int : d.int).toString().padStart(d.scale + 1, "0");
  if (d.scale === 0) return (neg ? "-" : "") + digits;
  const head = digits.slice(0, digits.length - d.scale);
  const tail = digits.slice(digits.length - d.scale);
  return (neg ? "-" : "") + head + "." + tail;
}

/** a + b, exact. */
export function addDecimal(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  const ai = a.int * 10n ** BigInt(scale - a.scale);
  const bi = b.int * 10n ** BigInt(scale - b.scale);
  return { int: ai + bi, scale };
}

/** a * b, exact. */
export function mulDecimal(a: Decimal, b: Decimal): Decimal {
  return { int: a.int * b.int, scale: a.scale + b.scale };
}

/**
 * a / b, rounded half-up to `scale` decimal places. Exact BigInt math —
 * no floats. Throws ExchangeError on division by zero.
 */
export function divDecimal(a: Decimal, b: Decimal, scale: number): Decimal {
  if (b.int === 0n) throw new ExchangeError("binance", "Division by zero.");
  const neg = (a.int < 0n) !== (b.int < 0n);
  const ai = a.int < 0n ? -a.int : a.int;
  const bi = b.int < 0n ? -b.int : b.int;
  // a/b = (ai * 10^b.scale) / (bi * 10^a.scale); scale up for `scale` decimals.
  const num = ai * 10n ** BigInt(b.scale + scale);
  const den = bi * 10n ** BigInt(a.scale);
  let q = num / den;
  if ((num % den) * 2n >= den) q += 1n; // half-up
  return { int: neg ? -q : q, scale };
}

/** a - b, exact. */
export function subDecimal(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  const ai = a.int * 10n ** BigInt(scale - a.scale);
  const bi = b.int * 10n ** BigInt(scale - b.scale);
  return { int: ai - bi, scale };
}

/** Compare two decimals: -1 | 0 | 1. */
export function cmpDecimal(a: Decimal, b: Decimal): number {
  const scale = Math.max(a.scale, b.scale);
  const ai = a.int * 10n ** BigInt(scale - a.scale);
  const bi = b.int * 10n ** BigInt(scale - b.scale);
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

export function isZeroDecimal(d: Decimal): boolean {
  return d.int === 0n;
}

export function isNegativeDecimal(d: Decimal): boolean {
  return d.int < 0n;
}

/**
 * Round to integer USD cents, half away from zero.
 * e.g. 1.005 -> 101n, -1.005 -> -101n.
 */
export function roundToCents(d: Decimal): bigint {
  const target = 2;
  if (d.scale <= target) {
    return d.int * 10n ** BigInt(target - d.scale);
  }
  const shift = BigInt(d.scale - target);
  const divisor = 10n ** shift;
  const q = d.int / divisor; // truncates toward zero
  const r = d.int % divisor;
  const absR = r < 0n ? -r : r;
  // Half-up: |remainder| >= half the divisor rounds away from zero.
  if (absR * 2n >= divisor) {
    return q + (d.int < 0n ? -1n : 1n);
  }
  return q;
}

/** Format integer cents as "1,234.56" (sign-aware). Display-only. */
export function formatCents(cents: bigint): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const dollars = abs / 100n;
  const rem = (abs % 100n).toString().padStart(2, "0");
  const grouped = dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + grouped + "." + rem;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export type ExchangeName = "coinbase" | "binance" | "kraken";

export class ExchangeError extends Error {
  exchange: ExchangeName;
  status?: number;
  constructor(exchange: ExchangeName, message: string, status?: number) {
    super(message);
    this.name = "ExchangeError";
    this.exchange = exchange;
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* HMAC helpers (WebCrypto — works on Workers and Node 18+)            */
/* ------------------------------------------------------------------ */

function b64ToBytes(b64: string, exchange: ExchangeName = "coinbase"): Uint8Array {
  const clean = b64.trim();
  let bin: string;
  try {
    bin = atob(clean);
  } catch {
    throw new ExchangeError(exchange, "API secret is not valid base64.");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSha256(keyBytes: Uint8Array, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, te.encode(message));
  return new Uint8Array(sig);
}

async function hmacSha512(keyBytes: Uint8Array, messageBytes: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, messageBytes.buffer as ArrayBuffer);
  return new Uint8Array(sig);
}

async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", data.buffer as ArrayBuffer);
  return new Uint8Array(digest);
}

/* ------------------------------------------------------------------ */
/* Shared fetch plumbing                                               */
/* ------------------------------------------------------------------ */

type FetchFn = typeof fetch;

async function readJson(res: Response, exchange: ExchangeName, what: string): Promise<unknown> {
  if (!res.ok) {
    let detail = "";
    let text = "";
    try {
      text = await res.text();
    } catch {
      /* unreadable body */
    }
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      // Binance: { code, msg }. Coinbase: { message } / { error }.
      const msg =
        (body.msg as string | undefined) ??
        (body.message as string | undefined) ??
        (body.error as string | undefined);
      if (msg) detail = `: ${String(msg).slice(0, 200)}`;
      if (typeof body.code !== "undefined") detail = ` (code ${String(body.code)})${detail}`;
    } catch {
      // Non-JSON body (e.g. WAF / geo-block HTML page) — include a plain-text snippet.
      const snippet = text
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
      if (snippet) detail = `: ${snippet}`;
    }
    throw new ExchangeError(exchange, `${what} failed (HTTP ${res.status})${detail}`, res.status);
  }
  return res.json() as Promise<unknown>;
}

function hintForStatus(exchange: ExchangeName, status: number): string {
  if (status === 401 || status === 403) {
    if (exchange === "coinbase")
      return " Check that the API key is correct and has not been deleted.";
    if (exchange === "binance")
      return " Check the API key/secret and that the key has 'Enable Reading' permission (no trading permission needed). If the error mentions a restricted location, Binance is geo-blocking this server's region.";
    return " Check the API key/secret and that the key has query-funds permission (no trading permission needed).";
  }
  if (status === 429) return " Rate limited — wait a minute and sync again.";
  if (status === 451)
    return " Request blocked by region (Binance.com restricts some locations; US users need Binance.US).";
  return "";
}

/* ------------------------------------------------------------------ */
/* Coinbase Advanced Trade                                             */
/*                                                                     */
/* Auth: CB-ACCESS-KEY / CB-ACCESS-SIGN / CB-ACCESS-TIMESTAMP.          */
/* Sign = base64(HMAC-SHA256(base64decode(secret),                    */
/*        timestamp + METHOD + requestPath + body)).                   */
/* ------------------------------------------------------------------ */

const COINBASE_API = "https://api.coinbase.com";

/** Native balances: [{ asset: "BTC", quantity: "0.05" }]. Zero balances excluded. */
export interface NativeBalance {
  asset: string;
  quantity: string; // exact native decimal string
}

interface CoinbaseAccount {
  uuid?: string;
  currency?: string;
  available_balance?: { value?: string; currency?: string };
  active?: boolean;
}

export async function coinbaseSignature(
  apiSecretB64: string,
  timestamp: string,
  method: string,
  requestPath: string,
  body = "",
): Promise<string> {
  const keyBytes = b64ToBytes(apiSecretB64);
  const sig = await hmacSha256(keyBytes, timestamp + method + requestPath + body);
  return bytesToB64(sig);
}

/** Parse a List Accounts response body into native balances (pure, testable). */
export function parseCoinbaseAccounts(body: unknown): {
  balances: NativeBalance[];
  cursor: string | null;
} {
  const root = body as { accounts?: CoinbaseAccount[]; cursor?: string } | null;
  const accounts = root?.accounts ?? [];
  const balances: NativeBalance[] = [];
  for (const a of accounts) {
    const asset = (a.currency ?? "").toUpperCase();
    const value = a.available_balance?.value ?? "0";
    if (!asset) continue;
    let qty: Decimal;
    try {
      qty = parseDecimal(value);
    } catch {
      continue; // skip malformed rows rather than failing the whole sync
    }
    if (isZeroDecimal(qty)) continue;
    balances.push({ asset, quantity: decimalToString(qty) });  }
  const cursor = typeof root?.cursor === "string" && root.cursor ? root.cursor : null;
  return { balances, cursor };
}

export async function fetchCoinbaseBalances(
  apiKey: string,
  apiSecret: string,
  fetcher: FetchFn = fetch,
): Promise<NativeBalance[]> {
  const out: NativeBalance[] = [];
  let cursor: string | null = null;
  // Paginate (cursor), with a sane cap.
  for (let page = 0; page < 5; page++) {
    const path =
      "/api/v3/brokerage/accounts?limit=250" + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const timestamp = Math.floor(Date.now() / 1000).toString();
    let signature: string;
    try {
      signature = await coinbaseSignature(apiSecret, timestamp, "GET", path);
    } catch (e) {
      throw e instanceof ExchangeError ? e : new ExchangeError("coinbase", "Failed to sign request.");
    }
    let res: Response;
    try {
      res = await fetcher(COINBASE_API + path, {
        headers: {
          "CB-ACCESS-KEY": apiKey,
          "CB-ACCESS-SIGN": signature,
          "CB-ACCESS-TIMESTAMP": timestamp,
        },
      });
    } catch {
      throw new ExchangeError("coinbase", "Could not reach Coinbase. Check your connection.");
    }
    let body: unknown;
    try {
      body = await readJson(res, "coinbase", "Coinbase accounts request");
    } catch (e) {
      if (e instanceof ExchangeError && e.status != null) {
        throw new ExchangeError("coinbase", e.message + hintForStatus("coinbase", e.status), e.status);
      }
      throw e;
    }
    const parsed = parseCoinbaseAccounts(body);
    out.push(...parsed.balances);
    cursor = (body as { has_next?: boolean })?.has_next ? parsed.cursor : null;
    if (!cursor) break;
  }
  return out;
}

/** Coinbase's own spot price for ASSET-USD (public, no auth). Returns exact decimal string. */
export async function fetchCoinbasePrice(
  asset: string,
  fetcher: FetchFn = fetch,
): Promise<{ price: string; source: string } | null> {
  const upper = asset.toUpperCase();
  // USD-pegged assets and USD itself: no price lookup needed.
  if (upper === "USD" || STABLECOINS.has(upper)) {
    return { price: "1", source: "peg:1" };
  }
  let res: Response;
  try {
    res = await fetcher(`${COINBASE_API}/v2/prices/${encodeURIComponent(upper)}-USD/spot`);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const body = (await res.json()) as { data?: { amount?: string; currency?: string } };
    const amount = body?.data?.amount;
    if (!amount || body?.data?.currency !== "USD") return null;
    const price = parseDecimal(amount); // validates
    if (isZeroDecimal(price) || isNegativeDecimal(price)) return null;
    return { price: decimalToString(price), source: `coinbase:v2/prices/${upper}-USD/spot` };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Binance Spot                                                        */
/*                                                                     */
/* Auth: X-MBX-APIKEY header; signature = hex(HMAC-SHA256(secret,      */
/* queryString)) appended as &signature=. Balances only — no order      */
/* endpoints are ever called.                                          */
/* ------------------------------------------------------------------ */

const BINANCE_API = "https://api.binance.com";

interface BinanceBalanceRow {
  asset?: string;
  free?: string;
  locked?: string;
}

/** Parse a GET /api/v3/account body into native balances (pure, testable). */
export function parseBinanceAccount(body: unknown): NativeBalance[] {
  const root = body as { balances?: BinanceBalanceRow[] } | null;
  const rows = root?.balances ?? [];
  const out: NativeBalance[] = [];
  for (const r of rows) {
    const asset = (r.asset ?? "").toUpperCase();
    if (!asset) continue;
    let qty: Decimal;
    try {
      qty = addDecimal(parseDecimal(r.free ?? "0"), parseDecimal(r.locked ?? "0"));
    } catch {
      continue;
    }
    if (isZeroDecimal(qty)) continue;
    out.push({ asset, quantity: decimalToString(qty) });
  }
  return out;
}

export async function binanceSignature(apiSecret: string, queryString: string): Promise<string> {
  const sig = await hmacSha256(te.encode(apiSecret), queryString);
  return bytesToHex(sig);
}

export async function fetchBinanceBalances(
  apiKey: string,
  apiSecret: string,
  fetcher: FetchFn = fetch,
): Promise<NativeBalance[]> {
  const timestamp = Date.now().toString();
  const queryString = `timestamp=${timestamp}&recvWindow=5000`;
  const signature = await binanceSignature(apiSecret, queryString);
  const url = `${BINANCE_API}/api/v3/account?${queryString}&signature=${signature}`;
  let res: Response;
  try {
    res = await fetcher(url, { headers: { "X-MBX-APIKEY": apiKey } });
  } catch {
    throw new ExchangeError("binance", "Could not reach Binance. Check your connection.");
  }
  let body: unknown;
  try {
    body = await readJson(res, "binance", "Binance account request");
  } catch (e) {
    if (e instanceof ExchangeError && e.status != null) {
      throw new ExchangeError("binance", e.message + hintForStatus("binance", e.status), e.status);
    }
    throw e;
  }
  return parseBinanceAccount(body);
}

/** Binance's own USDT price for ASSET (public, no auth). Returns exact decimal string. */
export async function fetchBinancePrice(
  asset: string,
  fetcher: FetchFn = fetch,
): Promise<{ price: string; source: string } | null> {
  const upper = asset.toUpperCase();
  if (upper === "USDT" || upper === "USD" || STABLECOINS.has(upper)) {
    return { price: "1", source: "peg:1" };
  }
  let res: Response;
  try {
    res = await fetcher(
      `${BINANCE_API}/api/v3/ticker/price?symbol=${encodeURIComponent(upper)}USDT`,
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const body = (await res.json()) as { price?: string; symbol?: string };
    const priceStr = body?.price;
    if (!priceStr) return null;
    const price = parseDecimal(priceStr);
    if (isZeroDecimal(price) || isNegativeDecimal(price)) return null;
    return { price: decimalToString(price), source: `binance:ticker/price:${upper}USDT` };
  } catch {
    return null;
  }
}

/**
 * Build a PriceFetcher from a batch of ticker rows, e.g. the response of
 * GET /api/v3/ticker/price (every symbol's price in one call). Used by the
 * browser-side Binance sync: the browser fetches the public tickers itself
 * and hands them to the server for valuation, so no server-side price fetch
 * is needed.
 *
 * Stablecoins peg at exactly 1 USD; other assets look up ${asset}USDT.
 * Missing or malformed prices return null (asset stays unpriced, never
 * zeroed). Price strings are validated with parseDecimal — no floats.
 */
export function binancePriceFetcherFromTickers(
  tickers: Array<{ symbol: string; price: string }>,
): PriceFetcher {
  const bySymbol = new Map<string, string>();
  for (const t of tickers) {
    const symbol = (t.symbol ?? "").toUpperCase();
    const price = (t.price ?? "").trim();
    if (!symbol || !price) continue;
    try {
      parseDecimal(price); // validates the string; throws on garbage
      if (!bySymbol.has(symbol)) bySymbol.set(symbol, price);
    } catch {
      /* skip malformed price strings */
    }
  }
  return async (asset: string) => {
    const upper = asset.toUpperCase();
    if (isUsdPegged(upper)) return { price: "1", source: "peg:1" };
    const hit = bySymbol.get(`${upper}USDT`);
    if (hit == null) return null;
    return { price: hit, source: `binance:ticker/price:${upper}USDT` };
  };
}

/**
 * Validate the untrusted payloads the browser posts for a Binance direct
 * sync (the raw GET /api/v3/account + GET /api/v3/ticker/price responses).
 * Throws a plain Error on garbage — the router converts it to a BAD_REQUEST
 * TRPCError. Balance parsing still goes through parseBinanceAccount, so the
 * exact-decimal number discipline is preserved.
 */
export function validateBinanceDirectPayload(
  accountJson: unknown,
  tickersJson: unknown,
): { balances: NativeBalance[]; tickers: Array<{ symbol: string; price: string }> } {
  const accountParsed = z
    .object({
      balances: z.array(
        z
          .object({
            asset: z.string(),
            free: z.string().optional(),
            locked: z.string().optional(),
          })
          .passthrough(),
      ),
    })
    .passthrough()
    .safeParse(accountJson);
  const tickersParsed = z
    .array(z.object({ symbol: z.string(), price: z.string() }).passthrough())
    .safeParse(tickersJson);
  if (!accountParsed.success || !tickersParsed.success) {
    throw new Error("Invalid Binance response payload.");
  }
  return {
    balances: parseBinanceAccount(accountParsed.data),
    tickers: tickersParsed.data.map((t) => ({ symbol: t.symbol, price: t.price })),
  };
}

/* ------------------------------------------------------------------ */
/* Binance spot trade history → real cost basis                        */
/*                                                                     */
/* GET /api/v3/myTrades (or the WS API `myTrades` method — same shape) */
/* returns every fill the account ever made on one pair. From those     */
/* REAL trades we compute each asset's average cost in USDT, which the  */
/* app treats as USD 1:1 (the same peg:1 convention the valuation side  */
/* already uses for USDT balances).                                    */
/*                                                                     */
/* HONESTY RULES — Hector: "make sure all numbers are real".           */
/* - Only trades quoted in a USD-pegged stablecoin feed the cost basis. */
/*   A trade quoted in BTC/ETH/BNB has a real price, but expressing it  */
/*   in USDT would need that quote asset's historical price — which we  */
/*   don't have. We skip those trades instead of inventing a rate.      */
/* - Commissions fold into cost ONLY when denominated in the base or    */
/*   quote asset (exact, no FX needed). Anything else is ignored.       */
/* - A sell can never reduce the tracked quantity below zero (deposits  */
/*   have no trade history): the sell is clamped to the held quantity.  */
/* Every number out of here is derived from actual exchange fills.      */
/* ------------------------------------------------------------------ */

/**
 * Quote assets we split trading pairs on, longest first so "BTCUSDT"
 * splits as BTC/USDT and not B/T... — suffix match against this list.
 */
const QUOTE_ASSETS = [
  "USDT", "USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP",
  "BTC", "ETH", "BNB", "EUR", "GBP",
];

/** Split "BTCUSDT" into { base: "BTC", quote: "USDT" }; null when unknown. */
export function splitSymbolPair(pair: string): { base: string; quote: string } | null {
  const upper = pair.toUpperCase().trim();
  for (const q of QUOTE_ASSETS) {
    if (upper.length > q.length && upper.endsWith(q)) {
      return { base: upper.slice(0, upper.length - q.length), quote: q };
    }
  }
  return null;
}

/** One validated Binance spot fill. Prices/qtys are exact decimal strings. */
export interface BinanceSpotTrade {
  /** Trading pair, e.g. "BTCUSDT". */
  pair: string;
  baseAsset: string;
  quoteAsset: string;
  tradeId: number;
  /** Fill price in the quote asset. */
  price: string;
  /** Base-asset quantity filled. */
  qty: string;
  /** Quote-asset total (price × qty), as reported by the exchange. */
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  /** true = the account bought the base asset. */
  isBuyer: boolean;
}

const myTradeRow = z
  .object({
    price: z.string(),
    qty: z.string(),
    quoteQty: z.string(),
    commission: z.string().optional(),
    commissionAsset: z.string().optional(),
    time: z.number().optional(),
    id: z.number().optional(),
    isBuyer: z.boolean(),
  })
  .passthrough();

/**
 * Parse one pair's myTrades response into validated fills. Malformed rows
 * are skipped (never fail the whole sync); zero-quantity or non-positive
 * price rows are dropped — they carry no cost information.
 */
export function parseBinanceMyTrades(pair: string, body: unknown): BinanceSpotTrade[] {
  const split = splitSymbolPair(pair);
  if (!split) return [];
  const rows = Array.isArray(body) ? body : [];
  const out: BinanceSpotTrade[] = [];
  for (const raw of rows) {
    const parsed = myTradeRow.safeParse(raw);
    if (!parsed.success) continue;
    const r = parsed.data;
    let price: Decimal, qty: Decimal, quoteQty: Decimal, commission: Decimal;
    try {
      price = parseDecimal(r.price);
      qty = parseDecimal(r.qty);
      quoteQty = parseDecimal(r.quoteQty);
      commission = parseDecimal(r.commission ?? "0");
    } catch {
      continue;
    }
    if (isZeroDecimal(qty) || isNegativeDecimal(qty)) continue;
    if (isZeroDecimal(price) || isNegativeDecimal(price)) continue;
    if (isZeroDecimal(quoteQty) || isNegativeDecimal(quoteQty)) continue;
    if (isNegativeDecimal(commission)) continue;
    out.push({
      pair: pair.toUpperCase(),
      baseAsset: split.base,
      quoteAsset: split.quote,
      tradeId: typeof r.id === "number" && Number.isFinite(r.id) ? r.id : -1,
      price: decimalToString(price),
      qty: decimalToString(qty),
      quoteQty: decimalToString(quoteQty),
      commission: decimalToString(commission),
      commissionAsset: (r.commissionAsset ?? "").toUpperCase(),
      time: typeof r.time === "number" && Number.isFinite(r.time) ? r.time : 0,
      isBuyer: r.isBuyer,
    });
  }
  // Oldest first, so the average-cost walk is chronological.
  out.sort((a, b) => a.time - b.time || a.tradeId - b.tradeId);
  return out;
}

/**
 * Validate the browser-posted myTrades payload: an array of
 * { symbol: "<PAIR>", trades: <raw myTrades array> }. Untrusted input —
 * shapes are checked, garbage pairs are dropped, garbage rows are skipped
 * by parseBinanceMyTrades. Throws a plain Error on a non-array payload.
 */
export function validateBinanceTradesPayload(
  payload: unknown,
): Array<{ symbol: string; trades: BinanceSpotTrade[] }> {
  if (payload == null) return [];
  const parsed = z
    .array(z.object({ symbol: z.string(), trades: z.array(z.unknown()) }).passthrough())
    .safeParse(payload);
  if (!parsed.success) throw new Error("Invalid Binance trades payload.");
  const out: Array<{ symbol: string; trades: BinanceSpotTrade[] }> = [];
  for (const entry of parsed.data) {
    const symbol = entry.symbol.toUpperCase().trim();
    if (!symbol) continue;
    const trades = parseBinanceMyTrades(symbol, entry.trades);
    if (trades.length > 0) out.push({ symbol, trades });
  }
  return out;
}

export interface AssetCostBasis {
  asset: string;
  /** Average cost in USDT (== USD by the app's peg:1 convention), exact decimal string; null when unknowable. */
  avgCostUsd: string | null;
  /** Number of REAL trades this basis was computed from. */
  tradeCount: number;
}

/**
 * Average cost per asset from real Binance spot fills.
 *
 * - USD-pegged assets cost exactly $1 (peg:1, same as valuation).
 * - Other assets: only fills quoted in a USD-pegged stablecoin count.
 *   Non-pegged-quote fills (e.g. ETHBTC) are skipped — see HONESTY RULES.
 * - Average-cost method: buys add quoteQty to the cost pool; sells remove
 *   cost proportionally and never drive the tracked quantity negative.
 * - Commission folds in exactly when it's in the base asset (reduces the
 *   received quantity) or the quote asset (adds to cost). Otherwise ignored.
 */
export function computeBinanceCostBasis(
  perPair: Array<{ symbol: string; trades: BinanceSpotTrade[] }>,
): AssetCostBasis[] {
  const byAsset = new Map<string, BinanceSpotTrade[]>();
  for (const { trades } of perPair) {
    for (const t of trades) {
      const arr = byAsset.get(t.baseAsset);
      if (arr) arr.push(t);
      else byAsset.set(t.baseAsset, [t]);
    }
  }
  const out: AssetCostBasis[] = [];
  for (const [asset, trades] of byAsset) {
    if (isUsdPegged(asset)) {
      out.push({ asset, avgCostUsd: "1", tradeCount: 0 });
      continue;
    }
    const usable = trades.filter((t) => isUsdPegged(t.quoteAsset));
    let qty = { int: 0n, scale: 0 } as Decimal;
    let cost = { int: 0n, scale: 0 } as Decimal;
    let used = 0;
    for (const t of usable) {
      const q = parseDecimal(t.qty);
      const qq = parseDecimal(t.quoteQty);
      const comm = parseDecimal(t.commission);
      const commAsset = t.commissionAsset;
      if (t.isBuyer) {
        let addQty = q;
        let addCost = qq;
        if (!isZeroDecimal(comm)) {
          if (commAsset === t.baseAsset) addQty = subDecimal(addQty, comm);
          else if (commAsset === t.quoteAsset) addCost = addDecimal(addCost, comm);
          // else: can't convert without historical FX — ignored (honest).
        }
        if (isNegativeDecimal(addQty) || isZeroDecimal(addQty)) continue;
        qty = addDecimal(qty, addQty);
        cost = addDecimal(cost, addCost);
        used++;
      } else {
        if (isZeroDecimal(qty)) continue; // nothing tracked — deposit sale; skip
        // Clamp the sell to the tracked quantity (deposits have no cost basis).
        const sellQty = cmpDecimal(q, qty) > 0 ? qty : q;
        const ratio = divDecimal(sellQty, qty, 12);
        cost = subDecimal(cost, mulDecimal(cost, ratio));
        qty = subDecimal(qty, sellQty);
        if (isNegativeDecimal(cost)) cost = { int: 0n, scale: 0 };
        if (isNegativeDecimal(qty)) qty = { int: 0n, scale: 0 };
        used++;
      }
    }
    out.push({
      asset,
      avgCostUsd: isZeroDecimal(qty) ? null : decimalToString(divDecimal(cost, qty, 8)),
      tradeCount: used,
    });
  }
  return out.sort((a, b) => a.asset.localeCompare(b.asset));
}

/* ------------------------------------------------------------------ */
/* Kraken                                                              */
/*                                                                     */
/* Auth: API-Key header + API-Sign = base64(HMAC-SHA512(               */
/*       urlPath + SHA256(nonce + postData), base64decode(secret))).    */
/* Balances + public ticker only — no order endpoints are ever called. */
/* ------------------------------------------------------------------ */

const KRAKEN_API = "https://api.kraken.com";
const KRAKEN_BALANCE_PATH = "/0/private/Balance";

/**
 * Sign a Kraken private request. `postData` is the urlencoded body
 * (e.g. "nonce=1234567890000"), `urlPath` the request path.
 */
export async function krakenSignature(
  apiSecretB64: string,
  urlPath: string,
  nonce: string,
  postData: string,
): Promise<string> {
  const keyBytes = b64ToBytes(apiSecretB64, "kraken");
  const sha = await sha256Bytes(te.encode(nonce + postData));
  const pathBytes = te.encode(urlPath);
  const message = new Uint8Array(pathBytes.length + sha.length);
  message.set(pathBytes, 0);
  message.set(sha, pathBytes.length);
  const sig = await hmacSha512(keyBytes, message);
  return bytesToB64(sig);
}

/**
 * Map a Kraken asset code to our canonical symbol.
 * Kraken prefixes classic assets: X for crypto (XXBT, XETH), Z for fiat
 * (ZUSD, ZEUR). Newer assets have no prefix (SOL, DOT). Staked balances
 * carry a ".S" suffix (XTZ.S). XBT is Bitcoin — we canonicalize to BTC.
 */
export function mapKrakenAsset(code: string): string {
  let c = code.toUpperCase().trim();
  // Staked / margin-suffixed balances collapse onto the base asset.
  c = c.replace(/\.(S|M)$/, "");
  if (c.length > 3 && (c.startsWith("X") || c.startsWith("Z"))) {
    c = c.slice(1);
  }
  if (c === "XBT") return "BTC";
  return c;
}

/** Kraken alt-name for the public ticker (BTC trades as XBT on Kraken). */
function krakenTickerAlt(asset: string): string {
  const u = asset.toUpperCase();
  if (u === "BTC") return "XBT";
  return u;
}

interface KrakenBalanceResponse {
  error?: string[];
  result?: Record<string, string>;
}

/** Parse a POST /0/private/Balance body into native balances (pure, testable). */
export function parseKrakenBalance(body: unknown): NativeBalance[] {
  const root = body as KrakenBalanceResponse | null;
  if (root?.error && root.error.length > 0) {
    throw new ExchangeError("kraken", `Kraken error: ${root.error.join("; ").slice(0, 200)}`);
  }
  const result = root?.result ?? {};
  const out: NativeBalance[] = [];
  for (const [code, value] of Object.entries(result)) {
    const asset = mapKrakenAsset(code);
    if (!asset) continue;
    let qty: Decimal;
    try {
      qty = parseDecimal(value ?? "0");
    } catch {
      continue;
    }
    if (isZeroDecimal(qty)) continue;
    out.push({ asset, quantity: decimalToString(qty) });
  }
  return out;
}

export async function fetchKrakenBalances(
  apiKey: string,
  apiSecret: string,
  fetcher: FetchFn = fetch,
): Promise<NativeBalance[]> {
  const nonce = Date.now().toString();
  const postData = `nonce=${encodeURIComponent(nonce)}`;
  let signature: string;
  try {
    signature = await krakenSignature(apiSecret, KRAKEN_BALANCE_PATH, nonce, postData);
  } catch (e) {
    if (e instanceof ExchangeError) throw e;
    throw new ExchangeError("kraken", "Failed to sign request.");
  }
  let res: Response;
  try {
    res = await fetcher(KRAKEN_API + KRAKEN_BALANCE_PATH, {
      method: "POST",
      headers: {
        "API-Key": apiKey,
        "API-Sign": signature,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: postData,
    });
  } catch {
    throw new ExchangeError("kraken", "Could not reach Kraken. Check your connection.");
  }
  let body: unknown;
  try {
    body = await readJson(res, "kraken", "Kraken balance request");
  } catch (e) {
    if (e instanceof ExchangeError && e.status != null) {
      throw new ExchangeError("kraken", e.message + hintForStatus("kraken", e.status), e.status);
    }
    throw e;
  }
  return parseKrakenBalance(body);
}

/** Kraken's own spot price for ASSET (public, no auth). Returns exact decimal string. */
export async function fetchKrakenPrice(
  asset: string,
  fetcher: FetchFn = fetch,
): Promise<{ price: string; source: string } | null> {
  const upper = asset.toUpperCase();
  if (isUsdPegged(upper)) {
    return { price: "1", source: "peg:1" };
  }
  const alt = krakenTickerAlt(upper);
  // Try USD pair first, then USDT (Kraken lists most assets against both).
  for (const quote of ["USD", "USDT"]) {
    const pair = `${alt}${quote}`;
    let res: Response;
    try {
      res = await fetcher(
        `${KRAKEN_API}/0/public/Ticker?pair=${encodeURIComponent(pair)}`,
      );
    } catch {
      return null;
    }
    if (!res.ok) continue;
    try {
      const body = (await res.json()) as {
        error?: string[];
        result?: Record<string, { c?: [string, string] }>;
      };
      if (body?.error && body.error.length > 0) continue;
      const keys = Object.keys(body?.result ?? {});
      if (keys.length === 0) continue;
      const last = body.result![keys[0]!]!.c?.[0];
      if (!last) continue;
      const price = parseDecimal(last);
      if (isZeroDecimal(price) || isNegativeDecimal(price)) continue;
      return { price: decimalToString(price), source: `kraken:ticker:${pair}` };
    } catch {
      continue;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Valuation                                                           */
/*                                                                     */
/* DECISION (documented): we fetch the exchange's own spot price at     */
/* sync time and compute USD values — because a balances table with no  */
/* values is useless for a portfolio dashboard. The native quantity is  */
/* ALWAYS kept alongside (exact string), the price source + timestamp  */
/* are recorded per asset, and assets with no price are listed as      */
/* unpriced rather than silently dropped or zeroed.                    */
/*                                                                     */
/* Totals reconciliation: totalCents = Σ round(qty×price) [what we     */
/* display per row]; altCents = round(Σ qty×price) [rounded once].      */
/* |drift| ≤ n/2 cents is the theoretical rounding bound; anything     */
/* beyond that is a bug and is flagged + logged.                       */
/*                                                                     */
/* Note: neither exchange's balances endpoint reports an independent   */
/* fiat account total, so reconciliation is internal-consistency       */
/* (two-way rounding) rather than against an exchange-provided total.  */
/* ------------------------------------------------------------------ */

const STABLECOINS = new Set(["USDT", "USDC", "FDUSD", "DAI", "TUSD", "BUSD", "USDP", "AEUR", "EURI"]);

export interface ValuedBalance {
  asset: string;
  /** Native quantity, exact decimal string — never a float, never a dollar value. */
  quantity: string;
  /** Spot price in USD, exact decimal string; null when unavailable. */
  priceUsd: string | null;
  /** Where the price came from, e.g. "binance:ticker/price:BTCUSDT". */
  priceSource: string | null;
  /** ISO timestamp of the price fetch. */
  priceAt: string | null;
  /** round(quantity × price) in integer USD cents; null when unpriced. */
  valueCents: bigint | null;
}

export interface Valuation {
  items: ValuedBalance[];
  /** Σ per-row rounded cents — the displayed total. */
  totalCents: bigint;
  /** round(Σ unrounded values) — the reconciliation counterpart. */
  altCents: bigint;
  /** totalCents − altCents. */
  driftCents: bigint;
  /** True when |drift| is within the theoretical rounding bound (n/2 cents). */
  reconciled: boolean;
  pricedCount: number;
  unpriced: string[];
}

export type PriceFetcher = (
  asset: string,
) => Promise<{ price: string; source: string } | null>;

/**
 * Value native balances at current spot prices.
 * Price fetches run with bounded concurrency; a failed price leaves the
 * asset unpriced (NOT zeroed).
 */
export async function valuate(
  balances: NativeBalance[],
  priceFor: PriceFetcher,
  nowIso: string,
): Promise<Valuation> {
  const items: ValuedBalance[] = [];
  // Bounded concurrency: 6 at a time.
  const queue = [...balances];
  const results = new Map<string, ValuedBalance>();
  const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length > 0) {
      const b = queue.shift();
      if (!b) break;
      let price: { price: string; source: string } | null = null;
      try {
        price = await priceFor(b.asset);
      } catch {
        price = null;
      }
      let valueCents: bigint | null = null;
      if (price) {
        try {
          const v = mulDecimal(parseDecimal(b.quantity), parseDecimal(price.price));
          valueCents = roundToCents(v);
        } catch {
          valueCents = null;
          price = null;
        }
      }
      results.set(b.asset, {
        asset: b.asset,
        quantity: b.quantity,
        priceUsd: price ? price.price : null,
        priceSource: price ? price.source : null,
        priceAt: price ? nowIso : null,
        valueCents,
      });
    }
  });
  await Promise.all(workers);
  for (const b of balances) {
    const r = results.get(b.asset);
    if (r) items.push(r);
  }

  // Two-way totals, all in BigInt — no float anywhere.
  let totalCents = 0n;
  let unroundedSum: Decimal = { int: 0n, scale: 0 };
  let pricedCount = 0;
  const unpriced: string[] = [];
  for (const it of items) {
    if (it.valueCents == null || it.priceUsd == null) {
      unpriced.push(it.asset);
      continue;
    }
    pricedCount++;
    totalCents += it.valueCents;
    unroundedSum = addDecimal(unroundedSum, mulDecimal(parseDecimal(it.quantity), parseDecimal(it.priceUsd)));
  }
  const altCents = roundToCents(unroundedSum);
  const driftCents = totalCents - altCents;
  const n = BigInt(pricedCount);
  const absDrift = driftCents < 0n ? -driftCents : driftCents;
  // Theoretical bound: each row rounds by at most half a cent.
  const reconciled = absDrift * 2n <= n;
  return { items, totalCents, altCents, driftCents, reconciled, pricedCount, unpriced };
}

/** Assets we treat as exactly 1 USD without a price lookup. */
export function isUsdPegged(asset: string): boolean {
  const u = asset.toUpperCase();
  return u === "USD" || u === "USDT" || STABLECOINS.has(u);
}
