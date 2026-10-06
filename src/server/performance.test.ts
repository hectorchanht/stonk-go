import { describe, expect, it } from "vitest";

import { buildInvestedCurve, downsamplePoints } from "./performance";

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
