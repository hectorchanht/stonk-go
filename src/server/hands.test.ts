import { describe, expect, it } from "vitest";

import { countBuyStreak, maxDrawdown } from "./hands";

describe("maxDrawdown", () => {
  it("finds the worst peak-to-trough decline", () => {
    // peak 120 → trough 90 = 25%
    expect(maxDrawdown([100, 120, 90, 110])).toBeCloseTo(0.25, 10);
  });

  it("is 0 for a monotonic climb", () => {
    expect(maxDrawdown([100, 110, 120])).toBe(0);
  });

  it("measures from the highest peak, not the first", () => {
    // peaks at 200, troughs to 100 → 50% (not 100→50 = 50%... both 50%; use clearer numbers)
    expect(maxDrawdown([50, 200, 100, 150])).toBeCloseTo(0.5, 10);
  });

  it("returns null with fewer than 2 finite closes", () => {
    expect(maxDrawdown([])).toBeNull();
    expect(maxDrawdown([100])).toBeNull();
    expect(maxDrawdown([NaN, Infinity])).toBeNull();
  });

  it("ignores non-finite closes", () => {
    expect(maxDrawdown([100, NaN, 50])).toBeCloseTo(0.5, 10);
  });
});

describe("countBuyStreak", () => {
  it("counts consecutive months ending this month", () => {
    expect(countBuyStreak(["2026-10", "2026-09", "2026-08"], "2026-10-15")).toBe(3);
  });

  it("doesn't break on an unfinished empty current month", () => {
    expect(countBuyStreak(["2026-09", "2026-08"], "2026-10-15")).toBe(2);
  });

  it("stops at a gap", () => {
    expect(countBuyStreak(["2026-10", "2026-08"], "2026-10-15")).toBe(1);
  });

  it("handles year boundaries", () => {
    expect(countBuyStreak(["2026-01", "2025-12", "2025-11"], "2026-01-20")).toBe(3);
  });

  it("returns 0 with no activity", () => {
    expect(countBuyStreak([], "2026-10-15")).toBe(0);
  });

  it("accepts a Set", () => {
    expect(countBuyStreak(new Set(["2026-10", "2026-09"]), "2026-10-15")).toBe(2);
  });
});
