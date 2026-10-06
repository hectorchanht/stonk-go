/**
 * Read-only clients for Coinbase (Advanced Trade) and Binance (Spot).
 *
 * Runs on Cloudflare Workers and Node with zero dependencies (WebCrypto +
 * global fetch only). NEVER calls trading/order endpoints — balances and
 * public prices only.
 *
 * Number discipline (Hector's requirement): exchange balance endpoints return
 * NATIVE asset quantities (e.g. "0.05" BTC), never fiat values. We keep the
 * native quantity as an exact decimal string end-to-end, fetch the exchange's
 * own spot price at sync time, and compute USD values with BigInt decimal
 * math (no float drift). Rounding happens once, to integer cents, half-up.
 * The account total is computed two ways and reconciled — any discrepancy is
 * surfaced, never hidden.
 */

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

export type ExchangeName = "coinbase" | "binance";

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

function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.trim();
  let bin: string;
  try {
    bin = atob(clean);
  } catch {
    throw new ExchangeError("coinbase", "API secret is not valid base64.");
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

/* ------------------------------------------------------------------ */
/* Shared fetch plumbing                                               */
/* ------------------------------------------------------------------ */

type FetchFn = typeof fetch;

async function readJson(res: Response, exchange: ExchangeName, what: string): Promise<unknown> {
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as Record<string, unknown>;
      // Binance: { code, msg }. Coinbase: { message } / { error }.
      const msg =
        (body.msg as string | undefined) ??
        (body.message as string | undefined) ??
        (body.error as string | undefined);
      if (msg) detail = `: ${String(msg).slice(0, 200)}`;
      if (typeof body.code !== "undefined") detail = ` (code ${String(body.code)})${detail}`;
    } catch {
      /* non-JSON error body */
    }
    throw new ExchangeError(exchange, `${what} failed (HTTP ${res.status})${detail}`, res.status);
  }
  return res.json() as Promise<unknown>;
}

function hintForStatus(exchange: ExchangeName, status: number): string {
  if (status === 401 || status === 403) {
    return exchange === "coinbase"
      ? " Check that the API key is correct and has not been deleted."
      : " Check the API key/secret and that the key has 'Enable Reading' permission (no trading permission needed).";
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
