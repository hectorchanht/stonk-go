import { describe, expect, it } from "vitest";
import { formatMoney, formatMoneyCompact } from "./money";

describe("formatMoney", () => {
  it("shows whole units with no decimals", () => {
    expect(formatMoney(1305279.62, "HKD")).toBe("HK$1,305,280");
    expect(formatMoney(614002.32, "HKD")).toBe("HK$614,002");
    expect(formatMoney(-691277.62, "HKD")).toBe("-HK$691,278");
    expect(formatMoney(2763.86, "HKD")).toBe("HK$2,764");
  });

  it("rounds half up at display time", () => {
    expect(formatMoney(0.5, "USD")).toBe("$1");
    expect(formatMoney(2.4, "USD")).toBe("$2");
  });

  it("keeps the sign option", () => {
    expect(formatMoney(100.4, "USD", null, { sign: true })).toBe("+$100");
    expect(formatMoney(-100.4, "USD", null, { sign: true })).toBe("-$100");
  });

  it("converts with FX rates before rounding", () => {
    // 100 USD at 7.8 HKD/USD = 780 HKD exactly
    expect(formatMoney(100, "HKD", { hkd: 7.8 })).toBe("HK$780");
  });
});

describe("formatMoneyCompact", () => {
  it("uses compact notation with at most one fraction digit", () => {
    expect(formatMoneyCompact(1098643.28, "HKD")).toBe("HK$1.1M");
    expect(formatMoneyCompact(941694.24, "HKD")).toBe("HK$941.7K");
    expect(formatMoneyCompact(784745.2, "HKD")).toBe("HK$784.7K");
    expect(formatMoneyCompact(614188.39, "HKD")).toBe("HK$614.2K");
  });

  it("handles negatives and small values", () => {
    expect(formatMoneyCompact(-250000, "HKD")).toBe("-HK$250K");
    expect(formatMoneyCompact(999, "HKD")).toBe("HK$999");
    expect(formatMoneyCompact(0, "HKD")).toBe("HK$0");
  });

  it("respects the currency code", () => {
    expect(formatMoneyCompact(1234567.89, "USD")).toBe("$1.2M");
  });
});
