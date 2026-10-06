import { describe, expect, it } from "vitest";
import {
  chartDayToIso,
  curveColor,
  isoToChartDay,
  toAreaData,
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
