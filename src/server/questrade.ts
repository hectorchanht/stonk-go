/**
 * Questrade IQ API client (read-only).
 *
 * Questrade is the one Canadian brokerage with an official personal API.
 * Auth is a rotating refresh-token flow: the user generates a *manual
 * authorization token* once in Questrade (top-right menu → API centre →
 * register a personal app → New manual authorization → Generate new token),
 * and every exchange returns a NEW single-use refresh token that must be
 * persisted. Personal tokens are read-only — order placement requires
 * partner access, so this client cannot trade by construction (no order
 * endpoints are implemented).
 *
 * Field semantics verified against Questrade's API docs (and the typed
 * questrade-api client that mirrors them):
 * - positions: openQuantity = current open qty (fractional OK, negative =
 *   short); currentPrice = valuation price; currentMarketValue = openQty ×
 *   price in the POSITION's currency; averageEntryPrice/totalCost = cost
 *   basis. NOTE: positions carry NO currency field — it is resolved per
 *   symbolId via /v1/symbols/{id} (see resolvePositionCurrencies).
 * - balances: perCurrencyBalances[].{cash, marketValue, totalEquity} with
 *   totalEquity = cash + marketValue, per currency. combinedBalances are in
 *   the account's base currency and are NOT used (never mix currencies).
 * - activities: {tradeDate, action, symbol, currency, quantity, price,
 *   grossAmount, commission, netAmount, type}.
 *
 * Money handling: every numeric field is parsed from its JSON string/number
 * form through parseDecimal(), which uses string-based half-up rounding
 * (no float arithmetic) and caps precision at 10 decimals — killing float
 * repr artifacts (0.30000000000000004 → 0.3) while preserving API precision.
 * Rounding to display precision (2dp) happens ONLY at display time.
 */

const LIVE_LOGIN = "https://login.questrade.com";
const PRACTICE_LOGIN = "https://practicelogin.questrade.com";

export class QuestradeError extends Error {
  code: string | null;
  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = "QuestradeError";
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
 * Returns null for missing/empty; throws QuestradeError on malformed input
 * (fail loudly — a bad number must never silently become 0).
 */
export function parseDecimal(value: unknown, field = "value"): number | null {
  if (value === null || value === undefined) return null;
  const s = typeof value === "string" ? value.trim() : String(value);
  if (s === "") return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new QuestradeError(
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
  throw new QuestradeError(`Unexpected ${what}: not an object`);
}

function reqStr(r: Record<string, unknown>, key: string, what: string): string {
  const v = r[key];
  if (typeof v === "string" && v !== "") return v;
  throw new QuestradeError(`Unexpected ${what}: missing string "${key}"`);
}

function optStr(r: Record<string, unknown>, key: string): string | null {
  const v = r[key];
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string") return v;
  throw new QuestradeError(`Unexpected field "${key}": not a string`);
}

function reqNum(r: Record<string, unknown>, key: string, what: string): number {
  const v = parseDecimal(r[key], `${what}.${key}`);
  if (v === null) throw new QuestradeError(`Unexpected ${what}: missing "${key}"`);
  return v;
}

function optNum(r: Record<string, unknown>, key: string, what: string): number | null {
  return parseDecimal(r[key], `${what}.${key}`);
}

/* ---------------- auth ---------------- */

export interface QtCredentials {
  accessToken: string;
  /** ROTATED on every exchange — the caller must persist this, not the old one. */
  refreshToken: string;
  /** Base URL for v1 calls, with trailing slash. */
  apiServer: string;
  expiresIn: number;
}

function tokenError(json: unknown, httpStatus: number): QuestradeError {
  const r = json !== null && typeof json === "object" && !Array.isArray(json)
    ? (json as Record<string, unknown>)
    : null;
  const code = typeof r?.code === "number" ? String(r.code) : null;
  const message = typeof r?.message === "string" ? r.message : "";
  if (httpStatus === 401) {
    return new QuestradeError(
      "Questrade token rejected (401) — generate a new manual authorization token in Questrade → API centre.",
      code,
    );
  }
  return new QuestradeError(
    `Questrade token exchange failed (HTTP ${httpStatus}${code ? `, code ${code}` : ""})${message ? `: ${message}` : ""}`,
    code,
  );
}

/**
 * Exchange a refresh token (or a fresh manual authorization token — the
 * endpoint treats them the same) for an access token. The returned
 * refreshToken is single-use and rotated: persist it immediately.
 */
export async function exchangeRefreshToken(
  refreshToken: string,
  opts: { practice?: boolean } = {},
): Promise<QtCredentials> {
  const host = opts.practice ? PRACTICE_LOGIN : LIVE_LOGIN;
  const url =
    `${host}/oauth2/token?grant_type=refresh_token&refresh_token=` +
    encodeURIComponent(refreshToken);
  let res: Response;
  try {
    res = await fetch(url, { method: "POST" });
  } catch (e) {
    throw new QuestradeError(
      `Questrade token exchange network error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) throw tokenError(json, res.status);
  const r = asRecord(json, "token response");
  const apiServer = reqStr(r, "api_server", "token response").replace(/\/?$/, "/");
  return {
    accessToken: reqStr(r, "access_token", "token response"),
    refreshToken: reqStr(r, "refresh_token", "token response"),
    apiServer,
    expiresIn: reqNum(r, "expires_in", "token response"),
  };
}

/* ---------------- v1 calls ---------------- */

async function v1Get(
  apiServer: string,
  accessToken: string,
  path: string,
): Promise<unknown> {
  const url = `${apiServer}${path.startsWith("/") ? path.slice(1) : path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (e) {
    throw new QuestradeError(
      `Questrade GET ${path} network error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    const json: unknown = await res.json().catch(() => null);
    const r =
      json !== null && typeof json === "object" && !Array.isArray(json)
        ? (json as Record<string, unknown>)
        : null;
    const detail = typeof r?.message === "string" ? `: ${r.message}` : "";
    throw new QuestradeError(`Questrade GET ${path} failed (HTTP ${res.status})${detail}`);
  }
  return (await res.json()) as unknown;
}

function asArray(v: unknown, what: string): Array<Record<string, unknown>> {
  if (!Array.isArray(v)) throw new QuestradeError(`Unexpected ${what}: not an array`);
  return v.map((e) => asRecord(e, what));
}

/* ---------------- accounts ---------------- */

export interface QtAccount {
  /** Questrade account number, e.g. "12345678". */
  number: string;
  type: string;
  status: string;
  isPrimary: boolean;
  isBilling: boolean;
  clientAccountType: string;
}

export function parseAccountsResponse(json: unknown): QtAccount[] {
  const r = asRecord(json, "accounts response");
  return asArray(r.accounts, "accounts").map((a) => ({
    number: reqStr(a, "number", "account"),
    type: optStr(a, "type") ?? "",
    status: optStr(a, "status") ?? "",
    isPrimary: a.isPrimary === true,
    isBilling: a.isBilling === true,
    clientAccountType: optStr(a, "clientAccountType") ?? "",
  }));
}

export async function getAccounts(
  apiServer: string,
  accessToken: string,
): Promise<QtAccount[]> {
  return parseAccountsResponse(await v1Get(apiServer, accessToken, "v1/accounts"));
}

/* ---------------- positions ---------------- */

export interface QtPosition {
  accountNumber: string;
  symbol: string;
  symbolId: number;
  /** Current open quantity. Fractional OK; negative = short. */
  openQuantity: number;
  /** Valuation price used for currentMarketValue. */
  currentPrice: number | null;
  /** openQuantity × currentPrice, in the position's native currency. */
  currentMarketValue: number;
  averageEntryPrice: number | null;
  totalCost: number | null;
  openPnl: number | null;
  dayPnl: number | null;
  /** Resolved via /v1/symbols/{id}; null when the lookup failed. */
  currency: string | null;
  /** "STK" | "OPT" (from optionExpiryDate); resolved with currency. */
  assetCategory: string;
}

export function parsePositionsResponse(
  json: unknown,
  accountNumber: string,
): Omit<QtPosition, "currency" | "assetCategory">[] {
  const r = asRecord(json, "positions response");
  return asArray(r.positions, "positions").map((p) => {
    const symbolIdRaw: unknown = p.symbolId;
    if (typeof symbolIdRaw !== "number" || !Number.isInteger(symbolIdRaw)) {
      throw new QuestradeError(`Unexpected position: bad symbolId`);
    }
    return {
      accountNumber,
      symbol: reqStr(p, "symbol", "position"),
      symbolId: symbolIdRaw,
      openQuantity: reqNum(p, "openQuantity", "position"),
      currentPrice: optNum(p, "currentPrice", "position"),
      currentMarketValue: reqNum(p, "currentMarketValue", "position"),
      averageEntryPrice: optNum(p, "averageEntryPrice", "position"),
      totalCost: optNum(p, "totalCost", "position"),
      openPnl: optNum(p, "openPnl", "position"),
      dayPnl: optNum(p, "dayPnl", "position"),
    };
  });
}

export async function getPositions(
  apiServer: string,
  accessToken: string,
  accountNumber: string,
): Promise<Omit<QtPosition, "currency" | "assetCategory">[]> {
  return parsePositionsResponse(
    await v1Get(apiServer, accessToken, `v1/accounts/${encodeURIComponent(accountNumber)}/positions`),
    accountNumber,
  );
}

/**
 * Positions carry no currency — resolve it per symbolId via
 * GET /v1/symbols/{id} (response includes `currency` and
 * `optionExpiryDate`). Dedupes ids and runs the lookups in parallel.
 * Failures resolve to null currency (surfaced in reconciliation) rather
 * than failing the whole sync.
 */
export async function resolvePositionCurrencies(
  apiServer: string,
  accessToken: string,
  symbolIds: number[],
): Promise<Map<number, { currency: string | null; assetCategory: string }>> {
  const out = new Map<number, { currency: string | null; assetCategory: string }>();
  const unique = [...new Set(symbolIds)];
  await Promise.all(
    unique.map(async (id) => {
      try {
        const json = await v1Get(apiServer, accessToken, `v1/symbols/${id}`);
        const r = asRecord(json, "symbol response");
        const syms = asArray(r.symbols, "symbols");
        const s = syms[0];
        if (!s) {
          out.set(id, { currency: null, assetCategory: "STK" });
          return;
        }
        const currency = optStr(s, "currency");
        const isOption = optStr(s, "optionExpiryDate") !== null;
        out.set(id, {
          currency: currency ? currency.toUpperCase() : null,
          assetCategory: isOption ? "OPT" : "STK",
        });
      } catch {
        out.set(id, { currency: null, assetCategory: "STK" });
      }
    }),
  );
  return out;
}

/* ---------------- balances ---------------- */

export interface QtBalance {
  currency: string;
  cash: number;
  /** Securities market value in this currency (Questrade-computed). */
  marketValue: number;
  /** cash + marketValue, per currency. */
  totalEquity: number;
  buyingPower: number | null;
}

export function parseBalancesResponse(json: unknown): QtBalance[] {
  const r = asRecord(json, "balances response");
  return asArray(r.perCurrencyBalances, "perCurrencyBalances").map((b) => ({
    currency: reqStr(b, "currency", "balance").toUpperCase(),
    cash: reqNum(b, "cash", "balance"),
    marketValue: reqNum(b, "marketValue", "balance"),
    totalEquity: reqNum(b, "totalEquity", "balance"),
    buyingPower: optNum(b, "buyingPower", "balance"),
  }));
}

export async function getBalances(
  apiServer: string,
  accessToken: string,
  accountNumber: string,
): Promise<QtBalance[]> {
  return parseBalancesResponse(
    await v1Get(apiServer, accessToken, `v1/accounts/${encodeURIComponent(accountNumber)}/balances`),
  );
}

/* ---------------- activities ---------------- */

export interface QtActivity {
  tradeDate: string; // ISO datetime from Questrade
  transactionDate: string | null;
  settlementDate: string | null;
  action: string;
  symbol: string;
  symbolId: number | null;
  description: string | null;
  currency: string;
  quantity: number;
  price: number | null;
  grossAmount: number | null;
  commission: number | null;
  netAmount: number | null;
  type: string;
}

export function parseActivitiesResponse(json: unknown): QtActivity[] {
  const r = asRecord(json, "activities response");
  return asArray(r.activities, "activities").map((a) => {
    const symbolIdRaw = a.symbolId;
    return {
      tradeDate: reqStr(a, "tradeDate", "activity"),
      transactionDate: optStr(a, "transactionDate"),
      settlementDate: optStr(a, "settlementDate"),
      action: optStr(a, "action") ?? "",
      symbol: optStr(a, "symbol") ?? "",
      symbolId:
        typeof symbolIdRaw === "number" && Number.isInteger(symbolIdRaw)
          ? symbolIdRaw
          : null,
      description: optStr(a, "description"),
      currency: (optStr(a, "currency") ?? "CAD").toUpperCase(),
      quantity: reqNum(a, "quantity", "activity"),
      price: optNum(a, "price", "activity"),
      grossAmount: optNum(a, "grossAmount", "activity"),
      commission: optNum(a, "commission", "activity"),
      netAmount: optNum(a, "netAmount", "activity"),
      type: optStr(a, "type") ?? "",
    };
  });
}

export async function getActivities(
  apiServer: string,
  accessToken: string,
  accountNumber: string,
  startTime: Date,
  endTime: Date,
): Promise<QtActivity[]> {
  const q =
    `startTime=${encodeURIComponent(startTime.toISOString())}` +
    `&endTime=${encodeURIComponent(endTime.toISOString())}`;
  return parseActivitiesResponse(
    await v1Get(
      apiServer,
      accessToken,
      `v1/accounts/${encodeURIComponent(accountNumber)}/activities?${q}`,
    ),
  );
}

/** Questrade ISO datetime → YYYYMMDD (the BrokerTrade.tradeDate convention). */
export function toYmd(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) throw new QuestradeError(`Bad activity date: ${iso.slice(0, 40)}`);
  return `${m[1]}${m[2]}${m[3]}`;
}

export interface QtTradeLike {
  accountNumber: string;
  symbol: string;
  tradeDate: string; // YYYYMMDD
  /** Signed: buys positive, sells negative. */
  quantity: number;
  tradePrice: number | null;
  commission: number | null;
  currency: string;
  action: string;
}

const TRADE_TYPES = new Set(["trades"]);

/**
 * Map a "Trades" activity to a signed trade. Questrade reports quantity
 * unsigned with the direction in `action`; we sign it (Buy → +, Sell → −)
 * so P/L and net-quantity math stays honest.
 */
export function activityToTrade(a: QtActivity, accountNumber: string): QtTradeLike | null {
  if (!TRADE_TYPES.has(a.type.toLowerCase()) || a.symbol === "") return null;
  const action = a.action.toLowerCase();
  const isSell = action.includes("sell");
  const isBuy = action.includes("buy");
  const quantity = isSell && !isBuy ? -a.quantity : a.quantity;
  return {
    accountNumber,
    symbol: a.symbol,
    tradeDate: toYmd(a.tradeDate),
    quantity,
    tradePrice: a.price,
    commission: a.commission,
    currency: a.currency,
    action: a.action,
  };
}

export interface QtCashFlowLike {
  accountNumber: string;
  type: string;
  symbol: string | null;
  dateTime: string; // ISO
  amount: number; // signed netAmount
  currency: string;
  description: string | null;
}

/** Activity types that are cash movements, not trades. */
const CASH_TYPES = new Set([
  "dividends",
  "deposits",
  "withdrawals",
  "transfers",
  "corporate actions",
  "fees",
  "interest",
  "margin interest",
  "fx conversions",
  "others",
]);

export function activityToCashFlow(
  a: QtActivity,
  accountNumber: string,
): QtCashFlowLike | null {
  if (!CASH_TYPES.has(a.type.toLowerCase())) return null;
  if (a.netAmount === null) return null;
  return {
    accountNumber,
    type: a.type,
    symbol: a.symbol === "" ? null : a.symbol,
    dateTime: a.tradeDate,
    amount: a.netAmount,
    currency: a.currency,
    description: a.description,
  };
}

/* ---------------- reconciliation ---------------- */

export interface ReconciliationIssue {
  accountNumber: string;
  currency: string;
  kind: "positions-vs-balances" | "balances-internal" | "unresolved-currency";
  /** What we computed / expected. */
  expected: number;
  /** What Questrade reported. */
  actual: number;
  diff: number;
  message: string;
}

/**
 * Reconcile one account, per currency — NEVER across currencies.
 * Checks:
 *  1. Σ positions' currentMarketValue == balances.marketValue (validates
 *     our parsing AND the per-symbol currency resolution).
 *  2. cash + marketValue == totalEquity (Questrade's own internal
 *     consistency — should always hold; a breach means bad data).
 * Positions whose currency couldn't be resolved are reported, not silently
 * dropped into a total.
 *
 * eps: tolerance in the position's currency. Questrade rounds to cents, so
 * n positions can drift up to ~n×$0.005 from their internal sum; 0.25
 * tolerates large accounts while still catching real errors (a missing
 * position or a currency mixup is dollars, not cents).
 */
export function reconcileAccount(
  accountNumber: string,
  positions: QtPosition[],
  balances: QtBalance[],
  eps = 0.25,
): ReconciliationIssue[] {
  const issues: ReconciliationIssue[] = [];

  const byCurrency = new Map<string, number>();
  const unresolved: string[] = [];
  for (const p of positions) {
    if (!p.currency) {
      unresolved.push(p.symbol);
      continue;
    }
    byCurrency.set(p.currency, (byCurrency.get(p.currency) ?? 0) + p.currentMarketValue);
  }
  if (unresolved.length > 0) {
    issues.push({
      accountNumber,
      currency: "?",
      kind: "unresolved-currency",
      expected: unresolved.length,
      actual: 0,
      diff: unresolved.length,
      message: `${unresolved.length} position(s) with unknown currency excluded from totals: ${unresolved.slice(0, 5).join(", ")}${unresolved.length > 5 ? "…" : ""}`,
    });
  }

  const balByCurrency = new Map(balances.map((b) => [b.currency, b]));
  for (const [currency, posValue] of byCurrency) {
    const bal = balByCurrency.get(currency);
    if (!bal) {
      issues.push({
        accountNumber,
        currency,
        kind: "positions-vs-balances",
        expected: posValue,
        actual: 0,
        diff: posValue,
        message: `Positions total ${posValue.toFixed(2)} ${currency} but Questrade reports no ${currency} balance bucket`,
      });
      continue;
    }
    const diff = Math.abs(posValue - bal.marketValue);
    if (diff > eps) {
      issues.push({
        accountNumber,
        currency,
        kind: "positions-vs-balances",
        expected: posValue,
        actual: bal.marketValue,
        diff,
        message:
          `Positions sum ${posValue.toFixed(2)} ≠ reported market value ` +
          `${bal.marketValue.toFixed(2)} ${currency} (diff ${diff.toFixed(2)})`,
      });
    }
    const internalDiff = Math.abs(bal.cash + bal.marketValue - bal.totalEquity);
    if (internalDiff > eps) {
      issues.push({
        accountNumber,
        currency,
        kind: "balances-internal",
        expected: bal.cash + bal.marketValue,
        actual: bal.totalEquity,
        diff: internalDiff,
        message:
          `cash ${bal.cash.toFixed(2)} + market value ${bal.marketValue.toFixed(2)} ≠ ` +
          `total equity ${bal.totalEquity.toFixed(2)} ${currency} (diff ${internalDiff.toFixed(2)})`,
      });
    }
  }
  return issues;
}
