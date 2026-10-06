/**
 * Webull OpenAPI client (read-only).
 *
 * Webull exposes an official cloud API (https://api.webull.com) — no local
 * gateway needed. Auth is a per-request HMAC-SHA1 signature (NOT a bearer
 * token): every request carries x-app-key / x-signature / x-signature-nonce /
 * x-timestamp headers, and the signature is computed from the request path,
 * sorted params, and body hash with the App Secret.
 *
 * READ-ONLY BY CONSTRUCTION: only account/asset/order-history GET endpoints
 * are implemented. Order placement, modification, and cancellation endpoints
 * are deliberately absent — this client cannot trade, even if asked to.
 *
 * Signing follows Webull's official "Signature" documentation (verified
 * against the worked example on developer.webull.com — see the test file):
 *   str1 = sorted "k=v&k=v" of query params + signing headers
 *          (x-app-key, x-signature-algorithm, x-signature-version,
 *           x-signature-nonce, x-timestamp, host). Header names are already
 *           lowercase; VALUES ARE USED VERBATIM (e.g. "HMAC-SHA1" and the
 *           ISO-8601 timestamp are not lowercased) — the server recomputes
 *           the signature from the received header values.
 *   str2 = ToUpper(MD5(body)) for non-empty bodies; EMPTY BODIES DO NOT
 *          PARTICIPATE — str3 = path + "&" + str1 (no MD5("") suffix).
 *   str3 = path + "&" + str1 [+ "&" + str2]
 *   encoded = percent-encode(str3)  (encodeURIComponent + !'()* )
 *   signature = base64(HMAC-SHA1(encoded, app_secret + "&"))
 *
 * Crypto note: WebCrypto has no MD5, and we want the signer to be fully
 * synchronous/pure (deterministic given timestamp+nonce), so MD5, SHA-1,
 * HMAC-SHA1, and base64 are implemented in dependency-free TypeScript below.
 * The implementations are validated against RFC vectors and Webull's
 * official worked example in webull.test.ts.
 *
 * NOTE on algorithm agility: some newer Webull SDKs/deployments sign with
 * HMAC-SHA256 and declare `x-signature-algorithm: HMAC-SHA256`. We follow
 * the official docs (HMAC-SHA1) and declare it in the header. If the server
 * ever returns INCORRECT_SIGN on a correctly-formed request, the deployment
 * may expect SHA256 — switch SIGN_ALGORITHM and the HMAC below, not the
 * canonicalization.
 *
 * Money handling mirrors the Questrade client: decimal strings are parsed
 * through parseDecimal() with string-based half-up rounding capped at 10
 * decimals — no float drift. Display rounding happens at render time only.
 */

const API_BASE = "https://api.webull.com";
const API_HOST = "api.webull.com";
const SIGN_ALGORITHM = "HMAC-SHA1";
const SIGN_VERSION = "1.0";

const te = new TextEncoder();

export class WebullError extends Error {
  code: string | null;
  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = "WebullError";
    this.code = code;
  }
}

/* ---------------- decimal-safe parsing ---------------- */

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
 * Returns null for missing/empty; throws WebullError on malformed input
 * (fail loudly — a bad number must never silently become 0).
 */
export function parseDecimal(value: unknown, field = "value"): number | null {
  if (value === null || value === undefined) return null;
  const s = typeof value === "string" ? value.trim() : String(value);
  if (s === "") return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new WebullError(
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
  throw new WebullError(`Unexpected ${what}: not an object`);
}

function reqStr(r: Record<string, unknown>, key: string, what: string): string {
  const v = r[key];
  if (typeof v === "string" && v !== "") return v;
  throw new WebullError(`Unexpected ${what}: missing string "${key}"`);
}

function optStr(r: Record<string, unknown>, key: string): string | null {
  const v = r[key];
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string") return v;
  throw new WebullError(`Unexpected field "${key}": not a string`);
}

function reqNum(r: Record<string, unknown>, key: string, what: string): number {
  const v = parseDecimal(r[key], `${what}.${key}`);
  if (v === null) throw new WebullError(`Unexpected ${what}: missing "${key}"`);
  return v;
}

function optNum(r: Record<string, unknown>, key: string, what: string): number | null {
  return parseDecimal(r[key], `${what}.${key}`);
}

/** Accept a bare array or a {data:[...]} envelope defensively. */
function asDataArray(json: unknown, what: string): Array<Record<string, unknown>> {
  const v =
    json !== null && typeof json === "object" && !Array.isArray(json)
      ? ((json as Record<string, unknown>).data ?? json)
      : json;
  if (!Array.isArray(v)) throw new WebullError(`Unexpected ${what}: not an array`);
  return v.map((e) => asRecord(e, what));
}

/** Accept a bare object or a {data:{...}} envelope defensively. */
function asDataRecord(json: unknown, what: string): Record<string, unknown> {
  const r = asRecord(json, what);
  const d = r.data;
  if (d !== null && typeof d === "object" && !Array.isArray(d)) {
    return d as Record<string, unknown>;
  }
  return r;
}

/* ---------------- dependency-free crypto ---------------- */

function rotl32(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

/** MD5 (RFC 1321) over UTF-8 bytes. WebCrypto has no MD5, so this is hand-rolled. */
function md5Bytes(input: Uint8Array): Uint8Array {
  const bitLen = input.length * 8;
  const withOne = input.length + 1;
  const padLen = (56 - (withOne % 64) + 64) % 64;
  const total = withOne + padLen + 8;
  const msg = new Uint8Array(total);
  msg.set(input);
  msg[input.length] = 0x80;
  const view = new DataView(msg.buffer);
  view.setUint32(total - 8, bitLen >>> 0, true);
  view.setUint32(total - 4, Math.floor(bitLen / 4294967296), true);

  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K: number[] = [];
  for (let i = 0; i < 64; i++) {
    K.push(Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);
  }

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(off + i * 4, true);
    let A = a;
    let B = b;
    let C = c;
    let D = d;
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i]! + M[g]!) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl32(F, S[i]!)) >>> 0;
    }
    a = (a + A) >>> 0;
    b = (b + B) >>> 0;
    c = (c + C) >>> 0;
    d = (d + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a, true);
  ov.setUint32(4, b, true);
  ov.setUint32(8, c, true);
  ov.setUint32(12, d, true);
  return out;
}

/** SHA-1 (RFC 3174) over UTF-8 bytes. */
function sha1Bytes(input: Uint8Array): Uint8Array {
  const bitLenHi = Math.floor(input.length / 536870912);
  const bitLenLo = (input.length * 8) >>> 0;
  const withOne = input.length + 1;
  const padLen = (56 - (withOne % 64) + 64) % 64;
  const total = withOne + padLen + 8;
  const msg = new Uint8Array(total);
  msg.set(input);
  msg[input.length] = 0x80;
  const view = new DataView(msg.buffer);
  view.setUint32(total - 8, bitLenHi >>> 0, false);
  view.setUint32(total - 4, bitLenLo >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 80; i++) {
      w[i] = rotl32(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const tmp = (rotl32(a, 5) + f + e + k + w[i]!) >>> 0;
      e = d;
      d = c;
      c = rotl32(b, 30);
      b = a;
      a = tmp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, h0, false);
  ov.setUint32(4, h1, false);
  ov.setUint32(8, h2, false);
  ov.setUint32(12, h3, false);
  ov.setUint32(16, h4, false);
  return out;
}

/** HMAC-SHA1. Kept synchronous so the signer stays pure. */
function hmacSha1(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const blockSize = 64;
  const k = key.length > blockSize ? sha1Bytes(key) : key;
  const kb = new Uint8Array(blockSize);
  kb.set(k);
  const inner = new Uint8Array(blockSize + msg.length);
  const outer = new Uint8Array(blockSize + 20);
  for (let i = 0; i < blockSize; i++) {
    inner[i] = kb[i]! ^ 0x36;
    outer[i] = kb[i]! ^ 0x5c;
  }
  inner.set(msg, blockSize);
  const innerHash = sha1Bytes(inner);
  outer.set(innerHash, blockSize);
  return sha1Bytes(outer);
}

const B64CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out +=
      B64CHARS[b0 >> 2]! +
      B64CHARS[((b0 & 3) << 4) | (b1 >> 4)]! +
      (i + 1 < bytes.length ? B64CHARS[((b1 & 15) << 2) | (b2 >> 6)]! : "=") +
      (i + 2 < bytes.length ? B64CHARS[b2 & 63]! : "=");
  }
  return out;
}

function hexUpper(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/**
 * Percent-encode per the official docs (Python's quote(safe="")):
 * encodeURIComponent leaves !'()* unescaped, so encode those too.
 */
function pctEncode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/* ---------------- signature ---------------- */

/**
 * Build the pre-encoding signature string:
 *   path + "&" + sortedParams [+ "&" + ToUpper(MD5(body))]
 * `signedParams` is the merged map of query params + signing headers.
 * Exported for testing against Webull's official worked example.
 */
export function buildSignString(
  uri: string,
  signedParams: Record<string, string>,
  bodyString: string,
): string {
  const sorted = Object.keys(signedParams)
    .sort()
    .map((k) => `${k}=${signedParams[k]}`)
    .join("&");
  if (bodyString === "") {
    // Per the official docs, an empty body does not participate in the
    // signature at all — no MD5("") suffix is appended.
    return `${uri}&${sorted}`;
  }
  return `${uri}&${sorted}&${hexUpper(md5Bytes(te.encode(bodyString)))}`;
}

export interface SignedWebullRequest {
  headers: Record<string, string>;
  signature: string;
}

/**
 * Sign a Webull request. Pure and synchronous: timestamp and nonce are
 * passed in (the live caller generates them per request), so the output is
 * fully determined by the inputs and unit-testable.
 */
export function signWebullRequest(
  appKey: string,
  appSecret: string,
  method: string,
  uri: string,
  queryParams: Record<string, string>,
  bodyString: string,
  timestamp: string,
  nonce: string,
): SignedWebullRequest {
  // All current calls are GETs and carry no body.
  const body = method.toUpperCase() === "GET" ? "" : bodyString;
  const signedParams: Record<string, string> = {
    ...queryParams,
    "x-app-key": appKey,
    "x-signature-algorithm": SIGN_ALGORITHM,
    "x-signature-version": SIGN_VERSION,
    "x-signature-nonce": nonce,
    "x-timestamp": timestamp,
    host: API_HOST,
  };
  const signString = buildSignString(uri, signedParams, body);
  const encoded = pctEncode(signString);
  const signature = base64Encode(
    hmacSha1(te.encode(`${appSecret}&`), te.encode(encoded)),
  );
  return {
    headers: {
      "x-app-key": appKey,
      "x-signature": signature,
      "x-signature-algorithm": SIGN_ALGORITHM,
      "x-signature-version": SIGN_VERSION,
      "x-signature-nonce": nonce,
      "x-timestamp": timestamp,
      host: API_HOST,
    },
    signature,
  };
}

/** Uppercase + trim; Webull symbols arrive in mixed case per market. */
export function normalizeWebullSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/* ---------------- response parsing ---------------- */

export interface WebullCredentials {
  appKey: string;
  appSecret: string;
  /** Only needed when the deployment has token check enabled. */
  accessToken?: string;
}

export interface WbAccount {
  accountId: string;
  accountType: string | null;
}

export function parseAccountList(json: unknown): WbAccount[] {
  return asDataArray(json, "account list").map((a) => ({
    accountId: reqStr(a, "account_id", "account"),
    accountType: optStr(a, "account_type"),
  }));
}

export interface WbBalance {
  totalCashBalance: number | null;
  totalMarketValue: number | null;
  totalNetLiquidationValue: number | null;
  currency: string | null;
}

export function parseBalance(json: unknown): WbBalance {
  const r = asDataRecord(json, "balance");
  return {
    totalCashBalance: optNum(r, "total_cash_balance", "balance"),
    totalMarketValue: optNum(r, "total_market_value", "balance"),
    totalNetLiquidationValue: optNum(r, "total_net_liquidation_value", "balance"),
    currency: optStr(r, "currency"),
  };
}

export interface WbPosition {
  symbol: string;
  quantity: number;
  costPrice: number | null;
  instrumentType: string | null;
  currency: string | null;
}

export function parsePositions(json: unknown): WbPosition[] {
  return asDataArray(json, "positions").map((p) => ({
    symbol: reqStr(p, "symbol", "position"),
    quantity: reqNum(p, "quantity", "position"),
    costPrice: optNum(p, "cost_price", "position"),
    instrumentType: optStr(p, "instrument_type"),
    currency: optStr(p, "currency"),
  }));
}

export interface WbTrade {
  symbol: string;
  side: "BUY" | "SELL";
  /** YYYYMMDD, or null when create_time is missing/unparseable. */
  tradeDate: string | null;
  /** Signed quantity: +buy / -sell. */
  quantity: number;
  tradePrice: number | null;
  currency: string | null;
  orderId: string | null;
}

/** Only filled-ish orders become trades; anything else is noise. */
const FILLED_STATUSES = new Set(["FILLED", "PARTIAL_FILLED", "PARTIALLY_FILLED"]);

/** Extract YYYYMMDD from ISO-8601 or "YYYY-MM-DD HH:mm:ss" timestamps. */
function toYmd(v: string | null): string | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  return m ? `${m[1]}${m[2]}${m[3]}` : null;
}

export function parseOrderHistory(json: unknown): WbTrade[] {
  const trades: WbTrade[] = [];
  for (const o of asDataArray(json, "order history")) {
    const status = (optStr(o, "status") ?? "").toUpperCase();
    if (!FILLED_STATUSES.has(status)) continue;
    const side = (optStr(o, "side") ?? "").toUpperCase();
    if (side !== "BUY" && side !== "SELL") continue;
    const filledQty = optNum(o, "filled_quantity", "order");
    if (filledQty === null || filledQty <= 0) continue;
    trades.push({
      symbol: reqStr(o, "symbol", "order"),
      side,
      tradeDate: toYmd(optStr(o, "create_time")),
      quantity: side === "BUY" ? filledQty : -filledQty,
      tradePrice:
        optNum(o, "filled_price", "order") ?? optNum(o, "avg_price", "order"),
      currency: optStr(o, "currency"),
      orderId: optStr(o, "client_order_id") ?? optStr(o, "order_id"),
    });
  }
  return trades;
}

/* ---------------- signed GET endpoints ---------------- */

/** Injectable fetch for tests; defaults to the global fetch. */
export type FetchLike = (
  url: string,
  init: RequestInit,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

/**
 * Pull {error_code, message} out of a Webull error JSON body.
 * The message is capped at 200 chars. Only the API's own code/text are ever
 * included: no credentials, no URLs, no request details.
 */
function errorFields(json: unknown): { code: string | null; message: string } {
  const r =
    json !== null && typeof json === "object" && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : null;
  const rawCode = r?.error_code;
  const code =
    typeof rawCode === "string" || typeof rawCode === "number"
      ? String(rawCode)
      : null;
  const message = typeof r?.message === "string" ? r.message.slice(0, 200) : "";
  return { code, message };
}

/** Official docs format: YYYY-MM-DDThh:mm:ssZ (UTC, seconds precision). */
function utcTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function signedGet(
  creds: WebullCredentials,
  uri: string,
  queryParams: Record<string, string>,
  fetcher: FetchLike = defaultFetch,
): Promise<unknown> {
  const timestamp = utcTimestamp();
  const nonce = crypto.randomUUID();
  const { headers } = signWebullRequest(
    creds.appKey,
    creds.appSecret,
    "GET",
    uri,
    queryParams,
    "",
    timestamp,
    nonce,
  );
  const query = new URLSearchParams(queryParams).toString();
  const url = `${API_BASE}${uri}${query ? `?${query}` : ""}`;
  const reqHeaders: Record<string, string> = {
    ...headers,
    // Required by the API; explicitly excluded from the signature.
    "x-version": "v3",
  };
  if (creds.accessToken) reqHeaders["x-access-token"] = creds.accessToken;
  let res: { ok: boolean; status: number; json(): Promise<unknown> };
  try {
    res = await fetcher(url, { method: "GET", headers: reqHeaders });
  } catch (e) {
    throw new WebullError(
      `Webull GET ${uri} network error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    const json: unknown = await res.json().catch(() => null);
    const { code, message } = errorFields(json);
    const signHint = /sign/i.test(`${code ?? ""} ${message}`)
      ? " (signature rejected — this client signs HMAC-SHA1 per the official docs; some deployments expect HMAC-SHA256)"
      : "";
    throw new WebullError(
      `Webull GET ${uri} failed (HTTP ${res.status}${code ? `, ${code}` : ""})${message ? `: ${message}` : ""}${signHint}`,
      code,
    );
  }
  return await res.json();
}

export async function getAccountList(
  creds: WebullCredentials,
  _accountId?: string,
  fetcher: FetchLike = defaultFetch,
): Promise<WbAccount[]> {
  return parseAccountList(
    await signedGet(creds, "/openapi/account/list", {}, fetcher),
  );
}

export async function getBalance(
  creds: WebullCredentials,
  accountId?: string,
  fetcher: FetchLike = defaultFetch,
): Promise<WbBalance> {
  if (!accountId) throw new WebullError("getBalance requires an accountId");
  return parseBalance(
    await signedGet(
      creds,
      "/openapi/assets/balance",
      { account_id: accountId },
      fetcher,
    ),
  );
}

export async function getPositions(
  creds: WebullCredentials,
  accountId?: string,
  fetcher: FetchLike = defaultFetch,
): Promise<WbPosition[]> {
  if (!accountId) throw new WebullError("getPositions requires an accountId");
  return parsePositions(
    await signedGet(
      creds,
      "/openapi/assets/positions",
      { account_id: accountId },
      fetcher,
    ),
  );
}

export async function getOrderHistory(
  creds: WebullCredentials,
  accountId?: string,
  fetcher: FetchLike = defaultFetch,
): Promise<WbTrade[]> {
  if (!accountId) throw new WebullError("getOrderHistory requires an accountId");
  return parseOrderHistory(
    await signedGet(
      creds,
      "/openapi/trade/order/history",
      { account_id: accountId },
      fetcher,
    ),
  );
}
