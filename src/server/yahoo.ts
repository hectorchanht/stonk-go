/**
 * Yahoo Finance v8 chart API — historical daily bars.
 *
 * Pure module (no `server-only` import) so the response parsing stays
 * unit-testable in node. One request per symbol covers the whole range;
 * results are cached in-memory for 24h (best-effort per worker isolate).
 */

import { isHkCode } from "~/server/currency";

export interface DailyBar {
  /** UTC calendar date, YYYY-MM-DD (the trading day). */
  date: string;
  close: number;
  /** Split/dividend-adjusted close; null when Yahoo omits it. */
  adjclose: number | null;
}

/** Yahoo ticker for a symbol — HKEX numeric codes need the .HK suffix. */
export function yahooTicker(symbol: string): string {
  return isHkCode(symbol) ? `${symbol.trim()}.HK` : symbol;
}

/**
 * Parse a Yahoo v8 chart response into daily bars. Pure — unit-tested with
 * fixtures. Bars use the UTC calendar date of each timestamp (the trading
 * day); malformed entries are dropped.
 */
interface YahooChartPayload {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{ close?: Array<number | null> }>;
        adjclose?: Array<{ adjclose?: Array<number | null> }>;
      };
    }>;
  };
}

export function parseChartBars(json: unknown): DailyBar[] {
  const j = json as YahooChartPayload;
  const r = j?.chart?.result?.[0];
  const ts = r?.timestamp && Array.isArray(r.timestamp) ? r.timestamp : [];
  const closes = r?.indicators?.quote?.[0]?.close;
  const cs: Array<number | null> = Array.isArray(closes) ? closes : [];
  const adjs = r?.indicators?.adjclose?.[0]?.adjclose;
  const as: Array<number | null> = Array.isArray(adjs) ? adjs : [];
  const seen = new Map<string, DailyBar>();
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    const c = cs[i];
    if (typeof t !== "number" || !Number.isFinite(t)) continue;
    if (typeof c !== "number" || !Number.isFinite(c)) continue;
    const a = as[i];
    const iso = new Date(t * 1000).toISOString().slice(0, 10);
    // Same UTC day appearing twice (overlapping ranges): keep the last.
    seen.set(iso, {
      date: iso,
      close: c,
      adjclose: typeof a === "number" && Number.isFinite(a) ? a : null,
    });
  }
  return [...seen.values()];
}

const CLOSE_CACHE_TTL_MS = 24 * 3600_000; // daily bars refresh once a day
const closesCache = new Map<string, { at: number; bars: DailyBar[] }>();

/**
 * Daily bars for a symbol over [period1, period2) via Yahoo's chart API.
 * FX pairs like "HKD=X" pass through untouched. One request covers the
 * whole range. Throws on HTTP/network failure — callers fall back to older
 * curve sources rather than rendering a broken chart.
 */
export async function getDailyCloses(
  symbol: string,
  period1: Date,
  period2: Date,
): Promise<DailyBar[]> {
  const ticker = yahooTicker(symbol);
  const p1 = Math.floor(period1.getTime() / 1000);
  const p2 = Math.floor(period2.getTime() / 1000);
  const key = `${ticker}:${p1}:${p2}`;
  const hit = closesCache.get(key);
  if (hit && Date.now() - hit.at < CLOSE_CACHE_TTL_MS) return hit.bars;

  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      ticker,
    )}?period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplits`,
    {
      headers: { "User-Agent": "Mozilla/5.0 (Holdr portfolio)" },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) throw new Error(`Yahoo chart ${ticker}: HTTP ${res.status}`);
  const bars = parseChartBars(await res.json());
  closesCache.set(key, { at: Date.now(), bars });
  return bars;
}
