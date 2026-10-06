import { describe, expect, it } from "vitest";

import {
  buildInvestedCurve,
  downsamplePoints,
  buildDailyHoldings,
  aggregateDailyValue,
  latestBarOnOrBefore,
} from "./performance";

const d = (iso: string) => new Date(`${iso}T12:00:00`);
const DAY_MS = 86_400_000;

describe("buildInvestedCurve", () => {
  it("returns [] with no flows", () => {
    expect(buildInvestedCurve([], 1000)).toEqual([]);
    expect(
      buildInvestedCurve([{ date: d("2026-09-01"), amount: NaN }], 1000),
    ).toEqual([]);
  });

  it("builds a staircase from buys and ends at the live value", () => {
    const pts = buildInvestedCurve(
      [
        { date: d("2026-09-01"), amount: -1000 },
        { date: d("2026-09-10"), amount: -500 },
      ],
      1800,
    );
    expect(pts.length).toBeGreaterThanOrEqual(2);
    expect(pts[0]).toEqual({ date: "2026-09-01", value: 1000 });
    expect(pts.find((p) => p.date === "2026-09-10")).toEqual({
      date: "2026-09-10",
      value: 1500,
    });
    const last = pts[pts.length - 1]!;
    expect(last.value).toBe(1800); // live value, not the invested figure
    expect(last.date).toBe(new Date().toLocaleDateString("en-CA"));
  });

  it("sells reduce the invested figure", () => {
    const pts = buildInvestedCurve(
      [
        { date: d("2026-09-01"), amount: -1000 },
        { date: d("2026-09-05"), amount: 400 },
      ],
      700,
    );
    expect(pts.find((p) => p.date === "2026-09-05")).toEqual({
      date: "2026-09-05",
      value: 600,
    });
  });

  it("flows before the window still count toward the first point", () => {
    const pts = buildInvestedCurve(
      [{ date: d("2026-01-01"), amount: -1000 }],
      1100,
      { startDaysAgo: 30 },
    );
    const cutoff = new Date(Date.now() - 30 * DAY_MS).toLocaleDateString(
      "en-CA",
    );
    expect(pts[0]!.date).toBe(cutoff);
    expect(pts[0]!.value).toBe(1000);
  });

  it("a single recent buy still yields a renderable 2-point curve", () => {
    const yesterday = new Date(Date.now() - DAY_MS);
    const pts = buildInvestedCurve(
      [{ date: yesterday, amount: -250 }],
      260,
    );
    expect(pts.length).toBe(2);
    expect(pts[0]!.value).toBe(250);
    expect(pts[1]!.value).toBe(260);
  });

  it("downsamples long series but keeps the live endpoint", () => {
    const flows = Array.from({ length: 400 }, (_, i) => ({
      date: new Date(Date.now() - (400 - i) * DAY_MS),
      amount: -10,
    }));
    const pts = buildInvestedCurve(flows, 5000);
    expect(pts.length).toBeLessThanOrEqual(180);
    expect(pts[pts.length - 1]!.value).toBe(5000);
  });
});

describe("downsamplePoints", () => {
  it("keeps short lists intact and always keeps the last point", () => {
    expect(downsamplePoints([1, 2, 3], 180)).toEqual([1, 2, 3]);
    const slim = downsamplePoints(Array.from({ length: 1000 }, (_, i) => i), 180);
    expect(slim.length).toBeLessThanOrEqual(180);
    expect(slim[slim.length - 1]).toBe(999);
  });
});

describe("buildDailyHoldings", () => {
  const fx = (_date: string, currency: string) =>
    currency === "HKD" ? 1 / 7.8 : 1;
  const trades = [
    {
      symbol: "AAPL",
      type: "BUY",
      quantity: 10,
      price: 100,
      fees: null,
      executedAt: new Date("2026-10-01T15:30:00Z"),
    },
    {
      symbol: "2225",
      type: "BUY",
      quantity: 100,
      price: 50,
      fees: 10,
      executedAt: new Date("2026-10-02T08:00:00Z"),
    },
    {
      symbol: "AAPL",
      type: "SELL",
      quantity: 5,
      price: 120,
      fees: 1,
      executedAt: new Date("2026-10-03T15:30:00Z"),
    },
  ];

  it("walks quantities and the invested baseline day by day", () => {
    const days = buildDailyHoldings(trades, fx);
    expect(days[0]!.date).toBe("2026-10-01");
    expect(days[0]!.qtyBySymbol).toEqual({ AAPL: 10 });
    expect(days[0]!.invested).toBeCloseTo(1000, 6);

    const d2 = days.find((x) => x.date === "2026-10-02")!;
    expect(d2.qtyBySymbol).toEqual({ AAPL: 10, "2225": 100 });
    // 1000 + (100*50 + 10) / 7.8
    expect(d2.invested).toBeCloseTo(1000 + 5010 / 7.8, 6);

    const d3 = days.find((x) => x.date === "2026-10-03")!;
    expect(d3.qtyBySymbol).toEqual({ AAPL: 5, "2225": 100 });
    // sell removes (5*120 − 1) = 599
    expect(d3.invested).toBeCloseTo(1000 + 5010 / 7.8 - 599, 6);
  });

  it("emits every day through today and repeats state on quiet days", () => {
    const days = buildDailyHoldings(trades, fx);
    const today = new Date().toISOString().slice(0, 10);
    expect(days[days.length - 1]!.date).toBe(today);
    const quiet = days.find((x) => x.date === "2026-10-04")!;
    expect(quiet.qtyBySymbol).toEqual({ AAPL: 5, "2225": 100 });
  });

  it("returns [] with no usable trades", () => {
    expect(buildDailyHoldings([], fx)).toEqual([]);
  });
});

describe("aggregateDailyValue", () => {
  const fx = () => 1;
  const days = [
    { date: "2024-01-08", qtyBySymbol: { AAPL: 10 }, invested: 1000 },
    // 2024-01-09 has no bar → forward-fills from 01-08
    { date: "2024-01-09", qtyBySymbol: { AAPL: 10 }, invested: 1000 },
    { date: "2024-01-10", qtyBySymbol: { AAPL: 10 }, invested: 1000 },
  ];
  const closes = {
    AAPL: [
      { date: "2024-01-08", close: 100, adjclose: 95 },
      // null adjclose → falls back to close
      { date: "2024-01-10", close: 110, adjclose: null },
    ],
  };

  it("prices qty × adjclose and forward-fills gaps", () => {
    const { priced, missingSymbols } = aggregateDailyValue(days, closes, fx);
    expect(priced.map((p) => p.value)).toEqual([950, 950, 1100]);
    expect(missingSymbols).toEqual([]);
  });

  it("reports symbols with no usable bars instead of zeroing them", () => {
    const { priced, missingSymbols } = aggregateDailyValue(
      [{ date: "2024-01-10", qtyBySymbol: { NOPE: 5 }, invested: 0 }],
      {},
      fx,
    );
    expect(priced[0]!.value).toBe(0);
    expect(missingSymbols).toEqual(["NOPE"]);
  });
});

describe("latestBarOnOrBefore", () => {
  const bars = [
    { date: "2024-01-08", close: 1, adjclose: 1 },
    { date: "2024-01-10", close: 2, adjclose: 2 },
  ];
  it("picks the latest bar on or before the date", () => {
    expect(latestBarOnOrBefore(bars, "2024-01-09")!.date).toBe("2024-01-08");
    expect(latestBarOnOrBefore(bars, "2024-01-10")!.date).toBe("2024-01-10");
    expect(latestBarOnOrBefore(bars, "2024-01-07")).toBeNull();
  });
});
