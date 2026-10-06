import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Quote sources for the portfolio.
 *
 * 1. Finnhub (https://finnhub.io/api/v1/quote) — real-time US quotes on the
 *    free tier (60 calls/min). Used first when FINNHUB_API_KEY is set.
 * 2. Yahoo Finance v8 chart endpoint (public, no key, ~15min delayed).
 *    Pulling a few daily bars gives both the latest price and the previous
 *    close, which powers the day P/L column.
 * 3. Stooq's free CSV endpoint — close price only, no day change.
 *
 * Results are cached in-memory for 60s so a dashboard with N holdings does
 * not hammer the providers on every poll.
 */

export interface Quote {
  symbol: string;
  name: string | null;
  price: number | null;
  prevClose: number | null;
  dayChangePct: number | null;
  currency: string | null;
  fetchedAt: string; // ISO timestamp
  source: "finnhub" | "yahoo" | "stooq" | "unavailable";
}

const CACHE_TTL_MS = 60_000;
const quoteCache = new Map<string, { at: number; quote: Quote }>();

function emptyQuote(symbol: string): Quote {
  return {
    symbol,
    name: null,
    price: null,
    prevClose: null,
    dayChangePct: null,
    currency: null,
    fetchedAt: new Date().toISOString(),
    source: "unavailable",
  };
}

/** Finnhub API key when configured (worker env first, then process.env). */
function getFinnhubKey(): string | null {
  let key: unknown;
  try {
    // On Cloudflare Workers, dashboard secrets live on the worker env.
    key = getCloudflareContext().env.FINNHUB_API_KEY;
  } catch {
    // Not in a worker request scope — local dev falls through to process.env.
  }
  key ??= process.env.FINNHUB_API_KEY;
  return typeof key === "string" && key.length > 0 ? key : null;
}

async function fetchFinnhub(
  symbol: string,
  apiKey: string
): Promise<Quote | null> {
  const params = new URLSearchParams({ symbol, token: apiKey });
  const res = await fetch(`https://finnhub.io/api/v1/quote?${params}`, {
    headers: { "User-Agent": "Mozilla/5.0 (stonk-go portfolio)" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;

  // { c: current, d: change, dp: pct change, h/l/o: day high/low/open,
  //   pc: previous close, t: unix timestamp }
  const j = (await res.json()) as {
    c?: unknown;
    pc?: unknown;
    dp?: unknown;
  };
  const price =
    typeof j.c === "number" && Number.isFinite(j.c) && j.c > 0 ? j.c : null;
  if (price == null) return null;
  const prevClose =
    typeof j.pc === "number" && Number.isFinite(j.pc) && j.pc > 0
      ? j.pc
      : null;
  const dp =
    typeof j.dp === "number" && Number.isFinite(j.dp) ? j.dp : null;

  return {
    symbol: symbol.toUpperCase(),
    // The quote endpoint carries no company name; Yahoo backfills it when
    // it runs (or leave null — the UI tolerates it).
    name: null,
    price,
    prevClose,
    dayChangePct:
      dp ?? (prevClose ? ((price - prevClose) / prevClose) * 100 : null),
    currency: null,
    fetchedAt: new Date().toISOString(),
    source: "finnhub",
  };
}

async function fetchYahoo(symbol: string): Promise<Quote | null> {
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}?interval=1d&range=5d`,
    {
      headers: { "User-Agent": "Mozilla/5.0 (stonk-go portfolio)" },
      signal: AbortSignal.timeout(10_000),
    }
  );
  if (!res.ok) return null;

  const json = (await res.json()) as {
    chart?: {
      result?: Array<{
        meta?: {
          symbol?: string;
          longName?: string;
          shortName?: string;
          currency?: string;
          regularMarketPrice?: number;
        };
        indicators?: {
          quote?: Array<{ close?: Array<number | null> }>;
        };
      }>;
    };
  };
  const result = json.chart?.result?.[0];
  if (!result) return null;

  const closes = (result.indicators?.quote?.[0]?.close ?? []).filter(
    (c): c is number => typeof c === "number" && Number.isFinite(c)
  );
  if (closes.length === 0) return null;

  const price = closes[closes.length - 1]!;
  const prevClose = closes.length > 1 ? closes[closes.length - 2]! : null;

  return {
    symbol: result.meta?.symbol ?? symbol.toUpperCase(),
    name: result.meta?.longName ?? result.meta?.shortName ?? null,
    price,
    prevClose,
    dayChangePct:
      prevClose && prevClose !== 0
        ? ((price - prevClose) / prevClose) * 100
        : null,
    currency: result.meta?.currency ?? null,
    fetchedAt: new Date().toISOString(),
    source: "yahoo",
  };
}

async function fetchStooq(symbol: string): Promise<Quote | null> {
  // Stooq expects exchange-suffixed tickers for US equities, e.g. aapl.us
  const stooqSymbol = symbol.includes(".")
    ? symbol.toLowerCase()
    : `${symbol.toLowerCase()}.us`;
  const res = await fetch(
    `https://stooq.com/q/l/?s=${encodeURIComponent(
      stooqSymbol
    )}&f=sd2t2ohlcv&h&e=csv`,
    {
      headers: { "User-Agent": "Mozilla/5.0 (stonk-go portfolio)" },
      signal: AbortSignal.timeout(10_000),
    }
  );
  if (!res.ok) return null;

  const text = await res.text();
  const lines = text.trim().split("\n");
  if (lines.length < 2) return null;
  const cols = lines[1]!.split(",");
  // header: Symbol,Date,Time,Open,High,Low,Close,Volume
  const close = Number(cols[6]);
  if (!Number.isFinite(close) || close <= 0) return null;

  return {
    symbol: symbol.toUpperCase(),
    name: null,
    price: close,
    prevClose: null,
    dayChangePct: null,
    currency: null,
    fetchedAt: new Date().toISOString(),
    source: "stooq",
  };
}

/** Fetch a quote with a 60s in-memory cache. Never throws. */
export async function getQuote(rawSymbol: string): Promise<Quote> {
  const symbol = rawSymbol.trim().toUpperCase();
  const cached = quoteCache.get(symbol);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.quote;

  let quote: Quote | null = null;
  const finnhubKey = getFinnhubKey();
  const providers: Array<() => Promise<Quote | null>> = [];
  if (finnhubKey) providers.push(() => fetchFinnhub(symbol, finnhubKey));
  providers.push(() => fetchYahoo(symbol), () => fetchStooq(symbol));

  for (const provide of providers) {
    try {
      quote = await provide();
    } catch {
      quote = null;
    }
    if (quote) break;
  }

  const finalQuote = quote ?? emptyQuote(symbol);
  quoteCache.set(symbol, { at: Date.now(), quote: finalQuote });
  return finalQuote;
}

/** Fetch quotes for many symbols in parallel. Never throws. */
export async function getQuotes(symbols: string[]): Promise<Quote[]> {
  const unique = [...new Set(symbols.map((s) => s.trim().toUpperCase()))];
  return Promise.all(unique.map((s) => getQuote(s)));
}
