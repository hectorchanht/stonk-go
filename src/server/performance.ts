/**
 * Pure performance-curve helpers — no server dependencies, safe to import
 * anywhere including tests and client components.
 */

import { inferCurrency } from "~/server/currency";

/** A dated cash flow in USD. Negative = money in (buy), positive = money out. */
export interface CashFlow {
  date: Date;
  amount: number;
}

export interface CurvePoint {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  /** USD value on that date. */
  value: number;
  /**
   * Net USD invested up to this date — present on true-curve points so the
   * client can derive the return-on-invested % series.
   */
  invested?: number;
}

const DAY_MS = 86_400_000;
const MAX_POINTS = 180;

const isoDay = (d: Date): string => d.toLocaleDateString("en-CA");

const startOfDay = (d: Date): Date => {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
};

/** Thin a point list to at most maxPoints, always keeping the last point. */
export function downsamplePoints<T>(points: T[], maxPoints = MAX_POINTS): T[] {
  if (points.length <= maxPoints) return points;
  const stride = Math.ceil(points.length / maxPoints);
  const slim = points.filter((_, i) => i % stride === 0);
  const last = points[points.length - 1]!;
  if (slim[slim.length - 1] !== last) slim.push(last);
  return slim;
}

/**
 * Daily "money over time" series from the trade log — the curve the
 * Performance section falls back to when daily snapshots don't exist yet.
 *
 * value(day) = net USD invested up to that day (cumulative buys minus
 * sells). The final point is replaced with today's live portfolio value, so
 * the last segment shows the true gain/loss since the money went in.
 *
 * Returns [] when there are no flows. Downsampled to MAX_POINTS so a
 * multi-year log stays cheap to render.
 */
export function buildInvestedCurve(
  flows: CashFlow[],
  currentValueUsd: number,
  opts?: { startDaysAgo?: number; maxPoints?: number },
): CurvePoint[] {
  const fs = flows
    .filter((f) => Number.isFinite(f.amount) && f.amount !== 0)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  if (fs.length === 0) return [];

  const today = new Date();
  let start = startOfDay(fs[0]!.date);
  if (opts?.startDaysAgo != null && opts.startDaysAgo > 0) {
    const cutoff = startOfDay(new Date(Date.now() - opts.startDaysAgo * DAY_MS));
    if (cutoff.getTime() > start.getTime()) start = cutoff;
  }

  // Walk local calendar days from start to today (DST-safe: dedupe the
  // ISO labels in case a 23h/25h day repeats or skips one).
  const days: string[] = [];
  const seen = new Set<string>();
  let t = start.getTime();
  const endT = startOfDay(today).getTime();
  let guard = 0;
  while (t <= endT && guard++ < 5000) {
    const iso = isoDay(new Date(t));
    if (!seen.has(iso)) {
      seen.add(iso);
      days.push(iso);
    }
    t += DAY_MS;
  }

  // Sweep the sorted flows once; flows dated before the window still count
  // toward the invested figure on the first visible day.
  const points: CurvePoint[] = [];
  let fi = 0;
  let invested = 0;
  for (const iso of days) {
    while (fi < fs.length && isoDay(fs[fi]!.date) <= iso) {
      invested -= fs[fi]!.amount; // buys are negative amounts → invested grows
      fi++;
    }
    points.push({ date: iso, value: invested });
  }
  // Endpoint: today's live value replaces the invested figure.
  if (points.length > 0) points[points.length - 1]!.value = currentValueUsd;

  return downsamplePoints(points, opts?.maxPoints ?? MAX_POINTS);
}

/* ---------------- True historical value curve ---------------- */

/** UTC calendar day, YYYY-MM-DD. */
export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

export interface TradeLeg {
  symbol: string;
  type: string;
  quantity: number;
  price: number;
  fees: number | null;
  executedAt: Date | string;
}

export interface DailyHolding {
  /** UTC calendar date, YYYY-MM-DD. */
  date: string;
  /** Uppercase symbol → shares held at end of day. */
  qtyBySymbol: Record<string, number>;
  /** Cumulative net USD invested up to this day (buys add, sells subtract). */
  invested: number;
}

/** Minimal daily bar shape — structural, matches server/yahoo.DailyBar. */
export interface PriceBar {
  date: string;
  close: number;
  adjclose: number | null;
}

export interface PricedDay {
  date: string;
  /** USD holdings value for the day. Excludes cash — the trade log has none. */
  value: number;
  invested: number;
}

/**
 * Walk the trade log chronologically → per-day holdings + invested baseline.
 * Every UTC calendar day from the first trade through today is emitted
 * (quiet days repeat the previous day's state), so the curve has no gaps.
 *
 * fxToUsd(date, currency) converts 1 unit of native currency to USD for that
 * date — the router feeds historical FX with a current-rate fallback.
 * Trade types other than SELL are treated as buys (money in), matching the
 * cash-flow convention used by the XIRR math.
 */
export function buildDailyHoldings(
  trades: TradeLeg[],
  fxToUsd: (date: string, currency: string) => number,
): DailyHolding[] {
  const legs = trades
    .map((t) => ({ ...t, at: new Date(t.executedAt) }))
    .filter(
      (t) =>
        Number.isFinite(t.at.getTime()) && t.quantity > 0 && t.price > 0,
    )
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  if (legs.length === 0) return [];

  const first = legs[0]!.at;
  const startMs = Date.UTC(
    first.getUTCFullYear(),
    first.getUTCMonth(),
    first.getUTCDate(),
  );
  const now = new Date();
  const endMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );

  const qty: Record<string, number> = {};
  let invested = 0;
  let li = 0;
  const days: DailyHolding[] = [];
  for (let t = startMs; t <= endMs && days.length < 5000; t += DAY_MS) {
    const iso = new Date(t).toISOString().slice(0, 10);
    while (li < legs.length && utcDay(legs[li]!.at) <= iso) {
      const leg = legs[li]!;
      const sym = leg.symbol.trim().toUpperCase();
      const isSell = leg.type === "SELL";
      const dir = isSell ? -1 : 1;
      qty[sym] = (qty[sym] ?? 0) + dir * leg.quantity;
      const gross = leg.quantity * leg.price;
      // Buys: money in (cost + fees). Sells: money out (proceeds − fees).
      const signed = isSell ? -(gross - (leg.fees ?? 0)) : gross + (leg.fees ?? 0);
      invested += signed * fxToUsd(iso, inferCurrency(sym));
      li++;
    }
    days.push({ date: iso, qtyBySymbol: { ...qty }, invested });
  }
  return days;
}

/** Latest bar with bar.date <= iso (bars ascending). Null when none. */
export function latestBarOnOrBefore(
  bars: PriceBar[],
  iso: string,
): PriceBar | null {
  let out: PriceBar | null = null;
  for (const b of bars) {
    if (b.date <= iso) out = b;
    else break;
  }
  return out;
}

/**
 * Turn daily holdings into daily USD values: Σ qty × adjclose → native → USD.
 * Bars forward-fill (weekends/holidays reuse the latest bar on or before the
 * day). Symbols with no usable bar are skipped and reported in
 * missingSymbols — the caller labels the chart accordingly instead of
 * silently understating it.
 */
export function aggregateDailyValue(
  days: DailyHolding[],
  closesBySymbol: Record<string, PriceBar[]>,
  fxToUsd: (date: string, currency: string) => number,
): { priced: PricedDay[]; missingSymbols: string[] } {
  const missing = new Set<string>();
  const priced: PricedDay[] = days.map((d) => {
    let value = 0;
    for (const sym of Object.keys(d.qtyBySymbol)) {
      const q = d.qtyBySymbol[sym]!;
      if (q === 0) continue;
      const bar = latestBarOnOrBefore(closesBySymbol[sym] ?? [], d.date);
      if (!bar) {
        missing.add(sym);
        continue;
      }
      const px = bar.adjclose ?? bar.close;
      value += q * px * fxToUsd(d.date, inferCurrency(sym));
    }
    return { date: d.date, value, invested: d.invested };
  });
  return { priced, missingSymbols: [...missing] };
}
