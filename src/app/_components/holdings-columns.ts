/**
 * Column model for the Holdings table: which optional columns exist, their
 * canonical order, defaults, and localStorage persistence.
 *
 * The Symbol column is the row identity and the actions column (delete/synced)
 * are always shown; everything listed here is user-toggleable.
 */

export type HoldingColumnKey =
  | "qty"
  | "avgCost"
  | "cost"
  | "price"
  | "marketValue"
  | "dayPL"
  | "totalPL"
  | "weight";

export const HOLDINGS_COLUMNS_KEY = "holdr.holdings.columns";

export const HOLDINGS_ALL_COLUMNS: ReadonlyArray<{
  key: HoldingColumnKey;
  label: string;
}> = [
  { key: "qty", label: "Qty" },
  { key: "avgCost", label: "Avg cost" },
  { key: "cost", label: "Cost" },
  { key: "price", label: "Price" },
  { key: "marketValue", label: "Mkt value" },
  { key: "dayPL", label: "Day P/L" },
  { key: "totalPL", label: "Total P/L" },
  { key: "weight", label: "Weight" },
];

const ORDER = new Map<HoldingColumnKey, number>(
  HOLDINGS_ALL_COLUMNS.map((c, i) => [c.key, i]),
);

/** All optional columns on — the out-of-box view. */
export const HOLDINGS_DEFAULT_COLUMNS: HoldingColumnKey[] =
  HOLDINGS_ALL_COLUMNS.map((c) => c.key);

export function isHoldingColumnKey(k: unknown): k is HoldingColumnKey {
  return typeof k === "string" && ORDER.has(k as HoldingColumnKey);
}

/**
 * Parse a persisted selection. Returns null when absent or invalid so the
 * caller falls back to HOLDINGS_DEFAULT_COLUMNS. Unknown keys are dropped
 * (forward-compatible with renamed columns).
 */
export function parseStoredColumns(
  raw: string | null | undefined,
): HoldingColumnKey[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const valid = parsed.filter(isHoldingColumnKey);
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}

/**
 * Toggle one column. The result keeps canonical column order, and at least
 * one optional column always stays visible (unchecking the last one is a no-op).
 */
export function toggleColumnKey(
  prev: HoldingColumnKey[],
  key: HoldingColumnKey,
): HoldingColumnKey[] {
  if (prev.includes(key)) {
    if (prev.length <= 1) return prev;
    return prev.filter((k) => k !== key);
  }
  const next = [...prev, key];
  next.sort((a, b) => (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0));
  return next;
}
