import { describe, expect, it } from "vitest";

import { xirr } from "./xirr";

const DAY = 86_400_000;

describe("xirr", () => {
  it("computes a normal positive return", () => {
    const now = new Date();
    const r = xirr([
      { date: new Date(now.getTime() - 365 * DAY), amount: -1000 },
      { date: now, amount: 1100 },
    ]);
    expect(r).toBeCloseTo(0.1, 2);
  });

  it("converges for deeply negative returns", () => {
    // The default 0.1 guess shoots past r = -1 on the first Newton step
    // here; the retry guesses must still find the real root (~-79.6%).
    const now = new Date();
    const r = xirr([
      { date: new Date(now.getTime() - 365 * DAY), amount: -1000 },
      { date: now, amount: 204 },
    ]);
    expect(r).toBeCloseTo(-0.796, 2);
  });

  it("returns null for degenerate flows", () => {
    expect(xirr([])).toBeNull();
    expect(xirr([{ date: new Date(), amount: -100 }])).toBeNull();
    expect(
      xirr([
        { date: new Date(), amount: -100 },
        { date: new Date(), amount: -50 },
      ]),
    ).toBeNull();
  });
});
