/**
 * Pure currency/exchange helpers — no server dependencies, safe to import
 * anywhere including tests and client components.
 */

/**
 * HKEX stock codes are numeric (e.g. IBKR reports "2225" for 02225.HK,
 * manual entries use "2225.HK"). No major US listing is purely numeric,
 * so an all-digit symbol — with or without the .HK suffix — is treated
 * as a Hong Kong stock.
 */
export function isHkCode(symbol: string): boolean {
  const s = symbol.trim().toUpperCase().replace(/\.HK$/, "");
  return /^\d{1,5}$/.test(s);
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

/**
 * IBKR reports forex conversions as pseudo-symbols like "USD.HKD" — a
 * currency conversion, not a holding. Valued as a position (qty × "cost"),
 * one of these reads as hundreds of thousands of dollars of phantom
 * holdings (2026-10-09: USD.HKD inflated the true equity curve by US$432k,
 * printing a −HK$3.2M 1D P/L on a HK$766k portfolio). Matches any
 * XXX.YYY currency-pair shape; real tickers never look like this
 * ("BRK.B" has a 1-letter suffix, "0700.HK" a numeric prefix).
 */
export function isForexSymbol(symbol: string): boolean {
  return /^[A-Z]{3}\.[A-Z]{3}$/.test(symbol.trim().toUpperCase());
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
