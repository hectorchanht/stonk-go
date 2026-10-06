/**
 * Longbridge (長橋證券) OpenAPI client (read-only).
 *
 * Longbridge publishes an official cloud OpenAPI — no local gateway needed.
 * Legacy auth uses three values from the open.longportapp.com user center:
 * App Key, App Secret and Access Token. Every request is signed:
 *
 *   timestamp = unix seconds as integer string
 *   signed_headers = "authorization;x-api-key;x-timestamp"
 *   signed_values  = "authorization:{token}\nx-api-key:{key}\nx-timestamp:{ts}\n"
 *   str_to_sign    = "{METHOD}|{path}|{query}|{signed_values}|{signed_headers}|"
 *   (append sha1_hex(body) when a body is present)
 *   s2             = "HMAC-SHA256|" + sha1_hex(str_to_sign)
 *   signature      = hex(hmac_sha256(s2, app_secret))
 *   Authorization  = "HMAC-SHA256 SignedHeaders={signed_headers}, Signature={signature}"
 *
 * plus the raw `authorization: {access_token}` header (NOT "Bearer ..."),
 * `x-api-key` and `x-timestamp`.
 *
 * This client is READ-ONLY by construction: only asset/order-query
 * endpoints are implemented. Order placement, modification and
 * cancellation endpoints are deliberately absent — nothing in this
 * module can trade.
 *
 * Money handling mirrors questrade.ts: decimal strings are parsed through
 * parseDecimal() (string-based half-up rounding, no float arithmetic),
 * capped at 10 decimals. Display rounding happens only at render time.
 */

const LB_BASE = "https://openapi.longbridge.com";

export class LongbridgeError extends Error {
  code: string | null;
  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = "LongbridgeError";
    this.code = code;
  }
}

/* ---------------- decimal-safe parsing (copied from questrade.ts) ---------------- */

/** Max decimals kept at ingestion. Display rounding (2dp) happens at render. */
const MAX_DP = 10;

/**
 * Half-up round a validated decimal string to `dp` places using only
 * string/integer arithmetic — no float ops, so no drift.
 */
function roundDecimalString(s: string, dp: number): string {
  const neg = s.startsWith("-");
  const abs = neg ? s.slice(1) : s;
  const dot = abs.indexOf(".");
  const intPart = dot === -1 ? abs : abs.slice(0, dot);
  const fracPart = dot === -1 ? "" : abs.slice(dot + 1);
  const sign = neg ? "-" : "";
  if (fracPart.length <= dp) {
    return `${sign}${intPart}${fracPart ? `.${fracPart}` : ""}`;
  }
  const keep = fracPart.slice(0, dp);
  if (fracPart[dp]! < "5") {
    return `${sign}${intPart}${keep ? `.${keep}` : ""}`;
  }
  // Add one to (intPart + keep) as a decimal string.
  const digits = (intPart + keep).split("").map((c) => Number(c));
  let i = digits.length - 1;
  let carry = 1;
  while (i >= 0 && carry > 0) {
    const sum = digits[i]! + carry;
    digits[i] = sum % 10;
    carry = sum >= 10 ? 1 : 0;
    i--;
  }
  let result = (carry > 0 ? "1" : "") + digits.join("");
  if (dp > 0) {
    const cut = result.length - dp;
    result = `${result.slice(0, cut)}.${result.slice(cut)}`;
  }
  return `${sign}${result}`;
}

/**
 * Parse a JSON number/string into a decimal-safe number.
 * Returns null for missing/empty; throws LongbridgeError on malformed input
 * (fail loudly — a bad number must never silently become 0).
 */
export function parseDecimal(value: unknown, field = "value"): number | null {
  if (value === null || value === undefined) return null;
  const s = typeof value === "string" ? value.trim() : String(value);
  if (s === "") return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new LongbridgeError(
      `Invalid decimal for ${field}: ${JSON.stringify(s).slice(0, 80)}`,
    );
  }
  return Number(roundDecimalString(s, MAX_DP));
}

/* ---------------- JSON shape guards ---------------- */

function asRecord(v: unknown, what: string): Record<string, unknown> {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  throw new LongbridgeError(`Unexpected ${what}: not an object`);
}

function reqStr(r: Record<string, unknown>, key: string, what: string): string {
  const v = r[key];
  if (typeof v === "string" && v !== "") return v;
  throw new LongbridgeError(`Unexpected ${what}: missing string "${key}"`);
}

function optStr(r: Record<string, unknown>, key: string): string | null {
  const v = r[key];
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string") return v;
  throw new LongbridgeError(`Unexpected field "${key}": not a string`);
}

function reqNum(r: Record<string, unknown>, key: string, what: string): number {
  const v = parseDecimal(r[key], `${what}.${key}`);
  if (v === null) throw new LongbridgeError(`Unexpected ${what}: missing "${key}"`);
  return v;
}

function optNum(r: Record<string, unknown>, key: string, what: string): number | null {
  return parseDecimal(r[key], `${what}.${key}`);
}

function asArray(v: unknown, what: string): unknown[] {
  if (Array.isArray(v)) return v;
  throw new LongbridgeError(`Unexpected ${what}: not an array`);
}

/* ---------------- request signing ---------------- */

const SIGNED_HEADERS = "authorization;x-api-key;x-timestamp";

const enc = new TextEncoder();

/** ArrayBuffer → lowercase hex, no Buffer needed (Workers-safe). */
function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha1Hex(s: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-1", enc.encode(s)));
}

async function hmacSha256Hex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

export interface LbSignature {
  /** The full `Authorization` header value to send. */
  authorization: string;
  /** The signed headers to send (`authorization`, `x-api-key`, `x-timestamp`). */
  headers: Record<string, string>;
  /** The hex signature (also embedded in `authorization`). */
  signature: string;
}

/**
 * Sign a Longbridge API request (legacy App Key + App Secret + Access Token).
 *
 * - `path`: URL path only, e.g. "/v1/asset/stock".
 * - `query`: the RAW query string ("" when none) — must match the URL exactly.
 * - `bodyString`: the exact request body string, or null for no body.
 * - `timestamp`: unix seconds as an integer string, e.g. "1720000000".
 */
export async function signLongbridgeRequest(
  appKey: string,
  appSecret: string,
  accessToken: string,
  method: string,
  path: string,
  query: string,
  bodyString: string | null,
  timestamp: string,
): Promise<LbSignature> {
  const signedValues =
    `authorization:${accessToken}\n` +
    `x-api-key:${appKey}\n` +
    `x-timestamp:${timestamp}\n`;
  let strToSign = `${method}|${path}|${query}|${signedValues}|${SIGNED_HEADERS}|`;
  if (bodyString !== null) {
    strToSign += await sha1Hex(bodyString);
  }
  const s2 = `HMAC-SHA256|${await sha1Hex(strToSign)}`;
  const signature = await hmacSha256Hex(s2, appSecret);
  return {
    authorization: `HMAC-SHA256 SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`,
    headers: {
      authorization: accessToken,
      "x-api-key": appKey,
      "x-timestamp": timestamp,
    },
    signature,
  };
}

/* ---------------- transport ---------------- */

export type FetchLike = typeof fetch;

/**
 * Pull {code, message} out of a Longbridge envelope ({code, message}).
 * The message is capped at 200 chars. Only the API's own code/text are
 * ever included: no credentials, no URLs, no request details.
 */
function errorFields(json: unknown): { code: string | null; message: string } {
  const r =
    json !== null && typeof json === "object" && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : null;
  const code = typeof r?.code === "number" ? String(r.code) : null;
  const message = typeof r?.message === "string" ? r.message.slice(0, 200) : "";
  return { code, message };
}

function throwEnvelopeError(json: unknown, what: string): never {
  const { code, message } = errorFields(json);
  throw new LongbridgeError(
    `Longbridge ${what} failed${code ? ` (code ${code})` : ""}${message ? `: ${message}` : ""}`,
    code,
  );
}

async function lbGet(
  appKey: string,
  appSecret: string,
  accessToken: string,
  path: string,
  query: string,
  what: string,
  fetcher: FetchLike = fetch,
): Promise<unknown> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const { authorization, headers } = await signLongbridgeRequest(
    appKey,
    appSecret,
    accessToken,
    "GET",
    path,
    query,
    null,
    timestamp,
  );
  const url = `${LB_BASE}${path}${query ? `?${query}` : ""}`;
  let res: Response;
  try {
    res = await fetcher(url, {
      method: "GET",
      headers: { ...headers, Authorization: authorization },
    });
  } catch (e) {
    throw new LongbridgeError(
      `Longbridge ${what} request failed: ${e instanceof Error ? e.message.slice(0, 120) : "network error"}`,
    );
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* fall through to the HTTP-status error below */
  }
  if (!res.ok) {
    const { code, message } = errorFields(json);
    throw new LongbridgeError(
      `Longbridge ${what} failed (HTTP ${res.status}${code ? `, code ${code}` : ""})${message ? `: ${message}` : ""}`,
      code,
    );
  }
  const r = asRecord(json, `${what} response`);
  if (r.code !== 0) throwEnvelopeError(json, what);
  return r.data;
}

/* ---------------- symbol normalization ---------------- */

/**
 * Normalize a Longbridge market-qualified symbol into Holdr's symbol form:
 * - "700.HK"  → "0700.HK" (HK numeric part padded to 4 digits)
 * - "5.HK"    → "0005.HK"
 * - "AAPL.US" → "AAPL"    (US suffix stripped)
 * - "600519.SH" → "600519.SH" (non-US/HK symbols pass through unchanged)
 */
export function normalizeLongbridgeSymbol(symbol: string): string {
  const dot = symbol.lastIndexOf(".");
  if (dot === -1) return symbol;
  const code = symbol.slice(0, dot);
  const suffix = symbol.slice(dot + 1).toUpperCase();
  if (suffix === "HK" && /^\d+$/.test(code) && code.length < 4) {
    return `${code.padStart(4, "0")}.HK`;
  }
  if (suffix === "US") {
    return code;
  }
  return symbol;
}

/* ---------------- parsed shapes ---------------- */

export interface LbPosition {
  /** Account channel, e.g. "HK" / "US" / "CN" — used as the account id. */
  accountChannel: string;
  /** Normalized symbol (see normalizeLongbridgeSymbol). */
  symbol: string;
  /** Longbridge symbol_name, e.g. "TENCENT". */
  description: string | null;
  currency: string | null;
  quantity: number;
  availableQuantity: number | null;
  costPrice: number | null;
  market: string | null;
}

export interface LbBalance {
  accountChannel: string | null;
  currency: string | null;
  totalCash: number | null;
  netAssets: number | null;
  buyPower: number | null;
}

export interface LbTrade {
  orderId: string;
  /** Account channel when the API reports it, else null. */
  accountChannel: string | null;
  /** Normalized symbol. */
  symbol: string;
  currency: string | null;
  /** YYYYMMDD derived from submitted_at. */
  tradeDate: string;
  /** Signed: Buy → +qty, Sell → −qty. */
  quantity: number;
  /** executed_price ?? price. */
  tradePrice: number | null;
}

/* ---------------- parsers (pure, testable) ---------------- */

/**
 * Parse GET /v1/asset/stock data:
 * {list: [{account_channel, stock_info: [{symbol, symbol_name, quantity,
 *  available_quantity, currency, cost_price, market}]}]}
 */
export function parseStockPositions(data: unknown): LbPosition[] {
  const root = asRecord(data, "asset/stock data");
  const positions: LbPosition[] = [];
  for (const acct of asArray(root.list, "asset/stock list")) {
    const a = asRecord(acct, "asset/stock account");
    const channel = reqStr(a, "account_channel", "asset/stock account");
    for (const s of asArray(a.stock_info, "asset/stock stock_info")) {
      const p = asRecord(s, "asset/stock position");
      positions.push({
        accountChannel: channel,
        symbol: normalizeLongbridgeSymbol(reqStr(p, "symbol", "asset/stock position")),
        description: optStr(p, "symbol_name"),
        currency: optStr(p, "currency"),
        quantity: reqNum(p, "quantity", "asset/stock position"),
        availableQuantity: optNum(p, "available_quantity", "asset/stock position"),
        costPrice: optNum(p, "cost_price", "asset/stock position"),
        market: optStr(p, "market"),
      });
    }
  }
  return positions;
}

/** Parse GET /v1/asset/account data: {list: [{total_cash, net_assets, buy_power, currency, ...}]} */
export function parseAccountBalance(data: unknown): LbBalance[] {
  const root = asRecord(data, "asset/account data");
  return asArray(root.list, "asset/account list").map((entry) => {
    const b = asRecord(entry, "asset/account entry");
    return {
      accountChannel: optStr(b, "account_channel"),
      currency: optStr(b, "currency"),
      totalCash: optNum(b, "total_cash", "asset/account entry"),
      netAssets: optNum(b, "net_assets", "asset/account entry"),
      buyPower: optNum(b, "buy_power", "asset/account entry"),
    };
  });
}

/** Order statuses that count as executed. The wire format is camelCase
 *  ("Filled", "PartiallyFilled"), so non-letters are stripped before the
 *  comparison — "PARTIALLY_FILLED" matches too. */
const FILLED_STATUSES = new Set(["FILLED", "PARTIALLYFILLED"]);

const normalizeStatus = (s: unknown): string =>
  String(s ?? "").toUpperCase().replace(/[^A-Z]/g, "");

/**
 * Parse GET /v1/trade/order/history data:
 * {list: [{order_id, status, symbol, side ("Buy"/"Sell"), submitted_quantity,
 *  executed_quantity, price, executed_price, submitted_at (RFC3339), currency}]}
 *
 * Keeps only FILLED / PARTIALLY_FILLED orders with executed_quantity > 0.
 * Buy → +qty, Sell → −qty. tradePrice = executed_price ?? price.
 */
export function parseHistoryOrders(data: unknown): LbTrade[] {
  const root = asRecord(data, "trade/order/history data");
  const trades: LbTrade[] = [];
  for (const entry of asArray(root.list, "trade/order/history list")) {
    const o = asRecord(entry, "trade/order/history order");
    const status = normalizeStatus(o.status);
    if (!FILLED_STATUSES.has(status)) continue;
    const executedQty = optNum(o, "executed_quantity", "trade/order/history order");
    if (executedQty === null || executedQty <= 0) continue;
    const side = String(o.side ?? "").toLowerCase();
    const signedQty = side === "sell" ? -executedQty : executedQty;
    const submittedAt = reqStr(o, "submitted_at", "trade/order/history order");
    const d = new Date(submittedAt);
    if (Number.isNaN(d.getTime())) {
      throw new LongbridgeError(
        `Unexpected trade/order/history order: bad submitted_at ${JSON.stringify(submittedAt).slice(0, 40)}`,
      );
    }
    const tradeDate =
      `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    trades.push({
      orderId: reqStr(o, "order_id", "trade/order/history order"),
      accountChannel: optStr(o, "account_channel"),
      symbol: normalizeLongbridgeSymbol(reqStr(o, "symbol", "trade/order/history order")),
      currency: optStr(o, "currency"),
      tradeDate,
      quantity: signedQty,
      tradePrice:
        optNum(o, "executed_price", "trade/order/history order") ??
        optNum(o, "price", "trade/order/history order"),
    });
  }
  return trades;
}

/* ---------------- live fetchers ---------------- */

/** GET /v1/asset/stock — stock positions across all account channels. */
export async function getStockPositions(
  appKey: string,
  appSecret: string,
  accessToken: string,
  fetcher: FetchLike = fetch,
): Promise<LbPosition[]> {
  return parseStockPositions(await lbGet(appKey, appSecret, accessToken, "/v1/asset/stock", "", "asset/stock", fetcher));
}

/** GET /v1/asset/account — per-currency account balances. */
export async function getAccountBalance(
  appKey: string,
  appSecret: string,
  accessToken: string,
  fetcher: FetchLike = fetch,
): Promise<LbBalance[]> {
  return parseAccountBalance(await lbGet(appKey, appSecret, accessToken, "/v1/asset/account", "", "asset/account", fetcher));
}

/**
 * GET /v1/trade/order/history — filled order history between two dates.
 * Dates are RFC3339; the raw query string is built once and used for both
 * the URL and the signature.
 */
export async function getHistoryOrders(
  appKey: string,
  appSecret: string,
  accessToken: string,
  startAt: Date,
  endAt: Date,
  fetcher: FetchLike = fetch,
): Promise<LbTrade[]> {
  const query =
    `start_at=${encodeURIComponent(startAt.toISOString())}` +
    `&end_at=${encodeURIComponent(endAt.toISOString())}`;
  return parseHistoryOrders(
    await lbGet(appKey, appSecret, accessToken, "/v1/trade/order/history", query, "trade/order/history", fetcher),
  );
}
