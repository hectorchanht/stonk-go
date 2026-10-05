import "server-only";

/**
 * Free, no-API-key quote source for the portfolio.
 *
 * Primary: Yahoo Finance v8 chart endpoint (public, no key). Pulling a few
 * daily bars gives us both the latest price and the previous close, which is
 * what powers the day P/L column.
 *
 * Fallback: Stooq's free CSV endpoint (e.g. https://stooq.com/q/l/?s=aapl.us
 * &f=sd2t2ohlcv&h&e=csv) — close price only, no day change.
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
  source: "yahoo" | "stooq" | "unavailable";
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
  try {
    quote = await fetchYahoo(symbol);
  } catch {
    quote = null;
  }
  if (!quote) {
    try {
      quote = await fetchStooq(symbol);
    } catch {
      quote = null;
    }
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
