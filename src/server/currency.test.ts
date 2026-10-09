import { describe, expect, it } from "vitest";

import {
  canonicalSymbol,
  inferCurrency,
  isForexSymbol,
  isHkCode,
  toUsd,
} from "~/server/currency";

describe("isHkCode", () => {
  it("treats pure numeric symbols as HKEX", () => {
    expect(isHkCode("2225")).toBe(true);
    expect(isHkCode("0700")).toBe(true);
    expect(isHkCode("5")).toBe(true);
  });
  it("treats .HK-suffixed numerics as HKEX (not USD)", () => {
    expect(isHkCode("2225.HK")).toBe(true);
    expect(isHkCode("0700.HK")).toBe(true);
    expect(inferCurrency("2225.HK")).toBe("HKD");
  });
  it("rejects US symbols", () => {
    expect(isHkCode("AAPL")).toBe(false);
    expect(isHkCode("NVTS")).toBe(false);
    expect(isHkCode("BRK.B")).toBe(false);
  });
});

describe("inferCurrency", () => {
  it("returns HKD for HKEX numeric codes", () => {
    expect(inferCurrency("2225")).toBe("HKD");
    expect(inferCurrency("0700")).toBe("HKD");
  });
  it("returns USD for everything else", () => {
    expect(inferCurrency("AAPL")).toBe("USD");
    expect(inferCurrency("NVTS")).toBe("USD");
    expect(inferCurrency("")).toBe("USD");
  });
});

describe("isForexSymbol", () => {
  it("matches IBKR currency-conversion pseudo-symbols", () => {
    expect(isForexSymbol("USD.HKD")).toBe(true);
    expect(isForexSymbol("EUR.USD")).toBe(true);
    expect(isForexSymbol("usd.hkd")).toBe(true);
    expect(isForexSymbol(" USD.HKD ")).toBe(true);
  });
  it("rejects real tickers", () => {
    expect(isForexSymbol("AAPL")).toBe(false);
    expect(isForexSymbol("BRK.B")).toBe(false); // 1-letter suffix
    expect(isForexSymbol("0700.HK")).toBe(false); // numeric prefix
    expect(isForexSymbol("700")).toBe(false);
    expect(isForexSymbol("")).toBe(false);
  });
});

describe("toUsd", () => {
  const rates = { hkd: 7.8, cny: 7.2 };
  it("passes USD through", () => {
    expect(toUsd(100, "USD", rates)).toBe(100);
    expect(toUsd(100, null, rates)).toBe(100);
  });
  it("converts HKD to USD", () => {
    expect(toUsd(780, "HKD", rates)).toBeCloseTo(100, 5);
  });
  it("falls back to as-is when no rate", () => {
    expect(toUsd(100, "EUR", rates)).toBe(100);
    expect(toUsd(100, "HKD", {})).toBe(100);
  });
});

describe("canonicalSymbol", () => {
  it("unifies IBKR bare codes with manual/Yahoo .HK form", () => {
    expect(canonicalSymbol("0700.HK")).toBe("700");
    expect(canonicalSymbol("700")).toBe("700");
    expect(canonicalSymbol("0700")).toBe("700");
    expect(canonicalSymbol("2225.HK")).toBe("2225");
  });
  it("leaves US symbols untouched", () => {
    expect(canonicalSymbol("AAPL")).toBe("AAPL");
    expect(canonicalSymbol("BRK.B")).toBe("BRK.B");
    expect(canonicalSymbol("USD.HKD")).toBe("USD.HKD");
  });
  it("trims and uppercases", () => {
    expect(canonicalSymbol(" 0700.hk ")).toBe("700");
  });
});
