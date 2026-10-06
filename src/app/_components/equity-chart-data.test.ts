import { describe, expect, it } from "vitest";
import {
  chartDayToIso,
  curveColor,
  isoToChartDay,
  toAreaData,
  toPercentSeries,
  toReturnOnInvested,
} from "./equity-chart-data";

describe("isoToChartDay", () => {
  it("parses YYYY-MM-DD into a calendar day", () => {
    expect(isoToChartDay("2026-10-06")).toEqual({
      year: 2026,
      month: 10,
      day: 6,
    });
  });

  it("rejects malformed input", () => {
    expect(isoToChartDay("")).toBeNull();
    expect(isoToChartDay("not-a-date")).toBeNull();
    expect(isoToChartDay("2026-13-01")).toBeNull();
    expect(isoToChartDay("2026-10-32")).toBeNull();
    expect(isoToChartDay("10/06/2026")).toBeNull();
  });
});

describe("chartDayToIso", () => {
  it("round-trips isoToChartDay", () => {
    expect(chartDayToIso({ year: 2026, month: 1, day: 5 })).toBe("2026-01-05");
  });
});

describe("toAreaData", () => {
  it("maps points and drops malformed ones", () => {
    expect(
      toAreaData([
        { date: "2026-10-01", value: 100 },
        { date: "garbage", value: 200 },
        { date: "2026-10-02", value: Number.NaN },
        { date: "2026-10-03", value: 150.5 },
      ]),
    ).toEqual([
      { time: { year: 2026, month: 10, day: 1 }, value: 100 },
      { time: { year: 2026, month: 10, day: 3 }, value: 150.5 },
    ]);
  });

  it("returns [] for empty input", () => {
    expect(toAreaData([])).toEqual([]);
  });
});

describe("curveColor", () => {
  it("is emerald when the period is up, rose when down", () => {
    const up = [
      { date: "2026-10-01", value: 100 },
      { date: "2026-10-02", value: 120 },
    ];
    const down = [
      { date: "2026-10-01", value: 120 },
      { date: "2026-10-02", value: 100 },
    ];
    expect(curveColor(up)).toBe("#34d399");
    expect(curveColor(down)).toBe("#fb7185");
  });

  it("treats a flat period as up", () => {
    expect(
      curveColor([
        { date: "2026-10-01", value: 100 },
        { date: "2026-10-02", value: 100 },
      ]),
    ).toBe("#34d399");
  });
});

describe("toPercentSeries", () => {
  it("computes cumulative simple return vs the first point", () => {
    expect(
      toPercentSeries([
        { date: "2026-08-01", value: 100 },
        { date: "2026-08-02", value: 120 },
        { date: "2026-08-03", value: 80 },
      ]),
    ).toEqual([
      { date: "2026-08-01", value: 0 },
      { date: "2026-08-02", value: 20 },
      { date: "2026-08-03", value: -20 },
    ]);
  });

  it("returns [] when the base value is not positive", () => {
    expect(
      toPercentSeries([
        { date: "2026-08-01", value: 0 },
        { date: "2026-08-02", value: 50 },
      ]),
    ).toEqual([]);
    expect(
      toPercentSeries([
        { date: "2026-08-01", value: -10 },
        { date: "2026-08-02", value: 50 },
      ]),
    ).toEqual([]);
  });

  it("returns [] for fewer than 2 points", () => {
    expect(toPercentSeries([])).toEqual([]);
    expect(toPercentSeries([{ date: "2026-08-01", value: 100 }])).toEqual([]);
  });

  it("keeps dates aligned with the input points", () => {
    const out = toPercentSeries([
      { date: "2026-08-01", value: 200 },
      { date: "2026-09-01", value: 235.28 },
    ]);
    expect(out[0]!.date).toBe("2026-08-01");
    expect(out[1]!.date).toBe("2026-09-01");
    expect(out[1]!.value).toBeCloseTo(17.64, 2);
  });
});

describe("toReturnOnInvested", () => {
  it("computes (value − invested) / invested × 100", () => {
    const out = toReturnOnInvested([
      { date: "2024-01-01", value: 1100, invested: 1000 },
      { date: "2024-01-02", value: 900, invested: 1000 },
    ]);
    expect(out[0]!.value).toBeCloseTo(10, 6);
    expect(out[1]!.value).toBeCloseTo(-10, 6);
  });

  it("skips days with non-positive or missing invested", () => {
    const out = toReturnOnInvested([
      { date: "2024-01-01", value: 100, invested: 0 },
      { date: "2024-01-02", value: 100, invested: -50 },
      { date: "2024-01-03", value: 100 },
      { date: "2024-01-04", value: 120, invested: 100 },
    ]);
    expect(out).toEqual([{ date: "2024-01-04", value: 20 }]);
  });
});
