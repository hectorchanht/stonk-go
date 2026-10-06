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
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  addDecimal,
  binancePriceFetcherFromTickers,
  binanceSignature,
  coinbaseSignature,
  decimalToString,
  fetchBinancePrice,
  fetchCoinbasePrice,
  fetchKrakenPrice,
  formatCents,
  isUsdPegged,
  krakenSignature,
  mapKrakenAsset,
  mulDecimal,
  parseBinanceAccount,
  parseCoinbaseAccounts,
  parseDecimal,
  parseKrakenBalance,
  roundToCents,
  validateBinanceDirectPayload,
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

describe("binancePriceFetcherFromTickers (browser-side price map)", () => {
  const tickers = [
    { symbol: "BTCUSDT", price: "67000.12" },
    { symbol: "ETHUSDT", price: "3500.5" },
    { symbol: "DOGEUSDT", price: "not-a-number" },
  ];

  it("pegs stablecoins at 1 without a lookup", async () => {
    const f = binancePriceFetcherFromTickers(tickers);
    expect(await f("USDT")).toEqual({ price: "1", source: "peg:1" });
    expect(await f("usdc")).toEqual({ price: "1", source: "peg:1" });
  });

  it("hits the USDT pair for priced assets", async () => {
    const f = binancePriceFetcherFromTickers(tickers);
    expect(await f("BTC")).toEqual({
      price: "67000.12",
      source: "binance:ticker/price:BTCUSDT",
    });
    expect(await f("eth")).toEqual({
      price: "3500.5",
      source: "binance:ticker/price:ETHUSDT",
    });
  });

  it("returns null for a missing pair", async () => {
    const f = binancePriceFetcherFromTickers(tickers);
    expect(await f("XRP")).toBeNull();
    expect(await f("USDT")).not.toBeNull(); // pegged, not pair-dependent
  });

  it("skips malformed ticker prices", async () => {
    const f = binancePriceFetcherFromTickers(tickers);
    expect(await f("DOGE")).toBeNull();
  });

  it("valuates end-to-end with the ticker map (exact math + reconciliation)", async () => {
    const balances = parseBinanceAccount({
      balances: [
        { asset: "BTC", free: "0.05", locked: "0" },
        { asset: "USDT", free: "100.00", locked: "0" },
        { asset: "XRP", free: "10", locked: "0" }, // no XRPUSDT ticker -> unpriced
      ],
    });
    const v = await valuate(
      balances,
      binancePriceFetcherFromTickers(tickers),
      "2026-10-06T00:00:00.000Z",
    );
    expect(v.pricedCount).toBe(2);
    expect(v.unpriced).toEqual(["XRP"]);
    // 0.05 * 67000.12 = 3350.006 -> 335001c (half-up); 100 USDT -> 10000c
    expect(v.totalCents).toBe(335001n + 10000n);
    expect(v.reconciled).toBe(true);
  });
});

describe("validateBinanceDirectPayload (untrusted browser input)", () => {
  const goodAccount = {
    balances: [
      { asset: "BTC", free: "0.05", locked: "0.00" },
      { asset: "ETH", free: "2.5", locked: "0" },
    ],
  };
  const goodTickers = [
    { symbol: "BTCUSDT", price: "67000.12" },
    { symbol: "ETHUSDT", price: "3500.5" },
  ];

  it("accepts a well-formed payload", () => {
    const out = validateBinanceDirectPayload(goodAccount, goodTickers);
    expect(out.balances).toHaveLength(2);
    expect(out.balances[0]).toMatchObject({ asset: "BTC", quantity: "0.05" });
    expect(out.tickers).toHaveLength(2);
  });

  it("rejects garbage accountJson", () => {
    for (const bad of [null, undefined, "nope", 42, [], {}, { balances: "nope" }, { balances: [{ asset: 42 }] }]) {
      expect(() => validateBinanceDirectPayload(bad, goodTickers)).toThrow(
        "Invalid Binance response payload.",
      );
    }
  });

  it("rejects garbage tickersJson", () => {
    for (const bad of [null, undefined, "nope", 42, {}, [{ symbol: "BTCUSDT" }], [{ symbol: "BTCUSDT", price: 42 }]]) {
      expect(() => validateBinanceDirectPayload(goodAccount, bad)).toThrow(
        "Invalid Binance response payload.",
      );
    }
  });

  it("tolerates extra fields but still parses balances exactly", () => {
    const out = validateBinanceDirectPayload(
      {
        makerCommission: 10,
        balances: [{ asset: "BTC", free: "0.1", locked: "0.2", extra: true }],
      },
      goodTickers,
    );
    expect(out.balances).toHaveLength(1);
    expect(out.balances[0]?.quantity).toBe("0.3");
  });
});

/* ---------------- Kraken ---------------- */

describe("mapKrakenAsset", () => {
  it("strips X/Z prefixes and canonicalizes XBT to BTC", () => {
    expect(mapKrakenAsset("XXBT")).toBe("BTC");
    expect(mapKrakenAsset("XETH")).toBe("ETH");
    expect(mapKrakenAsset("ZUSD")).toBe("USD");
    expect(mapKrakenAsset("ZEUR")).toBe("EUR");
  });
  it("leaves unprefixed assets alone and strips staking suffixes", () => {
    expect(mapKrakenAsset("SOL")).toBe("SOL");
    expect(mapKrakenAsset("DOT")).toBe("DOT");
    expect(mapKrakenAsset("XTZ.S")).toBe("XTZ");
    expect(mapKrakenAsset("ETH2.S")).toBe("ETH2");
  });
});

describe("parseKrakenBalance", () => {
  it("maps codes, drops zeros, throws on API errors", () => {
    const out = parseKrakenBalance({
      error: [],
      result: {
        XXBT: "0.0500000000",
        XETH: "2.5",
        ZUSD: "1000.00",
        "XTZ.S": "10",
        XXRP: "0.00000000",
      },
    });
    expect(out).toEqual([
      { asset: "BTC", quantity: "0.0500000000" },
      { asset: "ETH", quantity: "2.5" },
      { asset: "USD", quantity: "1000.00" },
      { asset: "XTZ", quantity: "10" },
    ]);
  });

  it("throws ExchangeError when Kraken reports an error", () => {
    expect(() => parseKrakenBalance({ error: ["EAPI:Invalid key"], result: {} })).toThrow(
      /Kraken error: EAPI:Invalid key/,
    );
  });
});

describe("krakenSignature", () => {
  it("matches Node's crypto (independent implementation)", async () => {
    const secretB64 = Buffer.from("kraken-test-secret-1234567890ab").toString("base64");
    const urlPath = "/0/private/Balance";
    const nonce = "1720000000000";
    const postData = `nonce=${nonce}`;
    const got = await krakenSignature(secretB64, urlPath, nonce, postData);
    // Independent implementation via Node's crypto: SHA256(nonce+postData),
    // prepended with the URL path, HMAC-SHA512 with the decoded secret.
    const sha256 = createHash("sha256").update(nonce + postData).digest();
    const expected = createHmac("sha512", Buffer.from(secretB64, "base64"))
      .update(Buffer.concat([Buffer.from(urlPath), sha256]))
      .digest("base64");
    expect(got).toBe(expected);
  });

  it("rejects non-base64 secrets", async () => {
    await expect(
      krakenSignature("!!!not-base64!!!", "/0/private/Balance", "1", "nonce=1"),
    ).rejects.toThrow(/not valid base64/);
  });
});

describe("fetchKrakenPrice", () => {
  const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it("prices BTC via the XBTUSD ticker (Kraken's alt name)", async () => {
    const fetcher = (async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://api.kraken.com/0/public/Ticker?pair=XBTUSD");
      return okJson({ error: [], result: { XXBTZUSD: { c: ["67000.12", "0.01"] } } });
    }) as typeof fetch;
    const p = await fetchKrakenPrice("BTC", fetcher);
    expect(p).toEqual({ price: "67000.12", source: "kraken:ticker:XBTUSD" });
  });

  it("falls back to the USDT pair when USD is missing", async () => {
    const fetcher = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("pair=SOLUSD")) return okJson({ error: ["EQuery:Unknown asset pair"], result: {} });
      expect(u).toBe("https://api.kraken.com/0/public/Ticker?pair=SOLUSDT");
      return okJson({ error: [], result: { SOLUSDT: { c: ["150.5", "2"] } } });
    }) as typeof fetch;
    const p = await fetchKrakenPrice("SOL", fetcher);
    expect(p).toEqual({ price: "150.5", source: "kraken:ticker:SOLUSDT" });
  });

  it("returns null when no pair exists", async () => {
    const fetcher = (async () =>
      okJson({ error: ["EQuery:Unknown asset pair"], result: {} })) as typeof fetch;
    expect(await fetchKrakenPrice("NOPE", fetcher)).toBeNull();
  });

  it("pegs USD and stablecoins at 1 without a lookup", async () => {
    let called = 0;
    const fetcher = (async () => {
      called++;
      return okJson({});
    }) as typeof fetch;
    expect(await fetchKrakenPrice("USD", fetcher)).toEqual({ price: "1", source: "peg:1" });
    expect(await fetchKrakenPrice("USDT", fetcher)).toEqual({ price: "1", source: "peg:1" });
    expect(called).toBe(0);
  });
});
