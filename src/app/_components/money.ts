/**
 * Pure money-formatting helpers — no React, safe to import anywhere
 * including node unit tests. The display-currency context in
 * `./currency` re-exports these.
 */

/** Format a USD amount in the given display currency — whole units, no decimals. */
export function formatMoney(
  usd: number,
  currency: string,
  rates?: Record<string, number> | null,
  opts?: { sign?: boolean },
): string {
  const rate = rates?.[currency.toLowerCase()] ?? 1;
  const converted = usd * rate;
  const sign = opts?.sign && converted > 0 ? "+" : "";
  try {
    return (
      sign +
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).format(converted)
    );
  } catch {
    return `${sign}${currency} ${Math.round(converted).toLocaleString("en-US")}`;
  }
}

/**
 * Compact money format for chart axes: HK$1.1M, HK$941.7K, HK$614.
 * Compact notation with at most one fraction digit (1.1M, never 1.10M).
 */
export function formatMoneyCompact(
  usd: number,
  currency: string,
  rates?: Record<string, number> | null,
): string {
  const rate = rates?.[currency.toLowerCase()] ?? 1;
  const converted = usd * rate;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(converted);
  } catch {
    return `${currency} ${Math.round(converted).toLocaleString("en-US")}`;
  }
}
