import { describe, expect, it } from "vitest";

import {
  buildByPlatform,
  type PlatformRow,
} from "./platform-totals";

function row(overrides: Partial<PlatformRow>): PlatformRow {
  return {
    source: "manual",
    brokerLabel: null,
    marketValue: 110,
    costBasis: 100,
    dayPL: 5,
    ...overrides,
  };
}

describe("buildByPlatform", () => {
  it("sums value, cost and day P/L per platform when all costs are known", () => {
    const plats = buildByPlatform([
      row({ marketValue: 1000, costBasis: 800, dayPL: 10 }),
      row({ marketValue: 500, costBasis: 400, dayPL: -5 }),
    ]);
    expect(plats).toHaveLength(1);
    expect(plats[0]).toMatchObject({
      platform: "Manual",
      count: 2,
      marketValue: 1500,
      costBasis: 1200,
      dayPL: 5,
      totalPL: 300,
    });
  });

  it("never treats an unknown cost as $0 — cost and total P/L stay null", () => {
    // The Binance case: $20,908 of value with no cost data must NOT show
    // up as +$20,908 of phantom profit.
    const plats = buildByPlatform([
      row({
        source: "broker",
        brokerLabel: "BINANCE",
        marketValue: 20908,
        costBasis: null,
        dayPL: null,
      }),
    ]);
    expect(plats).toHaveLength(1);
    expect(plats[0]).toMatchObject({
      platform: "BINANCE",
      marketValue: 20908,
      costBasis: null,
      totalPL: null,
    });
  });

  it("one costless position poisons only its own platform", () => {
    const plats = buildByPlatform([
      row({ marketValue: 1000, costBasis: 800 }),
      row({
        source: "broker",
        brokerLabel: "BINANCE",
        marketValue: 500,
        costBasis: null,
      }),
    ]);
    const manual = plats.find((p) => p.platform === "Manual")!;
    const binance = plats.find((p) => p.platform === "BINANCE")!;
    expect(manual.totalPL).toBe(200);
    expect(manual.costBasis).toBe(800);
    expect(binance.costBasis).toBeNull();
    expect(binance.totalPL).toBeNull();
  });

  it("platform day P/L is null when no position has one, else the sum", () => {
    const plats = buildByPlatform([
      row({
        source: "broker",
        brokerLabel: "BINANCE",
        marketValue: 500,
        costBasis: 400,
        dayPL: null,
      }),
      row({ marketValue: 1000, costBasis: 800, dayPL: 10 }),
      row({ marketValue: 500, costBasis: 400, dayPL: null }),
    ]);
    const binance = plats.find((p) => p.platform === "BINANCE")!;
    const manual = plats.find((p) => p.platform === "Manual")!;
    expect(binance.dayPL).toBeNull();
    expect(manual.dayPL).toBe(10);
  });

  it("sorts platforms by market value descending", () => {
    const plats = buildByPlatform([
      row({
        source: "broker",
        brokerLabel: "BINANCE",
        marketValue: 100,
        costBasis: 90,
      }),
      row({ marketValue: 1000, costBasis: 800 }),
    ]);
    expect(plats.map((p) => p.platform)).toEqual(["Manual", "BINANCE"]);
  });
});
