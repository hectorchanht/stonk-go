/**
 * Unit tests for the exchange integrations (Coinbase + Binance).
 *
 * Covers Hector's hard requirement: numbers must be correctly calculated.
 * - Native quantities are parsed as exact decimal strings (no floats).
 * - Money math is BigInt-based; rounding happens once, to cents, half-up.
 * - Totals are computed two ways and reconciled; drift beyond the rounding
 *   bound would flag `reconciled: false`.
 * - Fixtures cover: multiple assets, dust/tiny balances, zero balances,
 *   unpriced assets, and a totals-reconciliation case.
 *
 * Run: npx vitest run src/server/exchanges.test.ts
 * (requires vitest as a devDependency: npm i -D vitest)
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  addDecimal,
  binanceSignature,
  coinbaseSignature,
  decimalToString,
  fetchBinancePrice,
  fetchCoinbasePrice,
  formatCents,
  isUsdPegged,
  mulDecimal,
  parseBinanceAccount,
  parseCoinbaseAccounts,
  parseDecimal,
  roundToCents,
  valuate,
  type PriceFetcher,
} from "./exchanges";

/* ---------------- fixtures ---------------- */

const COINBASE_ACCOUNTS_FIXTURE = {
  accounts: [
    {
      uuid: "11111111-1111-1111-1111-111111111111",
      name: "BTC Wallet",
      currency: "BTC",
      available_balance: { value: "0.05", currency: "BTC" },
      active: true,
    },
    {
      uuid: "22222222-2222-2222-2222-222222222222",
      name: "ETH Wallet",
      currency: "ETH",
      available_balance: { value: "2.5", currency: "ETH" },
      active: true,
    },
    {
      uuid: "33333333-3333-3333-3333-333333333333",
      name: "USDC Wallet",
      currency: "USDC",
      available_balance: { value: "100.00", currency: "USDC" },
      active: true,
    },
    {
      uuid: "44444444-4444-4444-4444-444444444444",
      name: "SHIB Wallet",
      currency: "SHIB",
      available_balance: { value: "0.00000001", currency: "SHIB" },
      active: true,
    },
    {
      uuid: "55555555-5555-5555-5555-555555555555",
      name: "SOL Wallet",
      currency: "SOL",
      available_balance: { value: "0", currency: "SOL" },
      active: true,
    },
    {
      uuid: "66666666-6666-6666-6666-666666666666",
      name: "USD Wallet",
      currency: "USD",
      available_balance: { value: "250.75", currency: "USD" },
      active: true,
    },
  ],
  has_next: false,
  cursor: "",
  size: 6,
};

const BINANCE_ACCOUNT_FIXTURE = {
  makerCommission: 10,
  takerCommission: 10,
  balances: [
    { asset: "BTC", free: "0.04", locked: "0.01" },
    { asset: "ETH", free: "0", locked: "0" },
    { asset: "USDT", free: "500.12345678", locked: "0" },
    { asset: "BNB", free: "0.00000001", locked: "0" },
  ],
};

/** Deterministic price oracle for tests. SHIB has no price (unpriced path). */
const MOCK_PRICES: Record<string, string> = {
  BTC: "100000.00",
  ETH: "3000.50",
  BNB: "600.00",
  USDC: "1",
  USDT: "1",
  USD: "1",
};

const mockPriceFor: PriceFetcher = async (asset) => {
  const price = MOCK_PRICES[asset];
  if (!price) return null;
  return { price, source: `mock:${asset}-USD` };
};

/* ---------------- decimal math ---------------- */

describe("parseDecimal", () => {
  it("parses plain decimals exactly", () => {
    expect(parseDecimal("0.05")).toEqual({ int: 5n, scale: 2 });
    expect(parseDecimal("100")).toEqual({ int: 100n, scale: 0 });
    expect(parseDecimal("250.75")).toEqual({ int: 25075n, scale: 2 });
    expect(parseDecimal("0.00000001")).toEqual({ int: 1n, scale: 8 });
  });

  it("handles negatives", () => {
    expect(parseDecimal("-1.005")).toEqual({ int: -1005n, scale: 3 });
  });

  it("rejects garbage", () => {
    expect(() => parseDecimal("abc")).toThrow();
    expect(() => parseDecimal("1e5")).toThrow();
    expect(() => parseDecimal("")).toThrow();
    expect(() => parseDecimal("12.34.56")).toThrow();
  });

  it("round-trips through decimalToString", () => {
    for (const s of ["0.05", "100", "250.75", "0.00000001", "500.12345678"]) {
      expect(decimalToString(parseDecimal(s))).toBe(s);
    }
  });
});

describe("decimal arithmetic", () => {
  it("adds 0.1 + 0.2 exactly (the classic float trap)", () => {
    const sum = addDecimal(parseDecimal("0.1"), parseDecimal("0.2"));
    expect(decimalToString(sum)).toBe("0.3");
  });

  it("adds Binance free + locked exactly", () => {
    const total = addDecimal(parseDecimal("0.04"), parseDecimal("0.01"));
    expect(decimalToString(total)).toBe("0.05");
  });

  it("multiplies quantity x price exactly", () => {
    const v = mulDecimal(parseDecimal("0.05"), parseDecimal("100000.00"));
    expect(decimalToString(v)).toBe("5000.0000");
    expect(roundToCents(v)).toBe(500000n);
  });
});

describe("roundToCents", () => {
  it("rounds half away from zero", () => {
    expect(roundToCents(parseDecimal("1.005"))).toBe(101n);
    expect(roundToCents(parseDecimal("1.004"))).toBe(100n);
    expect(roundToCents(parseDecimal("-1.005"))).toBe(-101n);
    expect(roundToCents(parseDecimal("-1.004"))).toBe(-100n);
  });

  it("handles the 2.675 float trap (float gives 267, exact gives 268)", () => {
    expect(roundToCents(parseDecimal("2.675"))).toBe(268n);
  });

  it("rounds dust down to zero cents without losing the quantity", () => {
    // 0.00000001 BNB x $600 = $0.000006 -> 0 cents
    const v = mulDecimal(parseDecimal("0.00000001"), parseDecimal("600"));
    expect(roundToCents(v)).toBe(0n);
  });
});

describe("formatCents", () => {
  it("formats with grouping and sign", () => {
    expect(formatCents(123456n)).toBe("1,234.56");
    expect(formatCents(-5n)).toBe("-0.05");
    expect(formatCents(0n)).toBe("0.00");
  });
});

/* ---------------- response parsing ---------------- */

describe("parseCoinbaseAccounts", () => {
  it("keeps native quantities exact and drops zero balances", () => {
    const { balances } = parseCoinbaseAccounts(COINBASE_ACCOUNTS_FIXTURE);
    expect(balances.map((b) => b.asset).sort()).toEqual(
      ["BTC", "ETH", "SHIB", "USDC", "USD"].sort(),
    );
    // SOL (zero) excluded
    expect(balances.find((b) => b.asset === "SOL")).toBeUndefined();
    // Exact strings, not floats
    expect(balances.find((b) => b.asset === "BTC")?.quantity).toBe("0.05");
    expect(balances.find((b) => b.asset === "SHIB")?.quantity).toBe("0.00000001");
  });
});

describe("parseBinanceAccount", () => {
  it("sums free + locked exactly and drops zero balances", () => {
    const balances = parseBinanceAccount(BINANCE_ACCOUNT_FIXTURE);
    expect(balances.map((b) => b.asset).sort()).toEqual(["BNB", "BTC", "USDT"].sort());
    // 0.04 + 0.01 = 0.05 exactly (float would give 0.050000000000000004)
    expect(balances.find((b) => b.asset === "BTC")?.quantity).toBe("0.05");
    expect(balances.find((b) => b.asset === "USDT")?.quantity).toBe("500.12345678");
    expect(balances.find((b) => b.asset === "ETH")).toBeUndefined();
  });
});

/* ---------------- valuation + reconciliation ---------------- */

describe("valuate", () => {
  it("values a multi-asset portfolio with exact totals", async () => {
    const { balances } = parseCoinbaseAccounts(COINBASE_ACCOUNTS_FIXTURE);
    const v = await valuate(balances, mockPriceFor, "2026-10-06T00:00:00.000Z");

    // Hand-computed:
    // BTC  0.05 x 100000.00 = 5000.00  -> 500000n
    // ETH  2.5  x 3000.50   = 7501.25  -> 750125n
    // USDC 100  x 1         = 100.00   -> 10000n
    // USD  250.75 x 1       = 250.75   -> 25075n
    // SHIB unpriced
    // Total = 1285200n = $12,852.00
    expect(v.totalCents).toBe(1285200n);
    expect(v.altCents).toBe(1285200n);
    expect(v.driftCents).toBe(0n);
    expect(v.reconciled).toBe(true);
    expect(v.pricedCount).toBe(4);
    expect(v.unpriced).toEqual(["SHIB"]);

    const byAsset = new Map(v.items.map((i) => [i.asset, i]));
    // Native quantities kept exact alongside values
    expect(byAsset.get("BTC")).toMatchObject({
      quantity: "0.05",
      priceUsd: "100000.00",
      valueCents: 500000n,
    });
    expect(byAsset.get("BTC")?.priceSource).toBe("mock:BTC-USD");
    expect(byAsset.get("BTC")?.priceAt).toBe("2026-10-06T00:00:00.000Z");
    // Unpriced assets are NOT zeroed — quantity kept, value null
    expect(byAsset.get("SHIB")).toMatchObject({
      quantity: "0.00000001",
      priceUsd: null,
      valueCents: null,
    });
  });

  it("keeps dust quantities exact even when they round to 0 cents", async () => {
    const balances = parseBinanceAccount(BINANCE_ACCOUNT_FIXTURE);
    const v = await valuate(balances, mockPriceFor, "2026-10-06T00:00:00.000Z");
    const bnb = v.items.find((i) => i.asset === "BNB");
    expect(bnb?.quantity).toBe("0.00000001");
    expect(bnb?.valueCents).toBe(0n);
    // BTC 0.05 x 100000 = 500000n; USDT 500.12345678 x 1 = 50012n (rounded)
    expect(v.totalCents).toBe(500000n + 50012n + 0n);
    expect(v.reconciled).toBe(true);
  });

  it("stays reconciled on randomized portfolios (property test)", async () => {
    // Deterministic PRNG (mulberry32)
    let seed = 42;
    const rand = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let trial = 0; trial < 50; trial++) {
      const n = 1 + Math.floor(rand() * 12);
      const balances = Array.from({ length: n }, (_, i) => ({
        asset: `T${trial}_${i}`,
        quantity: (rand() * 1000).toFixed(8),
      }));
      const prices: Record<string, string> = {};
      for (const b of balances) prices[b.asset] = (rand() * 50000 + 0.0001).toFixed(8);
      const v = await valuate(
        balances,
        async (a) => ({ price: prices[a]!, source: "test" }),
        "2026-10-06T00:00:00.000Z",
      );
      expect(v.reconciled).toBe(true);
      const absDrift = v.driftCents < 0n ? -v.driftCents : v.driftCents;
      expect(absDrift * 2n <= BigInt(n)).toBe(true);
      // Sum of rows equals the total (recompute independently)
      const rowSum = v.items.reduce((s, i) => s + (i.valueCents ?? 0n), 0n);
      expect(rowSum).toBe(v.totalCents);
    }
  });
});

/* ---------------- auth signatures ---------------- */

describe("signatures", () => {
  it("coinbaseSignature matches Node's HMAC (independent implementation)", async () => {
    const secretB64 = Buffer.from("test-secret-key-1234567890").toString("base64");
    const timestamp = "1720000000";
    const method = "GET";
    const path = "/api/v3/brokerage/accounts?limit=250";
    const got = await coinbaseSignature(secretB64, timestamp, method, path);
    const expected = createHmac("sha256", Buffer.from(secretB64, "base64"))
      .update(timestamp + method + path)
      .digest("base64");
    expect(got).toBe(expected);
  });

  it("binanceSignature matches Node's HMAC hex", async () => {
    const secret = "binance-test-secret";
    const qs = "timestamp=1720000000000&recvWindow=5000";
    const got = await binanceSignature(secret, qs);
    const expected = createHmac("sha256", secret).update(qs).digest("hex");
    expect(got).toBe(expected);
  });
});

/* ---------------- price fetchers ---------------- */

describe("price fetchers", () => {
  const okJson = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200 });

  it("fetchCoinbasePrice uses the public spot endpoint", async () => {
    const fetcher = (async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://api.coinbase.com/v2/prices/BTC-USD/spot");
      return okJson({ data: { base: "BTC", currency: "USD", amount: "97543.21" } });
    }) as typeof fetch;
    const p = await fetchCoinbasePrice("BTC", fetcher);
    expect(p).toEqual({
      price: "97543.21",
      source: "coinbase:v2/prices/BTC-USD/spot",
    });
  });

  it("fetchCoinbasePrice returns null on missing price", async () => {
    const fetcher = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    expect(await fetchCoinbasePrice("NOPE", fetcher)).toBeNull();
  });

  it("fetchBinancePrice uses the public ticker endpoint", async () => {
    const fetcher = (async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT");
      return okJson({ symbol: "ETHUSDT", price: "3000.50000000" });
    }) as typeof fetch;
    const p = await fetchBinancePrice("ETH", fetcher);
    expect(p).toEqual({ price: "3000.50000000", source: "binance:ticker/price:ETHUSDT" });
  });

  it("stablecoins and fiat are pegged at 1 without a lookup", async () => {
    let called = 0;
    const fetcher = (async () => {
      called++;
      return okJson({});
    }) as typeof fetch;
    expect(await fetchCoinbasePrice("USDC", fetcher)).toEqual({ price: "1", source: "peg:1" });
    expect(await fetchBinancePrice("USDT", fetcher)).toEqual({ price: "1", source: "peg:1" });
    expect(called).toBe(0);
    expect(isUsdPegged("USDC")).toBe(true);
    expect(isUsdPegged("BTC")).toBe(false);
  });
});
