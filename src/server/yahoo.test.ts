import { describe, expect, it } from "vitest";

import { parseChartBars, yahooTicker } from "./yahoo";

describe("yahooTicker", () => {
  it("maps HK numeric codes to .HK", () => {
    expect(yahooTicker("2225")).toBe("2225.HK");
    expect(yahooTicker(" 0005 ")).toBe("0005.HK");
  });
  it("leaves US symbols and FX pairs alone", () => {
    expect(yahooTicker("AAPL")).toBe("AAPL");
    expect(yahooTicker("HKD=X")).toBe("HKD=X");
  });
});

/** Mon 2024-01-08 → Fri 2024-01-12, 00:00 UTC each day. */
const ts = (y: number, m: number, d: number) =>
  Math.floor(Date.UTC(y, m - 1, d) / 1000);

interface Fixture {
  chart: {
    result: Array<{
      timestamp: number[];
      indicators: {
        quote: Array<{ close: Array<number | null> }>;
        adjclose?: Array<{ adjclose: Array<number | null> }>;
      };
    }>;
    error: null;
  };
}

function fixture(): Fixture {
  return {
    chart: {
      result: [
        {
          timestamp: [ts(2024, 1, 8), ts(2024, 1, 9), ts(2024, 1, 10)],
          indicators: {
            quote: [{ close: [10, null, 12] }],
            adjclose: [{ adjclose: [9.5, null, 11.5] }],
          },
        },
      ],
      error: null,
    },
  };
}

describe("parseChartBars", () => {
  it("maps epochs to UTC trading days and drops null closes", () => {
    const bars = parseChartBars(fixture());
    expect(bars.map((b) => b.date)).toEqual(["2024-01-08", "2024-01-10"]);
    expect(bars[0]).toEqual({
      date: "2024-01-08",
      close: 10,
      adjclose: 9.5,
    });
  });

  it("yields null adjclose when missing (callers fall back to close)", () => {
    const f = fixture();
    const r0 = f.chart.result[0];
    if (!r0) throw new Error("bad fixture");
    delete r0.indicators.adjclose;
    const bars = parseChartBars(f);
    expect(bars[0]!.adjclose).toBeNull();
    expect(bars[0]!.close).toBe(10);
  });

  it("keeps the last bar when two fall on the same day", () => {
    const f = fixture();
    const r0 = f.chart.result[0];
    if (!r0) throw new Error("bad fixture");
    r0.timestamp.push(ts(2024, 1, 8) + 3600);
    const q0 = r0.indicators.quote[0];
    if (!q0) throw new Error("bad fixture");
    q0.close.push(10.5);
    r0.indicators.adjclose?.[0]?.adjclose.push(10);
    const bars = parseChartBars(f);
    expect(bars.filter((b) => b.date === "2024-01-08")).toHaveLength(1);
    expect(
      bars.find((b) => b.date === "2024-01-08")!.close,
    ).toBe(10.5);
  });

  it("returns [] for malformed payloads", () => {
    expect(parseChartBars(null)).toEqual([]);
    expect(parseChartBars({ chart: null })).toEqual([]);
    expect(parseChartBars({ chart: { result: [] } })).toEqual([]);
  });
});
