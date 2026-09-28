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
  it("computes value, gain/loss and daily change for a priced holding", () => {
    const result: QuotesResult = { quotes: { AAPL: quote() }, errors: {} };

    const summary = buildPortfolioSummary([holding()], result);
    const row = summary.holdings[0]!;

    expect(row.costBasis).toBe(1000); // 10 * 100
    expect(row.marketValue).toBe(1100); // 10 * 110
    expect(row.gainLoss).toBe(100);
    expect(row.gainLossPercent).toBe(10);
    expect(row.dailyChange).toBe(50); // 10 * 5
    expect(row.name).toBe("Apple Inc");
    expect(row.priceStatus).toBe("ok");

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

  it("marks holdings without a quote and excludes them from totals", () => {
    const result: QuotesResult = {
      quotes: {},
      errors: { TSLA: "not_found" },
    };

    const summary = buildPortfolioSummary(
      [holding({ id: "id-2", ticker: "TSLA" })],
      result,
    );
    const row = summary.holdings[0]!;

    expect(row.priceStatus).toBe("not_found");
    expect(row.marketValue).toBeNull();
    expect(row.gainLoss).toBeNull();
    expect(row.costBasis).toBe(1000); // cost basis is still known
    expect(summary.totals.marketValue).toBe(0);
    expect(summary.totals.gainLoss).toBe(0);
  });

  it("aggregates totals over multiple priced holdings only", () => {
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
  });

  it("flags totals as partial and counts priced vs unpriced holdings", () => {
    const holdings = [
      holding({ id: "a", ticker: "AAPL" }),
      holding({ id: "b", ticker: "TSLA" }),
    ];
    const result: QuotesResult = {
      quotes: { AAPL: quote({ ticker: "AAPL" }) },
      errors: { TSLA: "not_found" },
    };

    const summary = buildPortfolioSummary(holdings, result);

    expect(summary.totals.partial).toBe(true);
    expect(summary.totals.pricedCount).toBe(1);
    expect(summary.totals.unpricedCount).toBe(1);
  });

  it("reports no priced holdings when the whole batch is unavailable", () => {
    const holdings = [
      holding({ id: "a", ticker: "AAPL" }),
      holding({ id: "b", ticker: "MSFT" }),
    ];
    const result: QuotesResult = {
      quotes: {},
      errors: { AAPL: "unavailable", MSFT: "unavailable" },
    };

    const summary = buildPortfolioSummary(holdings, result);

    expect(summary.totals.pricedCount).toBe(0);
    expect(summary.totals.unpricedCount).toBe(2);
    expect(summary.totals.partial).toBe(true);
    expect(summary.totals.marketValue).toBe(0);
  });
});
