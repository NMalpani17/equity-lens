import { describe, expect, it } from "vitest";

import { buildPortfolioSummary } from "../src/services/portfolio.service.js";
import type { HoldingDto } from "../src/types.js";
import type { Quote, QuotesResult } from "../src/services/quotes.service.js";

function holding(overrides: Partial<HoldingDto> = {}): HoldingDto {
  return {
    id: "id-1",
    ticker: "AAPL",
    shares: 10,
    buyPrice: 100,
    purchaseDate: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    ticker: "AAPL",
    price: 110,
    previousClose: 105,
    change: 5,
    changePercent: 4.7619,
    currency: "USD",
    name: "Apple Inc",
    provider: "finnhub",
    asOf: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildPortfolioSummary", () => {
  it("builds a single-lot position with value, gain/loss and daily change", () => {
    const result: QuotesResult = { quotes: { AAPL: quote() }, errors: {} };

    const summary = buildPortfolioSummary([holding()], result);
    const position = summary.positions[0]!;

    expect(position.ticker).toBe("AAPL");
    expect(position.totalShares).toBe(10);
    expect(position.avgBuyPrice).toBe(100);
    expect(position.costBasis).toBe(1000); // 10 * 100
    expect(position.marketValue).toBe(1100); // 10 * 110
    expect(position.gainLoss).toBe(100);
    expect(position.gainLossPercent).toBe(10);
    expect(position.dailyChange).toBe(50); // 10 * 5
    expect(position.name).toBe("Apple Inc");
    expect(position.priceStatus).toBe("ok");
    expect(position.lots).toHaveLength(1);

    expect(summary.totals).toEqual({
      marketValue: 1100,
      costBasis: 1000,
      gainLoss: 100,
      gainLossPercent: 10,
      dailyChange: 50,
      pricedCount: 1,
      unpricedCount: 0,
      partial: false,
    });
  });

  it("groups multiple lots of the same ticker into one position", () => {
    const holdings = [
      holding({ id: "a", ticker: "AAPL", shares: 10, buyPrice: 100 }),
      holding({ id: "b", ticker: "AAPL", shares: 20, buyPrice: 130 }),
    ];
    const result: QuotesResult = {
      quotes: { AAPL: quote({ price: 110, change: 5 }) },
      errors: {},
    };

    const summary = buildPortfolioSummary(holdings, result);

    expect(summary.positions).toHaveLength(1);
    const position = summary.positions[0]!;

    // 10 + 20 shares
    expect(position.totalShares).toBe(30);
    // Weighted average: (10*100 + 20*130) / 30 = 3600 / 30 = 120
    expect(position.avgBuyPrice).toBe(120);
    expect(position.costBasis).toBe(3600);
    // Combined market value: 30 * 110 = 3300
    expect(position.marketValue).toBe(3300);
    expect(position.gainLoss).toBe(-300); // 3300 - 3600
    expect(position.dailyChange).toBe(150); // 30 * 5
    // Both lots are retained, each with their own pricing.
    expect(position.lots.map((l) => l.id)).toEqual(["a", "b"]);
    expect(position.lots[0]!.marketValue).toBe(1100); // 10 * 110
    expect(position.lots[1]!.marketValue).toBe(2200); // 20 * 110
    expect(position.lots[1]!.buyPrice).toBe(130);
  });

  it("keeps distinct tickers as separate positions in first-seen order", () => {
    const holdings = [
      holding({ id: "a", ticker: "MSFT", shares: 5, buyPrice: 200 }),
      holding({ id: "b", ticker: "AAPL", shares: 10, buyPrice: 100 }),
      holding({ id: "c", ticker: "MSFT", shares: 5, buyPrice: 210 }),
    ];
    const result: QuotesResult = {
      quotes: {
        MSFT: quote({ ticker: "MSFT", name: "Microsoft", price: 220, change: -10 }),
        AAPL: quote({ ticker: "AAPL", price: 110, change: 5 }),
      },
      errors: {},
    };

    const summary = buildPortfolioSummary(holdings, result);

    expect(summary.positions.map((p) => p.ticker)).toEqual(["MSFT", "AAPL"]);
    const msft = summary.positions[0]!;
    expect(msft.totalShares).toBe(10);
    expect(msft.lots).toHaveLength(2);
    expect(summary.totals.pricedCount).toBe(2);
  });

  it("marks positions without a quote and excludes them from totals", () => {
    const result: QuotesResult = {
      quotes: {},
      errors: { TSLA: "not_found" },
    };

    const summary = buildPortfolioSummary(
      [holding({ id: "id-2", ticker: "TSLA" })],
      result,
    );
    const position = summary.positions[0]!;

    expect(position.priceStatus).toBe("not_found");
    expect(position.marketValue).toBeNull();
    expect(position.gainLoss).toBeNull();
    expect(position.costBasis).toBe(1000); // cost basis is still known
    expect(position.lots[0]!.priceStatus).toBe("not_found");
    expect(summary.totals.marketValue).toBe(0);
    expect(summary.totals.pricedCount).toBe(0);
    expect(summary.totals.unpricedCount).toBe(1);
  });

  it("aggregates totals over priced positions only and flags partial", () => {
    const holdings = [
      holding({ id: "a", ticker: "AAPL", shares: 10, buyPrice: 100 }),
      holding({ id: "b", ticker: "MSFT", shares: 5, buyPrice: 200 }),
      holding({ id: "c", ticker: "TSLA", shares: 2, buyPrice: 300 }),
    ];
    const result: QuotesResult = {
      quotes: {
        AAPL: quote({ ticker: "AAPL", price: 110, change: 5 }),
        MSFT: quote({ ticker: "MSFT", price: 220, change: -10 }),
      },
      errors: { TSLA: "unavailable" },
    };

    const summary = buildPortfolioSummary(holdings, result);

    // AAPL: value 1100, cost 1000; MSFT: value 1100, cost 1000. TSLA excluded.
    expect(summary.totals.marketValue).toBe(2200);
    expect(summary.totals.costBasis).toBe(2000);
    expect(summary.totals.gainLoss).toBe(200);
    expect(summary.totals.gainLossPercent).toBe(10);
    expect(summary.totals.dailyChange).toBe(0); // 10*5 + 5*(-10)
    expect(summary.totals.pricedCount).toBe(2);
    expect(summary.totals.unpricedCount).toBe(1);
    expect(summary.totals.partial).toBe(true);
  });
});
