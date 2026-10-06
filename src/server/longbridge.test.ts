/**
 * Unit tests for the Longbridge (長橋證券) OpenAPI client.
 *
 * - Request signing is pinned against the known-good vector from the
 *   official longbridge/openapi SDK (signature.rs).
 * - Symbol normalization, position/order parsing and the code!==0
 *   envelope error path are covered with fixtures.
 * - Live fetchers are tested against a mock fetch (no network).
 *
 * Run: npx vitest run src/server/longbridge.test.ts
 */
import { describe, expect, it, vi } from "vitest";

import {
  LongbridgeError,
  getAccountBalance,
  getHistoryOrders,
  getStockPositions,
  normalizeLongbridgeSymbol,
  parseHistoryOrders,
  parseStockPositions,
  signLongbridgeRequest,
  type FetchLike,
} from "./longbridge";

describe("signLongbridgeRequest", () => {
  it("matches the known-good vector from the official SDK", async () => {
    const sig = await signLongbridgeRequest(
      "test-app-key",
      "test-app-secret",
      "test-access-token",
      "GET",
      "/v1/asset/stock",
      "",
      null,
      "1720000000",
    );
    expect(sig.authorization).toBe(
      "HMAC-SHA256 SignedHeaders=authorization;x-api-key;x-timestamp, Signature=3fafe7e1c0a3eda04c57b2db58cc4c71a15ed2e10f0b4330608bba0ce013f164",
    );
    expect(sig.signature).toBe(
      "3fafe7e1c0a3eda04c57b2db58cc4c71a15ed2e10f0b4330608bba0ce013f164",
    );
    // The raw token (NOT "Bearer ...") plus the other signed headers.
    expect(sig.headers).toEqual({
      authorization: "test-access-token",
      "x-api-key": "test-app-key",
      "x-timestamp": "1720000000",
    });
  });

  it("produces a different signature when the query string changes", async () => {
    const a = await signLongbridgeRequest("k", "s", "t", "GET", "/v1/asset/stock", "", null, "1720000000");
    const b = await signLongbridgeRequest(
      "k",
      "s",
      "t",
      "GET",
      "/v1/trade/order/history",
      "start_at=2025-01-01T00%3A00%3A00.000Z",
      null,
      "1720000000",
    );
    expect(a.signature).not.toBe(b.signature);
  });
});

describe("normalizeLongbridgeSymbol", () => {
  it("pads HK numeric codes to 4 digits", () => {
    expect(normalizeLongbridgeSymbol("700.HK")).toBe("0700.HK");
    expect(normalizeLongbridgeSymbol("5.HK")).toBe("0005.HK");
  });
  it("leaves 4+ digit HK codes alone", () => {
    expect(normalizeLongbridgeSymbol("9988.HK")).toBe("9988.HK");
  });
  it("strips the US market suffix", () => {
    expect(normalizeLongbridgeSymbol("AAPL.US")).toBe("AAPL");
  });
  it("passes other markets through unchanged", () => {
    expect(normalizeLongbridgeSymbol("600519.SH")).toBe("600519.SH");
    expect(normalizeLongbridgeSymbol("000001.SZ")).toBe("000001.SZ");
  });
  it("passes suffix-less symbols through unchanged", () => {
    expect(normalizeLongbridgeSymbol("AAPL")).toBe("AAPL");
  });
});

const stockFixture = {
  code: 0,
  message: "ok",
  data: {
    list: [
      {
        account_channel: "HK",
        stock_info: [
          {
            symbol: "700.HK",
            symbol_name: "TENCENT",
            quantity: "100",
            available_quantity: "100",
            currency: "HKD",
            cost_price: "320.40",
            market: "HK",
          },
          {
            symbol: "5.HK",
            symbol_name: "HSBC",
            quantity: "400.5",
            available_quantity: "400.5",
            currency: "HKD",
            cost_price: "58.125",
            market: "HK",
          },
        ],
      },
      {
        account_channel: "US",
        stock_info: [
          {
            symbol: "AAPL.US",
            symbol_name: "Apple Inc",
            quantity: "10",
            available_quantity: "8",
            currency: "USD",
            cost_price: "150.00",
            market: "US",
          },
        ],
      },
    ],
  },
};

describe("parseStockPositions", () => {
  it("normalizes symbols and parses decimals across channels", () => {
    const positions = parseStockPositions(stockFixture.data);
    expect(positions).toHaveLength(3);
    expect(positions[0]).toMatchObject({
      accountChannel: "HK",
      symbol: "0700.HK",
      description: "TENCENT",
      currency: "HKD",
      quantity: 100,
      availableQuantity: 100,
      costPrice: 320.4,
      market: "HK",
    });
    expect(positions[1]).toMatchObject({ symbol: "0005.HK", quantity: 400.5 });
    expect(positions[2]).toMatchObject({
      accountChannel: "US",
      symbol: "AAPL",
      currency: "USD",
      availableQuantity: 8,
    });
  });

  it("throws on a malformed quantity instead of silently zeroing", () => {
    const bad = {
      list: [
        {
          account_channel: "HK",
          stock_info: [{ symbol: "700.HK", quantity: "abc", currency: "HKD" }],
        },
      ],
    };
    expect(() => parseStockPositions(bad)).toThrow(LongbridgeError);
  });
});

const historyFixture = {
  code: 0,
  message: "ok",
  data: {
    list: [
      {
        order_id: "order-1",
        status: "Filled",
        symbol: "700.HK",
        side: "Buy",
        submitted_quantity: "100",
        executed_quantity: "100",
        price: "320.00",
        executed_price: "319.50",
        submitted_at: "2025-03-04T02:30:00Z",
        currency: "HKD",
      },
      {
        order_id: "order-2",
        status: "Filled",
        symbol: "AAPL.US",
        side: "Sell",
        submitted_quantity: "10",
        executed_quantity: "10",
        price: "150.00",
        executed_price: null,
        submitted_at: "2025-06-10T14:00:00Z",
        currency: "USD",
      },
      {
        order_id: "order-3",
        status: "PartiallyFilled",
        symbol: "5.HK",
        side: "Buy",
        submitted_quantity: "400",
        executed_quantity: "200",
        price: "58.00",
        executed_price: "57.90",
        submitted_at: "2025-01-15T01:00:00Z",
        currency: "HKD",
      },
      // Unfilled orders are ignored.
      {
        order_id: "order-4",
        status: "New",
        symbol: "700.HK",
        side: "Buy",
        submitted_quantity: "50",
        executed_quantity: "0",
        price: "300.00",
        executed_price: null,
        submitted_at: "2025-07-01T01:00:00Z",
        currency: "HKD",
      },
      {
        order_id: "order-5",
        status: "Cancelled",
        symbol: "700.HK",
        side: "Sell",
        submitted_quantity: "50",
        executed_quantity: "0",
        price: "300.00",
        executed_price: null,
        submitted_at: "2025-07-02T01:00:00Z",
        currency: "HKD",
      },
    ],
  },
};

describe("parseHistoryOrders", () => {
  it("keeps only filled orders with Buy=+qty / Sell=−qty signing", () => {
    const trades = parseHistoryOrders(historyFixture.data);
    expect(trades).toHaveLength(3);

    // Buy filled: +qty, executed_price preferred.
    expect(trades[0]).toMatchObject({
      orderId: "order-1",
      symbol: "0700.HK",
      currency: "HKD",
      tradeDate: "20250304",
      quantity: 100,
      tradePrice: 319.5,
    });
    // Sell filled: −qty, executed_price null → falls back to price.
    expect(trades[1]).toMatchObject({
      orderId: "order-2",
      symbol: "AAPL",
      quantity: -10,
      tradePrice: 150,
    });
    // PartiallyFilled with executed qty > 0 is kept.
    expect(trades[2]).toMatchObject({
      orderId: "order-3",
      symbol: "0005.HK",
      quantity: 200,
      tradeDate: "20250115",
    });
  });
});

/* ---------------- live fetchers against a mock fetch ---------------- */

function mockFetcher(json: unknown, status = 200): { fetcher: FetchLike; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as FetchLike;
  return { fetcher, calls };
}

describe("fetchers", () => {
  it("getStockPositions signs the request and parses the envelope", async () => {
    const { fetcher, calls } = mockFetcher(stockFixture);
    const positions = await getStockPositions("k", "s", "t", fetcher);
    expect(positions).toHaveLength(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://openapi.longbridge.com/v1/asset/stock");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(
      /^HMAC-SHA256 SignedHeaders=authorization;x-api-key;x-timestamp, Signature=[0-9a-f]{64}$/,
    );
    expect(headers.authorization).toBe("t");
    expect(headers["x-api-key"]).toBe("k");
    expect(headers["x-timestamp"]).toMatch(/^\d+$/);
  });

  it("getHistoryOrders puts the raw query string in the URL", async () => {
    const { fetcher, calls } = mockFetcher(historyFixture);
    const trades = await getHistoryOrders(
      "k",
      "s",
      "t",
      new Date("2025-01-01T00:00:00Z"),
      new Date("2026-01-01T00:00:00Z"),
      fetcher,
    );
    expect(trades).toHaveLength(3);
    expect(calls[0]!.url).toContain("/v1/trade/order/history?start_at=");
    expect(calls[0]!.url).toContain("end_at=");
  });

  it("getAccountBalance parses per-currency balances", async () => {
    const { fetcher } = mockFetcher({
      code: 0,
      message: "ok",
      data: {
        list: [
          { account_channel: "HK", currency: "HKD", total_cash: "1000.50", net_assets: "5200.25", buy_power: "1000.50" },
          { account_channel: "US", currency: "USD", total_cash: "0", net_assets: "0", buy_power: "0" },
        ],
      },
    });
    const balances = await getAccountBalance("k", "s", "t", fetcher);
    expect(balances).toHaveLength(2);
    expect(balances[0]).toMatchObject({
      accountChannel: "HK",
      currency: "HKD",
      totalCash: 1000.5,
      netAssets: 5200.25,
      buyPower: 1000.5,
    });
  });

  it("throws LongbridgeError when the envelope code is not 0", async () => {
    const { fetcher } = mockFetcher({ code: 40001, message: "invalid access token" });
    await expect(getStockPositions("k", "s", "t", fetcher)).rejects.toThrow(LongbridgeError);
    await expect(getStockPositions("k", "s", "t", fetcher)).rejects.toThrow(/40001/);
  });

  it("throws on HTTP errors without leaking credentials", async () => {
    const { fetcher } = mockFetcher({ code: 1, message: "nope" }, 401);
    let err: unknown = null;
    try {
      await getStockPositions("sekret-key", "sekret-secret", "sekret-token", fetcher);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LongbridgeError);
    const message = (err as LongbridgeError).message;
    expect(message).toContain("401");
    expect(message).not.toContain("sekret-key");
    expect(message).not.toContain("sekret-secret");
    expect(message).not.toContain("sekret-token");
  });

  it("network failures surface as LongbridgeError", async () => {
    const failing = (async () => {
      throw new Error("boom");
    }) as unknown as FetchLike;
    const spy = vi.fn(failing);
    await expect(getStockPositions("k", "s", "t", spy)).rejects.toThrow(LongbridgeError);
  });
});
