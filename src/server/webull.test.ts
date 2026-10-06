/**
 * Unit tests for the Webull OpenAPI client.
 *
 * The signature tests use Webull's OFFICIAL worked example from
 * developer.webull.com (the "Signature" documentation page), which publishes
 * every intermediate value plus the expected signature
 * `kvlS6opdZDhEBo5jq40nHYXaLvM=`. If this test passes, the MD5 / SHA-1 /
 * HMAC-SHA1 / base64 / percent-encoding chain is correct end to end.
 *
 * Run: npx vitest run src/server/webull.test.ts
 */
import { describe, expect, it } from "vitest";

import {
  WebullError,
  buildSignString,
  getAccountList,
  getBalance,
  normalizeWebullSymbol,
  parseAccountList,
  parseBalance,
  parseDecimal,
  parseOrderHistory,
  parsePositions,
  signWebullRequest,
  type FetchLike,
} from "./webull";

/* ---------------- signature ---------------- */

// Webull's official worked example (docs' "Signature" page).
const VECTOR = {
  appKey: "776da210ab4a452795d74e726ebd74b6",
  appSecret: "0f50a2e853334a9aae1a783bee120c1f",
  uri: "/trade/place_order",
  query: { a1: "webull", a2: "123", a3: "xxx", q1: "yyy" },
  headers: {
    "x-app-key": "776da210ab4a452795d74e726ebd74b6",
    "x-timestamp": "2022-01-04T03:55:31Z",
    "x-signature-version": "1.0",
    "x-signature-algorithm": "HMAC-SHA1",
    "x-signature-nonce": "48ef5afed43d4d91ae514aaeafbc29ba",
    host: "api.webull.com",
  },
  body: '{"k1":123,"k2":"this is the api request body","k3":true,"k4":{"foo":[1,2]}}',
  signString:
    "/trade/place_order&a1=webull&a2=123&a3=xxx&host=api.webull.com&q1=yyy&x-app-key=776da210ab4a452795d74e726ebd74b6&x-signature-algorithm=HMAC-SHA1&x-signature-nonce=48ef5afed43d4d91ae514aaeafbc29ba&x-signature-version=1.0&x-timestamp=2022-01-04T03:55:31Z&E296C96787E1A309691CEF3692F5EEDD",
  signature: "kvlS6opdZDhEBo5jq40nHYXaLvM=",
};

describe("buildSignString", () => {
  it("reproduces the official worked-example sign string exactly", () => {
    const signedParams = { ...VECTOR.query, ...VECTOR.headers };
    expect(buildSignString(VECTOR.uri, signedParams, VECTOR.body)).toBe(
      VECTOR.signString,
    );
  });

  it("sorts params by key and keeps header values verbatim", () => {
    const s = buildSignString("/openapi/assets/positions", {
      "x-timestamp": "2022-01-04T03:55:31Z",
      "x-app-key": "k",
      host: "api.webull.com",
      account_id: "123",
      "x-signature-algorithm": "HMAC-SHA1",
      "x-signature-nonce": "n",
      "x-signature-version": "1.0",
    }, "");
    expect(s).toBe(
      "/openapi/assets/positions&account_id=123&host=api.webull.com&x-app-key=k&x-signature-algorithm=HMAC-SHA1&x-signature-nonce=n&x-signature-version=1.0&x-timestamp=2022-01-04T03:55:31Z",
    );
  });

  it("omits the body hash entirely when the body is empty (per official docs)", () => {
    const s = buildSignString("/openapi/account/list", { host: "api.webull.com" }, "");
    expect(s).toBe("/openapi/account/list&host=api.webull.com");
    expect(s).not.toContain("D41D8CD98F00B204E9800998ECF8427E");
  });
});

describe("signWebullRequest", () => {
  it("reproduces the official worked-example signature", () => {
    const { signature } = signWebullRequest(
      VECTOR.appKey,
      VECTOR.appSecret,
      "POST",
      VECTOR.uri,
      VECTOR.query,
      VECTOR.body,
      VECTOR.headers["x-timestamp"],
      VECTOR.headers["x-signature-nonce"],
    );
    expect(signature).toBe(VECTOR.signature);
  });

  it("is deterministic given the same inputs", () => {
    const mk = () =>
      signWebullRequest(
        "key",
        "secret",
        "GET",
        "/openapi/account/list",
        {},
        "",
        "2026-10-06T14:00:00Z",
        "9b2f3c4d-0000-4000-8000-123456789abc",
      );
    const a = mk();
    const b = mk();
    expect(a.signature).toBe(b.signature);
    expect(a.headers).toEqual(b.headers);
  });

  it("emits the full signed header set with HMAC-SHA1 declared", () => {
    const { headers, signature } = signWebullRequest(
      "mykey",
      "mysecret",
      "GET",
      "/openapi/assets/positions",
      { account_id: "42" },
      "",
      "2026-10-06T14:00:00Z",
      "nonce-1",
    );
    expect(headers["x-app-key"]).toBe("mykey");
    expect(headers["x-signature"]).toBe(signature);
    expect(headers["x-signature-algorithm"]).toBe("HMAC-SHA1");
    expect(headers["x-signature-version"]).toBe("1.0");
    expect(headers["x-signature-nonce"]).toBe("nonce-1");
    expect(headers["x-timestamp"]).toBe("2026-10-06T14:00:00Z");
    expect(headers.host).toBe("api.webull.com");
    // 20-byte HMAC-SHA1 digest -> 28 base64 chars ending in "="
    expect(signature).toMatch(/^[A-Za-z0-9+/]{27}=$/);
    expect(Buffer.from(signature, "base64")).toHaveLength(20);
  });

  it("differs when the secret differs", () => {
    const mk = (secret: string) =>
      signWebullRequest(
        "key",
        secret,
        "GET",
        "/openapi/account/list",
        {},
        "",
        "2026-10-06T14:00:00Z",
        "nonce-1",
      );
    expect(mk("secret-a").signature).not.toBe(mk("secret-b").signature);
  });
});

/* ---------------- parsing ---------------- */

describe("parseDecimal", () => {
  it("kills float repr artifacts and fails loudly on malformed input", () => {
    expect(parseDecimal("0.30000000000000004", "v")).toBe(0.3);
    expect(parseDecimal("", "v")).toBeNull();
    expect(parseDecimal(null, "v")).toBeNull();
    expect(() => parseDecimal("lots", "quantity")).toThrow(WebullError);
  });
});

describe("normalizeWebullSymbol", () => {
  it("uppercases and trims", () => {
    expect(normalizeWebullSymbol("  aapl ")).toBe("AAPL");
    expect(normalizeWebullSymbol("700.hk")).toBe("700.HK");
  });
});

describe("parseAccountList", () => {
  const bare = [
    { account_id: "A1", account_type: "CASH" },
    { account_id: "A2" },
  ];
  it("parses a bare array", () => {
    expect(parseAccountList(bare)).toEqual([
      { accountId: "A1", accountType: "CASH" },
      { accountId: "A2", accountType: null },
    ]);
  });
  it("parses a {data:[...]} envelope", () => {
    expect(parseAccountList({ data: bare })).toEqual([
      { accountId: "A1", accountType: "CASH" },
      { accountId: "A2", accountType: null },
    ]);
  });
  it("throws WebullError when account_id is missing", () => {
    expect(() => parseAccountList([{ account_type: "CASH" }])).toThrow(WebullError);
  });
});

describe("parseBalance", () => {
  it("parses decimal strings defensively", () => {
    expect(
      parseBalance({
        total_cash_balance: "1234.56",
        total_market_value: "7890.12",
        total_net_liquidation_value: "9124.68",
        currency: "USD",
      }),
    ).toEqual({
      totalCashBalance: 1234.56,
      totalMarketValue: 7890.12,
      totalNetLiquidationValue: 9124.68,
      currency: "USD",
    });
  });
  it("parses a {data:{...}} envelope and tolerates missing fields", () => {
    expect(parseBalance({ data: { currency: "HKD" } })).toEqual({
      totalCashBalance: null,
      totalMarketValue: null,
      totalNetLiquidationValue: null,
      currency: "HKD",
    });
  });
});

describe("parsePositions", () => {
  const fixture = [
    {
      symbol: "AAPL",
      quantity: "10.5",
      cost_price: "150.25",
      instrument_type: "EQUITY",
      currency: "USD",
    },
    { symbol: "700.HK", quantity: "100", cost_price: "320.40" },
  ];
  it("parses a bare array", () => {
    expect(parsePositions(fixture)).toEqual([
      {
        symbol: "AAPL",
        quantity: 10.5,
        costPrice: 150.25,
        instrumentType: "EQUITY",
        currency: "USD",
      },
      {
        symbol: "700.HK",
        quantity: 100,
        costPrice: 320.4,
        instrumentType: null,
        currency: null,
      },
    ]);
  });
  it("parses a {data:[...]} envelope", () => {
    expect(parsePositions({ data: fixture })).toHaveLength(2);
  });
  it("throws WebullError on a malformed quantity", () => {
    expect(() =>
      parsePositions([{ symbol: "AAPL", quantity: "lots" }]),
    ).toThrow(WebullError);
  });
});

describe("parseOrderHistory", () => {
  const fixture = [
    {
      client_order_id: "o1",
      symbol: "AAPL",
      side: "BUY",
      status: "FILLED",
      filled_quantity: "10",
      filled_price: "150.50",
      quantity: "10",
      create_time: "2026-09-01T14:30:00.000Z",
      currency: "USD",
    },
    {
      client_order_id: "o2",
      symbol: "AAPL",
      side: "SELL",
      status: "FILLED",
      filled_quantity: "4",
      avg_price: "160.00",
      quantity: "4",
      create_time: "2026-09-15 10:00:00",
    },
    {
      client_order_id: "o3",
      symbol: "TSLA",
      side: "BUY",
      status: "PARTIALLY_FILLED",
      filled_quantity: "2.5",
      filled_price: "200",
      create_time: "2026-08-01T09:00:00Z",
    },
    // Excluded: not filled
    { client_order_id: "o4", symbol: "TSLA", side: "BUY", status: "PENDING", filled_quantity: "5", create_time: "2026-08-02T09:00:00Z" },
    { client_order_id: "o5", symbol: "TSLA", side: "BUY", status: "CANCELLED", filled_quantity: "0", create_time: "2026-08-03T09:00:00Z" },
    // Excluded: filled status but nothing filled
    { client_order_id: "o6", symbol: "TSLA", side: "BUY", status: "FILLED", filled_quantity: "0", create_time: "2026-08-04T09:00:00Z" },
    // Excluded: unknown side
    { client_order_id: "o7", symbol: "TSLA", side: "SHORT", status: "FILLED", filled_quantity: "1", create_time: "2026-08-05T09:00:00Z" },
  ];

  it("maps buys positive / sells negative and filters to filled orders only", () => {
    const trades = parseOrderHistory(fixture);
    expect(trades).toHaveLength(3);
    expect(trades[0]).toMatchObject({
      symbol: "AAPL",
      side: "BUY",
      tradeDate: "20260901",
      quantity: 10,
      tradePrice: 150.5,
      currency: "USD",
      orderId: "o1",
    });
    expect(trades[1]).toMatchObject({
      symbol: "AAPL",
      side: "SELL",
      tradeDate: "20260915",
      quantity: -4,
      // filled_price missing -> falls back to avg_price
      tradePrice: 160,
      currency: null,
    });
    expect(trades[2]).toMatchObject({
      symbol: "TSLA",
      quantity: 2.5,
      tradeDate: "20260801",
    });
  });

  it("accepts a {data:[...]} envelope", () => {
    expect(parseOrderHistory({ data: fixture })).toHaveLength(3);
  });

  it("keeps trades with unparseable dates but nulls the tradeDate", () => {
    const trades = parseOrderHistory([
      {
        symbol: "AAPL",
        side: "BUY",
        status: "FILLED",
        filled_quantity: "1",
        create_time: "not-a-date",
      },
    ]);
    expect(trades).toHaveLength(1);
    expect(trades[0]!.tradeDate).toBeNull();
  });
});

/* ---------------- fetch layer ---------------- */

const CREDS = { appKey: "key", appSecret: "secret" };

function okFetcher(json: unknown): FetchLike {
  return async () => ({ ok: true, status: 200, json: async () => json });
}

describe("signed GET endpoints", () => {
  it("getAccountList surfaces the parsed accounts", async () => {
    const accounts = await getAccountList(
      CREDS,
      undefined,
      okFetcher([{ account_id: "A1", account_type: "MARGIN" }]),
    );
    expect(accounts).toEqual([{ accountId: "A1", accountType: "MARGIN" }]);
  });

  it("throws WebullError on network failure", async () => {
    const failing: FetchLike = async () => {
      throw new Error("boom");
    };
    await expect(getAccountList(CREDS, undefined, failing)).rejects.toThrow(
      WebullError,
    );
  });

  it("throws WebullError with the API message capped at 200 chars (no credentials)", async () => {
    const longMessage = "x".repeat(300);
    const errFetcher: FetchLike = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error_code: "INCORRECT_SIGN", message: longMessage }),
    });
    const err = await getAccountList(CREDS, undefined, errFetcher).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WebullError);
    const msg = (err as WebullError).message;
    expect(msg).toContain("INCORRECT_SIGN");
    expect(msg).toContain("x".repeat(200));
    expect(msg).not.toContain("x".repeat(201));
    expect(msg).not.toContain("secret");
    expect(msg).not.toContain("mykey");
  });

  it("getBalance requires an accountId", async () => {
    await expect(getBalance(CREDS, undefined, okFetcher({}))).rejects.toThrow(
      WebullError,
    );
  });
});
