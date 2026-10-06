/**
 * Pure currency/exchange helpers — no server dependencies, safe to import
 * anywhere including tests and client components.
 */

/**
 * HKEX stock codes are numeric (e.g. IBKR reports "2225" for 02225.HK).
 * No major US listing is purely numeric, so an all-digit symbol is
 * treated as a Hong Kong stock.
 */
export function isHkCode(symbol: string): boolean {
  return /^\d{1,5}$/.test(symbol.trim());
}

/**
 * Native trading currency inferred from the symbol's exchange region.
 * HKEX codes (pure numeric) trade in HKD; everything else defaults to USD.
 * Used as a fallback when IBKR didn't report a currency.
 */
export function inferCurrency(symbol: string): string {
  return isHkCode(symbol) ? "HKD" : "USD";
}

/**
 * Canonical key for comparing symbols across sources. IBKR reports HKEX
 * codes bare ("700"); manual entries and Yahoo use "0700.HK" — both
 * canonicalize to "700", so the same position is never double-counted
 * when the formats differ. US-style symbols ("BRK.B") are untouched.
 */
export function canonicalSymbol(symbol: string): string {
  const t = symbol.trim().toUpperCase().replace(/\.HK$/, "");
  if (/^\d+$/.test(t)) return String(Number(t)); // "0700" → "700"
  return t.replace(/\s+/g, "");
}

/** Convert an amount in `currency` to USD. Falls back to as-is. */
export function toUsd(
  amount: number,
  currency: string | null | undefined,
  rates: Record<string, number>,
): number {
  const code = (currency ?? "USD").toUpperCase();
  if (code === "USD") return amount;
  const rate = rates[code.toLowerCase()];
  return rate ? amount / rate : amount;
}
