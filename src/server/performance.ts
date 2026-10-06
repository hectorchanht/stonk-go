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
  /**
   * Uppercase symbol → average native-currency cost per share at end of day
   * (average-cost walk over the trade log, same math as recomputeHolding).
   * Lets the curve value symbols that have no price history at their known
   * cost instead of $0 — no invented prices, no fake cliff.
   */
  avgCostBySymbol: Record<string, number>;
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
  /** Native-currency total cost basis per symbol (average-cost method). */
  const cost: Record<string, number> = {};
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
      const gross = leg.quantity * leg.price;
      if (isSell) {
        // Average-cost relief: sells remove a proportional slice of the
        // cost basis. Clamp — never let a data quirk drive cost negative.
        const held = qty[sym] ?? 0;
        const ratio = held > 0 ? Math.min(1, leg.quantity / held) : 0;
        cost[sym] = (cost[sym] ?? 0) * (1 - ratio);
      } else {
        cost[sym] = (cost[sym] ?? 0) + gross + (leg.fees ?? 0);
      }
      qty[sym] = (qty[sym] ?? 0) + dir * leg.quantity;
      // Buys: money in (cost + fees). Sells: money out (proceeds − fees).
      const signed = isSell ? -(gross - (leg.fees ?? 0)) : gross + (leg.fees ?? 0);
      invested += signed * fxToUsd(iso, inferCurrency(sym));
      li++;
    }
    const avgCost: Record<string, number> = {};
    for (const sym of Object.keys(qty)) {
      const q = qty[sym]!;
      avgCost[sym] = q > 1e-9 ? (cost[sym] ?? 0) / q : 0;
    }
    days.push({ date: iso, qtyBySymbol: { ...qty }, invested, avgCostBySymbol: avgCost });
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
 * day). Symbols with no usable bar fall back to their known average cost
 * (from the trade log — real buy prices, never invented) and are reported
 * in estimatedSymbols; symbols with neither price nor cost land in
 * missingSymbols. Nothing is ever silently zeroed in a way the caller
 * can't label.
 */
export function aggregateDailyValue(
  days: DailyHolding[],
  closesBySymbol: Record<string, PriceBar[]>,
  fxToUsd: (date: string, currency: string) => number,
): { priced: PricedDay[]; missingSymbols: string[]; estimatedSymbols: string[] } {
  const missing = new Set<string>();
  const estimated = new Set<string>();
  const priced: PricedDay[] = days.map((d) => {
    let value = 0;
    for (const sym of Object.keys(d.qtyBySymbol)) {
      const q = d.qtyBySymbol[sym]!;
      if (q === 0) continue;
      const bar = latestBarOnOrBefore(closesBySymbol[sym] ?? [], d.date);
      if (bar) {
        const px = bar.adjclose ?? bar.close;
        value += q * px * fxToUsd(d.date, inferCurrency(sym));
        continue;
      }
      // No price history: value at known average cost (flat, honest).
      const avgCost = d.avgCostBySymbol[sym] ?? 0;
      if (avgCost > 0) {
        estimated.add(sym);
        value += q * avgCost * fxToUsd(d.date, inferCurrency(sym));
      } else {
        missing.add(sym);
      }
    }
    return { date: d.date, value, invested: d.invested };
  });
  return {
    priced,
    missingSymbols: [...missing],
    estimatedSymbols: [...estimated],
  };
}

/* ---------------- Per-source breakdown (By Source view) ---------------- */

/** A trade leg tagged with its origin (Transaction.source). */
export interface SourcedTradeLeg extends TradeLeg {
  /** Where the trade came from, e.g. "ibkr" | "manual". */
  source: string;
}

export interface SourcedDailyHolding {
  /** UTC calendar date, YYYY-MM-DD. */
  date: string;
  /** source → UPPER symbol → shares held at end of day. */
  qtyBySource: Record<string, Record<string, number>>;
  /** source → cumulative net USD invested up to this day. */
  investedBySource: Record<string, number>;
  /** source → UPPER symbol → average native-currency cost per share. */
  avgCostBySource: Record<string, Record<string, number>>;
}

const normSource = (s: string): string => {
  const k = s.trim().toLowerCase();
  return k === "" ? "unknown" : k;
};

/**
 * Like buildDailyHoldings, but keeps quantities and the invested baseline
 * separated by trade source. Every UTC calendar day from the first trade
 * through today is emitted; sources absent on a day simply have no entry
 * (callers treat that as zero).
 */
export function buildSourcedDailyHoldings(
  trades: SourcedTradeLeg[],
  fxToUsd: (date: string, currency: string) => number,
): SourcedDailyHolding[] {
  const legs = trades
    .map((t) => ({
      ...t,
      at: new Date(t.executedAt),
      src: normSource(t.source),
    }))
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

  const qty: Record<string, Record<string, number>> = {};
  const invested: Record<string, number> = {};
  /** source → symbol → total native cost basis (average-cost method). */
  const cost: Record<string, Record<string, number>> = {};
  const touch = (src: string): void => {
    if (!qty[src]) {
      qty[src] = {};
      invested[src] = 0;
      cost[src] = {};
    }
  };
  let li = 0;
  const days: SourcedDailyHolding[] = [];
  for (let t = startMs; t <= endMs && days.length < 5000; t += DAY_MS) {
    const iso = new Date(t).toISOString().slice(0, 10);
    while (li < legs.length && utcDay(legs[li]!.at) <= iso) {
      const leg = legs[li]!;
      touch(leg.src);
      const sym = leg.symbol.trim().toUpperCase();
      const isSell = leg.type === "SELL";
      const dir = isSell ? -1 : 1;
      const q = qty[leg.src]!;
      const c = cost[leg.src]!;
      const gross = leg.quantity * leg.price;
      if (isSell) {
        const held = q[sym] ?? 0;
        const ratio = held > 0 ? Math.min(1, leg.quantity / held) : 0;
        c[sym] = (c[sym] ?? 0) * (1 - ratio);
      } else {
        c[sym] = (c[sym] ?? 0) + gross + (leg.fees ?? 0);
      }
      q[sym] = (q[sym] ?? 0) + dir * leg.quantity;
      // Buys: money in (cost + fees). Sells: money out (proceeds − fees).
      const signed = isSell
        ? -(gross - (leg.fees ?? 0))
        : gross + (leg.fees ?? 0);
      invested[leg.src]! += signed * fxToUsd(iso, inferCurrency(sym));
      li++;
    }
    // Snapshot copies so later mutation can't alias earlier days.
    const snap: Record<string, Record<string, number>> = {};
    const avgSnap: Record<string, Record<string, number>> = {};
    for (const [src, q] of Object.entries(qty)) {
      snap[src] = { ...q };
      const ac: Record<string, number> = {};
      for (const sym of Object.keys(q)) {
        const held = q[sym]!;
        ac[sym] = held > 1e-9 ? (cost[src]![sym] ?? 0) / held : 0;
      }
      avgSnap[src] = ac;
    }
    days.push({
      date: iso,
      qtyBySource: snap,
      investedBySource: { ...invested },
      avgCostBySource: avgSnap,
    });
  }
  return days;
}

/**
 * Per-source version of aggregateDailyValue: for each source, Σ qty ×
 * adjclose → native → USD per day. Every source gets an entry for every
 * day (aligned series), with 0 before its first trade. Symbols with no
 * usable bar fall back to average cost (reported in estimatedSymbols);
 * symbols with neither land in missingSymbols — never silently zeroed in
 * a way the caller can't label.
 */
export function aggregateDailyValueBySource(
  days: SourcedDailyHolding[],
  closesBySymbol: Record<string, PriceBar[]>,
  fxToUsd: (date: string, currency: string) => number,
): {
  perSource: Record<string, PricedDay[]>;
  missingSymbols: string[];
  estimatedSymbols: string[];
} {
  const missing = new Set<string>();
  const estimated = new Set<string>();
  const sources = [
    ...new Set(days.flatMap((d) => Object.keys(d.qtyBySource))),
  ];
  const perSource: Record<string, PricedDay[]> = Object.fromEntries(
    sources.map((s) => [s, [] as PricedDay[]]),
  );
  for (const d of days) {
    for (const src of sources) {
      let value = 0;
      const qmap = d.qtyBySource[src] ?? {};
      const cmap = d.avgCostBySource[src] ?? {};
      for (const sym of Object.keys(qmap)) {
        const q = qmap[sym]!;
        if (q === 0) continue;
        const bar = latestBarOnOrBefore(closesBySymbol[sym] ?? [], d.date);
        if (bar) {
          const px = bar.adjclose ?? bar.close;
          value += q * px * fxToUsd(d.date, inferCurrency(sym));
          continue;
        }
        const avgCost = cmap[sym] ?? 0;
        if (avgCost > 0) {
          estimated.add(sym);
          value += q * avgCost * fxToUsd(d.date, inferCurrency(sym));
        } else {
          missing.add(sym);
        }
      }
      perSource[src]!.push({
        date: d.date,
        value,
        invested: d.investedBySource[src] ?? 0,
      });
    }
  }
  return {
    perSource,
    missingSymbols: [...missing],
    estimatedSymbols: [...estimated],
  };
}

/* ---------------- Monthly heatmap ---------------- */

export interface MonthCell {
  /** "2026-10" */
  month: string;
  year: number;
  /** 0-11 */
  monthIndex: number;
  /** USD value on the month's first day. */
  startValue: number;
  /** USD value on the month's last day. */
  endValue: number;
  /** Net USD deposited during the month (invested_end − invested_start). */
  netFlow: number;
  /** $ gain net of flows: (end − start) − netFlow. */
  gain: number;
  /**
   * % return net of flows. Standard simple monthly return with deposits
   * removed: gain / startValue. When the month starts at (or below) zero —
   * e.g. the very first deposit month — falls back to return-on-invested at
   * month end; null when neither denominator is positive (nothing to
   * measure against). Simple, NOT time-weighted — the UI labels it as such.
   */
  pct: number | null;
}

/**
 * Bucket a full-resolution daily value series into calendar months
 * (UTC). The input should be the true curve's daily series; months are
 * emitted oldest-first.
 */
export function bucketMonthly(days: PricedDay[]): MonthCell[] {
  if (days.length === 0) return [];
  const cells: MonthCell[] = [];
  let cur: string | null = null;
  let start: PricedDay | null = null;
  let prev: PricedDay | null = null;
  const flush = (): void => {
    if (cur === null || start === null || prev === null) return;
    const year = Number(cur.slice(0, 4));
    const monthIndex = Number(cur.slice(5, 7)) - 1;
    const netFlow = prev.invested - start.invested;
    const gain = prev.value - start.value - netFlow;
    const pct =
      start.value > 0
        ? (gain / start.value) * 100
        : prev.invested > 0
          ? ((prev.value - prev.invested) / prev.invested) * 100
          : null;
    cells.push({
      month: cur,
      year,
      monthIndex,
      startValue: start.value,
      endValue: prev.value,
      netFlow,
      gain,
      pct,
    });
  };
  for (const d of days) {
    const m = d.date.slice(0, 7);
    if (m !== cur) {
      flush();
      cur = m;
      start = d;
    }
    prev = d;
  }
  flush();
  return cells;
}
