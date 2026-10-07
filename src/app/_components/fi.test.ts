import { describe, expect, it } from "vitest";

import {
  coastFiAmount,
  fiNumber,
  formatDurationMonths,
  monthsToTarget,
  nearestPointIndex,
  projectSeries,
} from "./fi";

describe("fiNumber", () => {
  it("is 25x annual expenses (4% rule)", () => {
    expect(fiNumber(48000)).toBe(1_200_000);
    expect(fiNumber(0)).toBe(0);
    expect(fiNumber(-100)).toBe(0);
  });
});

describe("monthsToTarget", () => {
  it("returns 0 when already at/above target", () => {
    expect(monthsToTarget(2_000_000, 1000, 7, 1_000_000)).toBe(0);
    expect(monthsToTarget(1_000_000, 1000, 7, 1_000_000)).toBe(0);
  });

  it("matches the annuity closed form ($1k/mo, 7%, $1M ≈ 330.4 months)", () => {
    const n = monthsToTarget(0, 1000, 7, 1_000_000);
    expect(n).toBeGreaterThan(329);
    expect(n).toBeLessThan(332);
  });

  it("handles zero return as linear growth", () => {
    expect(monthsToTarget(0, 1000, 0, 120_000)).toBe(120);
  });

  it("handles zero contribution as pure compounding", () => {
    // 100k at 7% → 200k: ln2 / ln(1+0.07/12) ≈ 119.1 months
    const n = monthsToTarget(100_000, 0, 7, 200_000);
    expect(n).toBeGreaterThan(118);
    expect(n).toBeLessThan(121);
  });

  it("returns Infinity when unreachable", () => {
    expect(monthsToTarget(0, 0, 7, 1_000_000)).toBe(Infinity);
    expect(monthsToTarget(0, 0, 0, 1_000_000)).toBe(Infinity);
    expect(monthsToTarget(100, 0, 0, 1_000_000)).toBe(Infinity);
  });

  it("clamps negative inputs", () => {
    expect(monthsToTarget(-500, -100, 7, 1_000_000)).toBe(
      monthsToTarget(0, 0, 7, 1_000_000),
    );
  });
});

describe("formatDurationMonths", () => {
  it("formats years+months", () => {
    expect(formatDurationMonths(330)).toBe("27y 6m");
    expect(formatDurationMonths(24)).toBe("2y");
    expect(formatDurationMonths(8)).toBe("8m");
    expect(formatDurationMonths(0)).toBe("0m");
    expect(formatDurationMonths(Infinity)).toBe("—");
  });
});

describe("coastFiAmount", () => {
  it("discounts the FI number back to today", () => {
    // 1M at 7% for 30 years: 1e6 / 1.07^30 ≈ 131,367
    const coast = coastFiAmount(1_000_000, 7, 30, 60);
    expect(coast).toBeGreaterThan(130_000);
    expect(coast).toBeLessThan(133_000);
  });

  it("returns the full FI number when already at/past retire age or no return", () => {
    expect(coastFiAmount(1_000_000, 7, 60, 60)).toBe(1_000_000);
    expect(coastFiAmount(1_000_000, 0, 30, 60)).toBe(1_000_000);
  });
});

describe("projectSeries", () => {
  it("starts at present value with zero growth", () => {
    const pts = projectSeries(50_000, 1000, 7, 10);
    expect(pts).toHaveLength(11);
    expect(pts[0]).toEqual({ year: 0, total: 50_000, contributed: 50_000, growth: 0 });
  });

  it("accumulates contributions and compounding", () => {
    const pts = projectSeries(0, 1000, 7, 1);
    const last = pts[pts.length - 1]!;
    expect(last.contributed).toBe(12_000);
    expect(last.total).toBeGreaterThan(12_000); // growth on top
    expect(last.growth).toBeCloseTo(last.total - last.contributed, 6);
  });

  it("is linear with zero return", () => {
    const pts = projectSeries(10_000, 500, 0, 5);
    const last = pts[pts.length - 1]!;
    expect(last.total).toBe(10_000 + 500 * 12 * 5);
    expect(last.growth).toBe(0);
  });

  it("handles zero years", () => {
    expect(projectSeries(10_000, 500, 7, 0)).toHaveLength(1);
  });
});

describe("nearestPointIndex", () => {
  it("snaps to the closest point", () => {
    expect(nearestPointIndex([0, 10, 20, 30], 21)).toBe(2);
    expect(nearestPointIndex([0, 10, 20, 30], 29)).toBe(3);
    expect(nearestPointIndex([0, 10, 20, 30], -100)).toBe(0);
    expect(nearestPointIndex([0, 10, 20, 30], 1000)).toBe(3);
  });

  it("breaks ties toward the earlier point", () => {
    expect(nearestPointIndex([0, 10, 20], 5)).toBe(0);
  });

  it("handles a single point and empty input", () => {
    expect(nearestPointIndex([42], 999)).toBe(0);
    expect(nearestPointIndex([], 10)).toBe(0);
  });
});
