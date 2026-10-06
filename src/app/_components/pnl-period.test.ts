import { describe, expect, it } from "vitest";
import {
  PNL_PERIODS,
  parsePnlPeriodKey,
  pnlForPeriod,
  pnlPeriodDays,
  shortDate,
  type PnlPoint,
} from "./pnl-period";

// Trading-day series (weekdays only), ascending, values in USD.
const POINTS: PnlPoint[] = [
  { date: "2026-09-28", value: 30000 }, // Mon
  { date: "2026-09-29", value: 30500 },
  { date: "2026-09-30", value: 29800 },
  { date: "2026-10-01", value: 31000 },
  { date: "2026-10-02", value: 31200 }, // Fri
  // weekend: no points for 10-03 / 10-04
  { date: "2026-10-05", value: 31500 }, // Mon
  { date: "2026-10-06", value: 32000 }, // Tue (today)
];

const TODAY = "2026-10-06";

describe("pnlForPeriod", () => {
  it("computes 1D P/L vs yesterday's value", () => {
    const r = pnlForPeriod(POINTS, 32000, 1, TODAY);
    expect(r).toEqual({ pnl: 500, compareDate: "2026-10-05", clamped: false });
  });

  it("lands on the nearest earlier trading day across a weekend", () => {
    // 3 days back from Tue 10-06 is Sat 10-03 → nearest earlier point is Fri 10-02.
    const r = pnlForPeriod(POINTS, 32000, 3, TODAY);
    expect(r).toEqual({ pnl: 800, compareDate: "2026-10-02", clamped: false });
  });

  it("computes 1W P/L", () => {
    // 7 days back from 10-06 is 09-29.
    const r = pnlForPeriod(POINTS, 32000, 7, TODAY);
    expect(r).toEqual({ pnl: 1500, compareDate: "2026-09-29", clamped: false });
  });

  it("clamps to the earliest point when N exceeds history", () => {
    const r = pnlForPeriod(POINTS, 32000, 30, TODAY);
    expect(r).toEqual({ pnl: 2000, compareDate: "2026-09-28", clamped: true });
  });

  it("returns null for an empty series", () => {
    expect(pnlForPeriod([], 32000, 7, TODAY)).toBeNull();
  });

  it("returns null for a non-finite current value", () => {
    expect(pnlForPeriod(POINTS, NaN, 7, TODAY)).toBeNull();
  });

  it("handles a same-day target (0 days) by using today's point", () => {
    const r = pnlForPeriod(POINTS, 32000, 0, TODAY);
    expect(r).toEqual({ pnl: 0, compareDate: "2026-10-06", clamped: false });
  });

  it("handles negative P/L", () => {
    const r = pnlForPeriod(POINTS, 29000, 1, TODAY);
    expect(r!.pnl).toBe(-2500);
    expect(r!.compareDate).toBe("2026-10-05");
  });
});

describe("parsePnlPeriodKey", () => {
  it("accepts the four known keys", () => {
    for (const p of PNL_PERIODS) expect(parsePnlPeriodKey(p.key)).toBe(p.key);
  });
  it("falls back to 1D for garbage", () => {
    expect(parsePnlPeriodKey("9Y")).toBe("1D");
    expect(parsePnlPeriodKey(null)).toBe("1D");
    expect(parsePnlPeriodKey(undefined)).toBe("1D");
  });
});

describe("pnlPeriodDays", () => {
  it("maps keys to day counts", () => {
    expect(pnlPeriodDays("1D")).toBe(1);
    expect(pnlPeriodDays("1W")).toBe(7);
    expect(pnlPeriodDays("2W")).toBe(14);
    expect(pnlPeriodDays("1M")).toBe(30);
  });
});

describe("shortDate", () => {
  it("formats YYYY-MM-DD as 'Mon D' without timezone shift", () => {
    expect(shortDate("2026-08-05")).toBe("Aug 5");
    expect(shortDate("2026-01-01")).toBe("Jan 1");
    expect(shortDate("2026-12-31")).toBe("Dec 31");
  });
});
