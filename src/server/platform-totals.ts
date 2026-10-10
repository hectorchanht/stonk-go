/**
 * Per-platform portfolio aggregation — pure functions with no server-only
 * imports so they can be unit-tested directly.
 *
 * Honesty rule: a platform's cost is unknown (null) when ANY of its
 * positions lacks a recorded cost basis. The missing cost is never filled
 * with $0 — doing so would parade the position's full market value as
 * profit (the old Binance bug: +$20,908 of phantom P/L with no cost data
 * behind it). Total P/L is then unknown too.
 */

/** Minimal row shape the aggregation needs (HoldingRow satisfies this). */
export interface PlatformRow {
  source: "manual" | "broker";
  /** Source label for broker rows ("IBKR", "COINBASE", "BINANCE"); null for manual. */
  brokerLabel: string | null;
  marketValue: number | null;
  /** Null when the position has no recorded cost basis. */
  costBasis: number | null;
  dayPL: number | null;
}

export interface PlatformTotal {
  platform: string;
  count: number;
  marketValue: number;
  /** Null when any of the platform's positions lacks a recorded cost. */
  costBasis: number | null;
  /** Null when no position on the platform has a day P/L. */
  dayPL: number | null;
  /** Null when costBasis is null — unknown cost means unknown P/L. */
  totalPL: number | null;
}

function platformOf(r: PlatformRow): string {
  return r.source === "manual" ? "Manual" : (r.brokerLabel ?? "IBKR");
}

/** Per-platform snapshot totals for the Platforms widget. */
export function buildByPlatform(rows: PlatformRow[]): PlatformTotal[] {
  const map = new Map<
    string,
    {
      count: number;
      marketValue: number;
      costBasis: number;
      hasUnknownCost: boolean;
      dayPL: number;
      hasDayPL: boolean;
    }
  >();
  for (const r of rows) {
    const p = platformOf(r);
    const e = map.get(p) ?? {
      count: 0,
      marketValue: 0,
      costBasis: 0,
      hasUnknownCost: false,
      dayPL: 0,
      hasDayPL: false,
    };
    e.count += 1;
    e.marketValue += r.marketValue ?? 0;
    if (r.costBasis == null) e.hasUnknownCost = true;
    else e.costBasis += r.costBasis;
    if (r.dayPL != null) {
      e.dayPL += r.dayPL;
      e.hasDayPL = true;
    }
    map.set(p, e);
  }
  return [...map.entries()]
    .map(([platform, e]) => {
      const costBasis = e.hasUnknownCost ? null : e.costBasis;
      return {
        platform,
        count: e.count,
        marketValue: e.marketValue,
        costBasis,
        dayPL: e.hasDayPL ? e.dayPL : null,
        totalPL: costBasis == null ? null : e.marketValue - costBasis,
      };
    })
    .sort((a, b) => b.marketValue - a.marketValue);
}
