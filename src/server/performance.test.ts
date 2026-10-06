import { describe, expect, it } from "vitest";

import {
  buildInvestedCurve,
  downsamplePoints,
  buildDailyHoldings,
  aggregateDailyValue,
  buildSourcedDailyHoldings,
  aggregateDailyValueBySource,
  bucketMonthly,
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

describe("buildSourcedDailyHoldings", () => {
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
      source: "ibkr",
    },
    {
      symbol: "AAPL",
      type: "BUY",
      quantity: 5,
      price: 110,
      fees: null,
      executedAt: new Date("2026-10-02T15:30:00Z"),
      source: "manual",
    },
    {
      symbol: "AAPL",
      type: "SELL",
      quantity: 4,
      price: 120,
      fees: 2,
      executedAt: new Date("2026-10-03T15:30:00Z"),
      source: "ibkr",
    },
  ];

  it("keeps quantities and invested separated by source", () => {
    const days = buildSourcedDailyHoldings(trades, fx);
    const d1 = days.find((x) => x.date === "2026-10-01")!;
    expect(d1.qtyBySource).toEqual({ ibkr: { AAPL: 10 } });
    expect(d1.investedBySource.ibkr).toBeCloseTo(1000, 6);
    expect(d1.investedBySource.manual ?? 0).toBe(0);

    const d2 = days.find((x) => x.date === "2026-10-02")!;
    expect(d2.qtyBySource.ibkr).toEqual({ AAPL: 10 });
    expect(d2.qtyBySource.manual).toEqual({ AAPL: 5 });
    expect(d2.investedBySource.manual).toBeCloseTo(550, 6);

    const d3 = days.find((x) => x.date === "2026-10-03")!;
    expect(d3.qtyBySource.ibkr).toEqual({ AAPL: 6 });
    // sell removes (4*120 − 2) = 478 from ibkr's invested
    expect(d3.investedBySource.ibkr).toBeCloseTo(1000 - 478, 6);
    // manual untouched by the ibkr sell
    expect(d3.investedBySource.manual).toBeCloseTo(550, 6);
  });

  it("normalizes source keys and returns [] with no usable trades", () => {
    expect(buildSourcedDailyHoldings([], fx)).toEqual([]);
    const days = buildSourcedDailyHoldings(
      [
        {
          symbol: "AAPL",
          type: "BUY",
          quantity: 1,
          price: 100,
          fees: null,
          executedAt: new Date("2026-10-01T15:30:00Z"),
          source: "  IBKR ",
        },
      ],
      fx,
    );
    expect(Object.keys(days[0]!.qtyBySource)).toEqual(["ibkr"]);
  });
});

describe("aggregateDailyValueBySource", () => {
  it("values each source separately and reports missing symbols once", () => {
    const fx = () => 1;
    const bars = {
      AAPL: [
        { date: "2026-10-01", close: 100, adjclose: 100 },
        { date: "2026-10-02", close: 110, adjclose: 110 },
      ],
    };
    const trades = [
      {
        symbol: "AAPL",
        type: "BUY",
        quantity: 10,
        price: 90,
        fees: null,
        executedAt: new Date("2026-10-01T15:30:00Z"),
        source: "ibkr",
      },
      {
        symbol: "MSFT",
        type: "BUY",
        quantity: 5,
        price: 200,
        fees: null,
        executedAt: new Date("2026-10-01T15:30:00Z"),
        source: "manual",
      },
    ];
    const days = buildSourcedDailyHoldings(trades, fx);
    const { perSource, missingSymbols } = aggregateDailyValueBySource(
      days,
      bars,
      fx,
    );
    // MSFT has no bars → reported, never silently zeroed in a way we hide
    expect(missingSymbols).toEqual(["MSFT"]);
    const ibkr = perSource.ibkr!.find((p) => p.date === "2026-10-02")!;
    expect(ibkr.value).toBeCloseTo(10 * 110, 6);
    expect(ibkr.invested).toBeCloseTo(900, 6);
    // manual's MSFT prices nothing (no bars) → 0 value, invested intact
    const manual = perSource.manual!.find((p) => p.date === "2026-10-02")!;
    expect(manual.value).toBe(0);
    expect(manual.invested).toBeCloseTo(1000, 6);
    // series are date-aligned across sources
    expect(perSource.ibkr!.length).toBe(perSource.manual!.length);
    expect(perSource.ibkr![0]!.date).toBe(perSource.manual![0]!.date);
  });
});

describe("bucketMonthly", () => {
  it("computes gain and % net of deposits", () => {
    const days = [
      { date: "2026-09-01", value: 10000, invested: 10000 },
      { date: "2026-09-15", value: 12000, invested: 12000 }, // +2k deposit
      { date: "2026-09-30", value: 13000, invested: 12000 },
      { date: "2026-10-01", value: 13100, invested: 12000 },
      { date: "2026-10-31", value: 14000, invested: 12000 },
    ];
    const cells = bucketMonthly(days);
    expect(cells).toHaveLength(2);
    const sep = cells[0]!;
    expect(sep.month).toBe("2026-09");
    // gain = (13000−10000) − (12000−10000) = 1000; pct = 1000/10000 = 10%
    expect(sep.gain).toBeCloseTo(1000, 6);
    expect(sep.pct).toBeCloseTo(10, 6);
    expect(sep.netFlow).toBeCloseTo(2000, 6);
    const oct = cells[1]!;
    // gain = 14000−13100 = 900; pct = 900/13100
    expect(oct.gain).toBeCloseTo(900, 6);
    expect(oct.pct).toBeCloseTo((900 / 13100) * 100, 6);
    expect(oct.netFlow).toBe(0);
  });

  it("falls back to return-on-invested when the month starts at zero", () => {
    const cells = bucketMonthly([
      { date: "2026-10-05", value: 0, invested: 0 },
      { date: "2026-10-31", value: 10500, invested: 10000 },
    ]);
    expect(cells).toHaveLength(1);
    // (10500 − 10000) / 10000 = 5%
    expect(cells[0]!.pct).toBeCloseTo(5, 6);
  });

  it("returns null pct when nothing was ever deployed", () => {
    const cells = bucketMonthly([{ date: "2026-10-31", value: 0, invested: 0 }]);
    expect(cells[0]!.pct).toBeNull();
  });

  it("returns [] for no days", () => {
    expect(bucketMonthly([])).toEqual([]);
  });
});
