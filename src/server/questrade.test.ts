import { describe, it, expect, vi, afterEach } from "vitest";

import {
  parseDecimal,
  exchangeRefreshToken,
  parseAccountsResponse,
  parsePositionsResponse,
  parseBalancesResponse,
  parseActivitiesResponse,
  toYmd,
  activityToTrade,
  activityToCashFlow,
  reconcileAccount,
  type QtPosition,
  type QtBalance,
} from "./questrade";

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetchOnce(json: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(json),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/* ---------------- parseDecimal ---------------- */

describe("parseDecimal", () => {
  it("parses strings and numbers", () => {
    expect(parseDecimal("10.5")).toBe(10.5);
    expect(parseDecimal(10.5)).toBe(10.5);
    expect(parseDecimal("-3")).toBe(-3);
    expect(parseDecimal("0")).toBe(0);
  });
  it("returns null for missing/empty", () => {
    expect(parseDecimal(null)).toBeNull();
    expect(parseDecimal(undefined)).toBeNull();
    expect(parseDecimal("")).toBeNull();
    expect(parseDecimal("   ")).toBeNull();
  });
  it("kills float repr drift without float arithmetic", () => {
    // 0.1 + 0.2 in float land
    expect(parseDecimal(0.30000000000000004)).toBe(0.3);
    expect(parseDecimal("0.30000000000000004")).toBe(0.3);
    expect(parseDecimal("123.456789012345678")).toBe(123.4567890123);
  });
  it("round-trips half-up on strings", () => {
    expect(parseDecimal("2.5")).toBe(2.5);
    expect(parseDecimal("99.995")).toBe(99.995);
  });
  it("throws on malformed input instead of silently coercing", () => {
    expect(() => parseDecimal("abc")).toThrow();
    expect(() => parseDecimal("12.34.56")).toThrow();
    expect(() => parseDecimal("1e5")).toThrow();
    expect(() => parseDecimal("$10")).toThrow();
    expect(() => parseDecimal(NaN)).toThrow();
  });
});

/* ---------------- token exchange ---------------- */

describe("exchangeRefreshToken", () => {
  it("returns the ROTATED refresh token, access token and api server", async () => {
    const fetchMock = mockFetchOnce({
      access_token: "ACCESS123",
      refresh_token: "ROTATED456",
      api_server: "https://api01.iq.questrade.com/",
      expires_in: 1800,
      token_type: "Bearer",
    });
    const creds = await exchangeRefreshToken("MANUAL_TOKEN");
    expect(creds.accessToken).toBe("ACCESS123");
    // The rotated token must be persisted — never the one we sent.
    expect(creds.refreshToken).toBe("ROTATED456");
    expect(creds.refreshToken).not.toBe("MANUAL_TOKEN");
    expect(creds.apiServer).toBe("https://api01.iq.questrade.com/");
    expect(creds.expiresIn).toBe(1800);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url.startsWith("https://login.questrade.com/oauth2/token")).toBe(true);
    expect(url).toContain("grant_type=refresh_token");
    expect(url).toContain(encodeURIComponent("MANUAL_TOKEN"));
  });

  it("uses the practice login host when asked", async () => {
    const fetchMock = mockFetchOnce({
      access_token: "A",
      refresh_token: "B",
      api_server: "https://practicetest.iq.questrade.com/",
      expires_in: 1800,
    });
    await exchangeRefreshToken("T", { practice: true });
    expect(String(fetchMock.mock.calls[0]?.[0]).startsWith("https://practicelogin.questrade.com/")).toBe(true);
  });

  it("gives a clear hint on 401 (expired manual token)", async () => {
    mockFetchOnce({ code: 1017, message: "Token is invalid" }, false, 401);
    await expect(exchangeRefreshToken("STALE")).rejects.toThrow(/new manual authorization token/i);
  });
});

/* ---------------- accounts / positions / balances ---------------- */

describe("parseAccountsResponse", () => {
  it("parses accounts", () => {
    const accounts = parseAccountsResponse({
      accounts: [
        { number: "12345678", type: "Margin", status: "Active", isPrimary: true, isBilling: false, clientAccountType: "Individual" },
        { number: "87654321", type: "TFSA", status: "Active", isPrimary: false, isBilling: false, clientAccountType: "Individual" },
      ],
      userId: 12345,
    });
    expect(accounts.map((a) => a.number)).toEqual(["12345678", "87654321"]);
    expect(accounts[0]?.isPrimary).toBe(true);
  });
});

const POSITIONS_FIXTURE = {
  positions: [
    {
      symbol: "RY",
      symbolId: 27426,
      openQuantity: 10,
      closedQuantity: 0,
      currentMarketValue: 1587.5,
      currentPrice: 158.75,
      averageEntryPrice: 140.0,
      dayPnl: 12.5,
      openPnl: 187.5,
      closedPnl: 0,
      totalCost: 1400.0,
      valueInBaseCurrency: 1587.5,
      isRealTime: true,
      isUnderReorg: false,
    },
    {
      // Fractional US position
      symbol: "AAPL",
      symbolId: 8049,
      openQuantity: 2.5,
      closedQuantity: 0,
      currentMarketValue: 587.5,
      currentPrice: 235.0,
      averageEntryPrice: 200.0,
      dayPnl: -5.0,
      openPnl: 87.5,
      closedPnl: 0,
      totalCost: 500.0,
      valueInBaseCurrency: 801.12,
      isRealTime: true,
      isUnderReorg: false,
    },
  ],
};

describe("parsePositionsResponse", () => {
  it("maps fields exactly (market value ≠ cost basis ≠ quantity)", () => {
    const positions = parsePositionsResponse(POSITIONS_FIXTURE, "12345678");
    expect(positions).toHaveLength(2);
    const ry = positions[0]!;
    expect(ry.symbol).toBe("RY");
    expect(ry.openQuantity).toBe(10); // qty
    expect(ry.currentPrice).toBe(158.75); // valuation price
    expect(ry.currentMarketValue).toBe(1587.5); // market value
    expect(ry.averageEntryPrice).toBe(140.0); // cost basis per share
    expect(ry.totalCost).toBe(1400.0); // total cost — distinct from market value
    const aapl = positions[1]!;
    expect(aapl.openQuantity).toBe(2.5); // fractional
  });

  it("handles zero/empty positions", () => {
    expect(parsePositionsResponse({ positions: [] }, "1")).toEqual([]);
    const [p] = parsePositionsResponse(
      {
        positions: [
          { symbol: "XYZ", symbolId: 1, openQuantity: 0, currentMarketValue: 0, currentPrice: 0 },
        ],
      },
      "1",
    );
    expect(p?.openQuantity).toBe(0);
    expect(p?.currentMarketValue).toBe(0);
  });

  it("fails loudly on a missing quantity rather than inventing one", () => {
    expect(() =>
      parsePositionsResponse({ positions: [{ symbol: "XYZ", symbolId: 1 }] }, "1"),
    ).toThrow();
  });
});

describe("parseBalancesResponse", () => {
  it("keeps per-currency buckets separate", () => {
    const balances = parseBalancesResponse({
      perCurrencyBalances: [
        { currency: "CAD", cash: 1000.0, marketValue: 1587.5, totalEquity: 2587.5, buyingPower: 2000.0, isRealTime: true },
        { currency: "USD", cash: 250.0, marketValue: 587.5, totalEquity: 837.5, buyingPower: 500.0, isRealTime: true },
      ],
      combinedBalances: [],
      sodPerCurrencyBalances: [],
      sodCombinedBalances: [],
    });
    expect(balances).toHaveLength(2);
    expect(balances[0]).toMatchObject({ currency: "CAD", cash: 1000, marketValue: 1587.5, totalEquity: 2587.5 });
    expect(balances[1]).toMatchObject({ currency: "USD", cash: 250, marketValue: 587.5, totalEquity: 837.5 });
  });
});

/* ---------------- reconciliation ---------------- */

function qtPos(symbol: string, currency: string | null, marketValue: number): QtPosition {
  return {
    accountNumber: "12345678",
    symbol,
    symbolId: 1,
    openQuantity: 10,
    currentPrice: marketValue / 10,
    currentMarketValue: marketValue,
    averageEntryPrice: null,
    totalCost: null,
    openPnl: null,
    dayPnl: null,
    currency,
    assetCategory: "STK",
  };
}

function qtBal(currency: string, cash: number, marketValue: number): QtBalance {
  return { currency, cash, marketValue, totalEquity: cash + marketValue, buyingPower: null };
}

describe("reconcileAccount", () => {
  it("passes when positions sum to reported market value per currency", () => {
    const issues = reconcileAccount(
      "12345678",
      [qtPos("RY", "CAD", 1587.5), qtPos("TD", "CAD", 912.5), qtPos("AAPL", "USD", 587.5)],
      [qtBal("CAD", 1000, 2500), qtBal("USD", 250, 587.5)],
    );
    expect(issues).toEqual([]);
  });

  it("flags a positions-vs-balances mismatch with the diff", () => {
    const issues = reconcileAccount(
      "12345678",
      [qtPos("RY", "CAD", 1587.5)],
      [qtBal("CAD", 1000, 2500)], // reported 2500, we sum 1587.50
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe("positions-vs-balances");
    expect(issues[0]?.currency).toBe("CAD");
    expect(issues[0]?.diff).toBeCloseTo(912.5, 2);
  });

  it("flags Questrade-internal inconsistency (cash + mv ≠ total equity)", () => {
    const bad: QtBalance = { currency: "CAD", cash: 1000, marketValue: 2500, totalEquity: 9999, buyingPower: null };
    const issues = reconcileAccount("12345678", [qtPos("RY", "CAD", 2500)], [bad]);
    expect(issues.some((i) => i.kind === "balances-internal")).toBe(true);
  });

  it("tolerates cent-level rounding but not dollar-level drift", () => {
    // 3 positions each rounded to cents: worst-case drift 3 × $0.005
    const issues = reconcileAccount(
      "1",
      [qtPos("A", "CAD", 100.004), qtPos("B", "CAD", 200.004), qtPos("C", "CAD", 300.004)],
      [qtBal("CAD", 0, 600.01)],
    );
    expect(issues).toEqual([]);
    const bad = reconcileAccount("1", [qtPos("A", "CAD", 100)], [qtBal("CAD", 0, 105)]);
    expect(bad).toHaveLength(1);
  });

  it("reports unresolved-currency positions instead of dropping them silently", () => {
    const issues = reconcileAccount("1", [qtPos("RY", null, 100)], [qtBal("CAD", 0, 100)]);
    expect(issues.some((i) => i.kind === "unresolved-currency")).toBe(true);
  });

  it("never nets CAD against USD", () => {
    // CAD positions 1000 + USD positions 1000 must NOT reconcile against a
    // single 2000 bucket in one currency.
    const issues = reconcileAccount(
      "1",
      [qtPos("RY", "CAD", 1000), qtPos("AAPL", "USD", 1000)],
      [qtBal("CAD", 0, 2000)],
    );
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.currency === "USD")).toBe(true);
  });
});

/* ---------------- activities ---------------- */

const TRADE_BUY = {
  tradeDate: "2024-10-04T00:00:00.000000-04:00",
  transactionDate: "2024-10-04T00:00:00.000000-04:00",
  settlementDate: "2024-10-07T00:00:00.000000-04:00",
  action: "Buy",
  symbol: "RY",
  symbolId: 27426,
  description: "ROYAL BANK OF CANADA",
  currency: "CAD",
  quantity: 10,
  price: 158.75,
  grossAmount: 1587.5,
  commission: 4.95,
  netAmount: 1592.45,
  type: "Trades",
};

const DIVIDEND = {
  tradeDate: "2024-10-01T00:00:00.000000-04:00",
  transactionDate: "2024-10-01T00:00:00.000000-04:00",
  settlementDate: "2024-10-01T00:00:00.000000-04:00",
  action: "",
  symbol: "RY",
  symbolId: 27426,
  description: "DIVIDEND",
  currency: "CAD",
  quantity: 0,
  price: 0,
  grossAmount: 13.75,
  commission: 0,
  netAmount: 13.75,
  type: "Dividends",
};

describe("activities", () => {
  it("converts ISO tradeDate to YYYYMMDD", () => {
    expect(toYmd("2024-10-04T00:00:00.000000-04:00")).toBe("20241004");
  });

  it("signs buys positive and sells negative", () => {
    const buy = activityToTrade(parseActivitiesResponse({ activities: [TRADE_BUY] })[0]!, "1");
    expect(buy?.quantity).toBe(10);
    expect(buy?.tradePrice).toBe(158.75);
    expect(buy?.commission).toBe(4.95);
    expect(buy?.tradeDate).toBe("20241004");
    expect(buy?.currency).toBe("CAD");

    const sell = activityToTrade(
      parseActivitiesResponse({ activities: [{ ...TRADE_BUY, action: "Sell" }] })[0]!,
      "1",
    );
    expect(sell?.quantity).toBe(-10);
  });

  it("maps dividends to cash flows with native currency, not trades", () => {
    const acts = parseActivitiesResponse({ activities: [TRADE_BUY, DIVIDEND] });
    expect(acts).toHaveLength(2);
    const div = acts[1]!;
    expect(activityToTrade(div, "1")).toBeNull();
    const cf = activityToCashFlow(div, "1")!;
    expect(cf.type).toBe("Dividends");
    expect(cf.amount).toBe(13.75);
    expect(cf.currency).toBe("CAD");
    expect(cf.symbol).toBe("RY");
    // and the buy is not a cash flow
    expect(activityToCashFlow(acts[0]!, "1")).toBeNull();
  });

  it("handles empty activity lists", () => {
    expect(parseActivitiesResponse({ activities: [] })).toEqual([]);
  });
});
