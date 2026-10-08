/**
 * Interactive Brokers Flex Web Service client (read-only).
 *
 * IBKR's Flex Web Service is a token-based reporting API: you define a
 * "Flex Query" once in Client Portal (which sections/fields you want), then
 * fetch it over HTTPS — no IB Gateway, no TWS, no 2FA per request, which is
 * what makes it usable from a Cloudflare Worker.
 *
 * Flow:
 *   1. SendRequest?t={token}&q={queryId}&v=3  -> <ReferenceCode>
 *   2. GetStatement?t={token}&q={referenceCode}&v=3 -> the report XML
 *      (the report generates async; error 1019 means "try again shortly")
 *
 * A query's saved period caps at 365 days in the portal, and IBKR's own
 * docs cap the fd/td (yyyymmdd) SendRequest overrides at 365 days too —
 * there is no way to pull more than a year of trades per request, so the
 * sync uses the query's saved period as-is. (A 2010→today override was
 * tried 2026-10-06: IBKR answers every such request with 1018 rate-limit,
 * so it was reverted.) The trade merge is idempotent, so re-syncs are safe.
 *
 * Positions are end-of-day (activity data refreshes once daily at close).
 * This is reporting only — it cannot trade.
 */

const FLEX_BASE = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";

export interface FlexPosition {
  accountId: string;
  symbol: string;
  description: string | null;
  assetCategory: string;
  currency: string;
  quantity: number;
  markPrice: number | null;
  /** Per-share cost basis — only present when the Flex Query includes the
   *  "Cost Basis Price" column in the Open Positions section. */
  costBasisPrice: number | null;
}

export interface FlexTrade {
  accountId: string;
  symbol: string;
  description: string | null;
  assetCategory: string;
  currency: string;
  tradeDate: string; // YYYYMMDD as IBKR reports it
  quantity: number;
  tradePrice: number | null;
  proceeds: number | null;
  commission: number | null;
  realizedPnl: number | null;
  openClose: string | null; // "O" | "C" | ...
  transactionType: string | null;
  /** IBKR's per-execution id — the stable key for idempotent imports. */
  transactionId: string | null;
}

export interface FlexCashFlow {
  accountId: string;
  symbol: string | null;
  description: string | null;
  currency: string;
  dateTime: string;
  amount: number;
  type: string; // "Dividends" | "Withholding Tax" | "Deposits" | ...
}

export interface FlexResult {
  positions: FlexPosition[];
  trades: FlexTrade[];
  cashFlows: FlexCashFlow[];
  /** When IBKR generated the statement, if the XML says. */
  generatedAt: string | null;
}

export class FlexError extends Error {
  code: string | null;
  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = "FlexError";
    this.code = code;
  }
}

const ERROR_HINTS: Record<string, string> = {
  "1012": "Token invalid — check IBKR_FLEX_TOKEN.",
  "1014": "Query ID invalid — check IBKR_FLEX_QUERY_ID (Reports > Flex Queries).",
  "1015": "Token expired — generate a new one in Client Portal (Settings > Reporting > Flex Web Service).",
  "1018":
    "Rate limited by IBKR — wait at least 10 minutes before retrying. Rapid retries can extend the lockout.",
  "1020": "Malformed request — report this as a bug.",
  "1025":
    "Too many failed attempts — IBKR temporarily blocked this token. Check the token (Client Portal > Settings > Reporting > Flex Web Service) and Query ID (Reports > Flex Queries), save fresh credentials, then wait ~1h before re-syncing.",
};

function flexErrorMessage(code: string, detail: string): string {
  const hint = ERROR_HINTS[code];
  // Upstream detail capped at 200 chars — same honest-error UI pattern as the
  // Binance card. Only IBKR's own code/text: never tokens or request URLs.
  return hint ? `IBKR Flex error ${code}: ${hint}` : `IBKR Flex error ${code}: ${detail.slice(0, 200) || "unknown"}`;
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) out[m[1]!] = m[2]!;
  return out;
}

function num(v: string | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a Flex statement XML string into positions, trades and cash flows.
 * Pure function — unit-testable without network. Sections the Flex Query
 * doesn't include simply come back empty.
 */
export function parseFlexPositions(xml: string): FlexResult {
  const genMatch = /<FlexStatement[^>]*whenGenerated="([^"]*)"/.exec(xml);
  const generatedAt = genMatch?.[1] ?? null;

  const positions: FlexPosition[] = [];
  const posSection = /<OpenPositions>([\s\S]*?)<\/OpenPositions>/.exec(xml);
  if (posSection?.[1]) {
    const re = /<OpenPosition\b([^>]*?)\/>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(posSection[1])) !== null) {
      const a = attrs(m[1]!);
      const quantity = num(a.position);
      if (!a.symbol || quantity == null) continue;
      positions.push({
        accountId: a.accountId ?? "",
        symbol: a.symbol,
        description: a.description ?? null,
        assetCategory: a.assetCategory ?? "",
        currency: a.currency ?? "",
        quantity,
        markPrice: num(a.markPrice),
        costBasisPrice: num(a.costBasisPrice),
      });
    }
  }

  const trades: FlexTrade[] = [];
  const tradeSection = /<Trades>([\s\S]*?)<\/Trades>/.exec(xml);
  if (tradeSection?.[1]) {
    const re = /<Trade\b([^>]*?)\/>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tradeSection[1])) !== null) {
      const a = attrs(m[1]!);
      const quantity = num(a.quantity);
      if (!a.symbol || quantity == null) continue;
      trades.push({
        accountId: a.accountId ?? "",
        symbol: a.symbol,
        description: a.description ?? null,
        assetCategory: a.assetCategory ?? "",
        currency: a.currency ?? "",
        tradeDate: a.tradeDate ?? "",
        quantity,
        tradePrice: num(a.tradePrice),
        proceeds: num(a.proceeds),
        commission: num(a.commission),
        realizedPnl: num(a.fifoPnlRealized),
        openClose: a.openCloseIndicator ?? null,
        transactionType: a.transactionType ?? null,
        transactionId: a.transactionID ?? null,
      });
    }
  }

  const cashFlows: FlexCashFlow[] = [];
  const cashSection = /<CashTransactions>([\s\S]*?)<\/CashTransactions>/.exec(xml);
  if (cashSection?.[1]) {
    const re = /<CashTransaction\b([^>]*?)\/>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cashSection[1])) !== null) {
      const a = attrs(m[1]!);
      const amount = num(a.amount);
      if (amount == null || !a.type) continue;
      cashFlows.push({
        accountId: a.accountId ?? "",
        symbol: a.symbol ?? null,
        description: a.description ?? null,
        currency: a.currency ?? "",
        dateTime: a.dateTime ?? "",
        amount,
        type: a.type,
      });
    }
  }

  return { positions, trades, cashFlows, generatedAt };
}

interface FlexResponseMeta {
  status: string | null;
  code: string | null;
  message: string | null;
  referenceCode: string | null;
}

function parseResponseMeta(xml: string): FlexResponseMeta {
  const pick = (tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1] ?? null;
  return {
    status: pick("Status"),
    code: pick("ErrorCode"),
    message: pick("ErrorMessage"),
    referenceCode: pick("ReferenceCode"),
  };
}

const FLEX_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function flexFetch(url: string): Promise<Response> {
  return fetch(url, {
    headers: {
      "User-Agent": FLEX_UA,
      Accept: "text/xml,application/xml,*/*",
    },
  });
}

async function sendRequest(token: string, queryId: string): Promise<string> {
  const url = `${FLEX_BASE}/SendRequest?t=${encodeURIComponent(token)}&q=${encodeURIComponent(queryId)}&v=3`;
  const res = await flexFetch(url);
  if (!res.ok) throw new FlexError(`IBKR SendRequest HTTP ${res.status}`);
  const meta = parseResponseMeta(await res.text());
  if (meta.status === "Success" && meta.referenceCode) return meta.referenceCode;
  throw new FlexError(flexErrorMessage(meta.code ?? "?", meta.message ?? ""), meta.code);
}

async function getStatement(token: string, referenceCode: string): Promise<string> {
  const url = `${FLEX_BASE}/GetStatement?t=${encodeURIComponent(token)}&q=${encodeURIComponent(referenceCode)}&v=3`;
  const res = await flexFetch(url);
  if (!res.ok) throw new FlexError(`IBKR GetStatement HTTP ${res.status}`);
  return await res.text();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll GetStatement until the report is ready (1019 = still generating). */
async function pollStatement(
  token: string,
  referenceCode: string,
  opts: { maxAttempts?: number; pollMs?: number } = {},
): Promise<FlexResult> {
  const maxAttempts = opts.maxAttempts ?? 10;
  const pollMs = opts.pollMs ?? 5000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const body = await getStatement(token, referenceCode);
    // A ready statement is raw Flex XML; a not-ready one is a
    // FlexStatementResponse envelope with an error code.
    if (body.includes("<FlexStatementResponse")) {
      const meta = parseResponseMeta(body);
      if (meta.code === "1019") {
        if (attempt < maxAttempts) {
          await sleep(pollMs);
          continue;
        }
        throw new FlexError("IBKR took too long to generate the report — try again in a minute.", "1019");
      }
      throw new FlexError(flexErrorMessage(meta.code ?? "?", meta.message ?? ""), meta.code);
    }
    return parseFlexPositions(body);
  }
  throw new FlexError("IBKR took too long to generate the report — try again in a minute.", "1019");
}

/**
 * Fetch open positions from IBKR via Flex Web Service.
 * Polls while the report is generating (1019), up to ~50s.
 */
export async function fetchFlexPositions(
  token: string,
  queryId: string,
  opts: { maxAttempts?: number; pollMs?: number } = {},
): Promise<FlexResult> {
  const referenceCode = await sendRequest(token, queryId);
  return pollStatement(token, referenceCode, opts);
}

/**
 * Fetch one explicit date window via the fd/td overrides.
 * IBKR caps the override range at 365 days — wider ranges get 1018, so
 * callers must chunk. Used by the history backfill, one window per sync.
 */
export async function fetchFlexWindow(
  token: string,
  queryId: string,
  fd: string,
  td: string,
  opts: { maxAttempts?: number; pollMs?: number } = {},
): Promise<FlexResult> {
  if (!/^\d{8}$/.test(fd) || !/^\d{8}$/.test(td) || td < fd) {
    throw new Error(`fetchFlexWindow: invalid window fd=${fd} td=${td}`);
  }
  // yyyymmdd strings compare lexicographically; cap the span at 365 days.
  const days =
    (Date.UTC(+td.slice(0, 4), +td.slice(4, 6) - 1, +td.slice(6, 8)) -
      Date.UTC(+fd.slice(0, 4), +fd.slice(4, 6) - 1, +fd.slice(6, 8))) /
    86400000;
  if (days > 365) {
    throw new Error(`fetchFlexWindow: window ${fd}..${td} exceeds IBKR's 365-day override cap`);
  }
  const url =
    `${FLEX_BASE}/SendRequest?t=${encodeURIComponent(token)}` +
    `&q=${encodeURIComponent(queryId)}&v=3&fd=${fd}&td=${td}`;
  const res = await flexFetch(url);
  if (!res.ok) throw new FlexError(`IBKR SendRequest HTTP ${res.status}`);
  const meta = parseResponseMeta(await res.text());
  if (meta.status !== "Success" || !meta.referenceCode) {
    throw new FlexError(flexErrorMessage(meta.code ?? "?", meta.message ?? ""), meta.code);
  }
  return pollStatement(token, meta.referenceCode, opts);
}
