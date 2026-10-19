import { describe, expect, it } from "vitest";

import { OTHER_SECTOR, groupBySector } from "../src/services/sectors.service.js";
import type { CompanyProfiles } from "../src/services/companyProfiles.service.js";
import type { PortfolioPosition } from "../src/types.js";

function position(
  ticker: string,
  marketValue: number | null,
  name: string | null = null,
): PortfolioPosition {
  return {
    ticker,
    name,
    totalShares: 1,
    avgBuyPrice: 1,
    costBasis: 1,
    currentPrice: marketValue,
    marketValue,
    gainLoss: null,
    gainLossPercent: null,
    dailyChange: null,
    dailyChangePercent: null,
    priceStatus: marketValue === null ? "unavailable" : "ok",
    lots: [],
  };
}

function profiles(
  sectors: Record<string, string | null>,
  pending: string[] = [],
): CompanyProfiles {
  return {
    profiles: Object.fromEntries(
      Object.entries(sectors).map(([ticker, sector]) => [
        ticker,
        { ticker, name: `${ticker} Inc`, sector },
      ]),
    ),
    pending,
  };
}

const TECH = "Information Technology";

describe("groupBySector", () => {
  it("groups market value by sector, largest first", () => {
    const result = groupBySector(
      [
        position("AAPL", 3000, "Apple Inc"),
        position("MSFT", 2000),
        position("JPM", 1000),
        position("VOO", 4000),
      ],
      profiles({ AAPL: TECH, MSFT: TECH, JPM: "Financials", VOO: "Funds" }),
    );

    expect(result.totalMarketValue).toBe(10_000);
    expect(
      result.sectors.map((s) => [s.sector, s.marketValue, s.weightPercent]),
    ).toEqual([
      [TECH, 5000, 50],
      ["Funds", 4000, 40],
      ["Financials", 1000, 10],
    ]);
    expect(result.sectors[0]!.holdings).toEqual([
      { ticker: "AAPL", name: "Apple Inc", marketValue: 3000 },
      { ticker: "MSFT", name: "MSFT Inc", marketValue: 2000 },
    ]);
  });

  it("puts unknown and missing sectors in Other, listed last", () => {
    const result = groupBySector(
      [position("ODD", 5000), position("NEW", 1000), position("AAPL", 2000)],
      profiles({ ODD: null, AAPL: TECH }, ["NEW"]),
    );

    expect(result.sectors.map((s) => s.sector)).toEqual([TECH, OTHER_SECTOR]);
    const other = result.sectors.at(-1)!;
    expect(other.marketValue).toBe(6000);
    expect(other.holdings.map((h) => h.ticker)).toEqual(["ODD", "NEW"]);
    expect(result.pendingTickers).toEqual(["NEW"]);
  });

  it("leaves out unpriced positions", () => {
    const result = groupBySector(
      [position("AAPL", 1000), position("DOWN", null)],
      profiles({ AAPL: TECH, DOWN: "Energy" }),
    );

    expect(result.unpricedTickers).toEqual(["DOWN"]);
    expect(result.sectors).toHaveLength(1);
    expect(result.sectors[0]!.weightPercent).toBe(100);
  });

  it("rounds weights that still add up to about 100", () => {
    const result = groupBySector(
      [position("A", 1), position("B", 1), position("C", 1)],
      profiles({ A: TECH, B: "Energy", C: "Utilities" }),
    );

    const total = result.sectors.reduce((sum, s) => sum + s.weightPercent, 0);
    expect(result.sectors.map((s) => s.weightPercent)).toEqual([33.33, 33.33, 33.33]);
    expect(total).toBeCloseTo(100, 1);
  });

  it("handles an empty portfolio", () => {
    expect(groupBySector([], profiles({}))).toEqual({
      totalMarketValue: 0,
      sectors: [],
      unpricedTickers: [],
      pendingTickers: [],
    });
  });
});
