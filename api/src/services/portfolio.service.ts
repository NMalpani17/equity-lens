/**
 * Portfolio summary: combines stored holdings with live quotes from the AI
 * service to compute market value, gain/loss, and daily change.
 */
import { listHoldings } from "./holdings.service.js";
import { getQuotes, type QuotesResult } from "./quotes.service.js";
import type {
  HoldingDto,
  PortfolioHolding,
  PortfolioSummary,
  PortfolioTotals,
} from "../types.js";

/** Round to cents to avoid floating-point noise in monetary values. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Pure computation: merge holdings with a quotes result into a summary.
 * Kept side-effect free so it can be unit-tested without any I/O.
 */
export function buildPortfolioSummary(
  holdings: HoldingDto[],
  quotesResult: QuotesResult,
): PortfolioSummary {
  const rows: PortfolioHolding[] = holdings.map((holding) => {
    const costBasis = round2(holding.shares * holding.buyPrice);
    const quote = quotesResult.quotes[holding.ticker];

    if (!quote) {
      const status =
        quotesResult.errors[holding.ticker] === "not_found"
          ? "not_found"
          : "unavailable";
      return {
        id: holding.id,
        ticker: holding.ticker,
        name: null,
        shares: holding.shares,
        buyPrice: holding.buyPrice,
        costBasis,
        currentPrice: null,
        marketValue: null,
        gainLoss: null,
        gainLossPercent: null,
        dailyChange: null,
        dailyChangePercent: null,
        priceStatus: status,
      };
    }

    const marketValue = round2(holding.shares * quote.price);
    const gainLoss = round2(marketValue - costBasis);
    const gainLossPercent = costBasis > 0 ? round2((gainLoss / costBasis) * 100) : 0;
    const dailyChange = round2(holding.shares * quote.change);

    return {
      id: holding.id,
      ticker: holding.ticker,
      name: quote.name,
      shares: holding.shares,
      buyPrice: holding.buyPrice,
      costBasis,
      currentPrice: quote.price,
      marketValue,
      gainLoss,
      gainLossPercent,
      dailyChange,
      dailyChangePercent: round2(quote.changePercent),
      priceStatus: "ok",
    };
  });

  return { holdings: rows, totals: computeTotals(rows) };
}

/** Aggregate totals over priced holdings only, so figures stay coherent. */
function computeTotals(rows: PortfolioHolding[]): PortfolioTotals {
  let marketValue = 0;
  let costBasis = 0;
  let dailyChange = 0;
  let pricedCount = 0;
  let unpricedCount = 0;

  for (const row of rows) {
    if (row.priceStatus !== "ok" || row.marketValue === null) {
      unpricedCount += 1;
      continue;
    }
    pricedCount += 1;
    marketValue += row.marketValue;
    costBasis += row.costBasis;
    dailyChange += row.dailyChange ?? 0;
  }

  const gainLoss = marketValue - costBasis;
  const gainLossPercent = costBasis > 0 ? (gainLoss / costBasis) * 100 : 0;

  return {
    marketValue: round2(marketValue),
    costBasis: round2(costBasis),
    gainLoss: round2(gainLoss),
    gainLossPercent: round2(gainLossPercent),
    dailyChange: round2(dailyChange),
    pricedCount,
    unpricedCount,
    partial: unpricedCount > 0,
  };
}

/** Orchestrator: load holdings, fetch their quotes, and build the summary. */
export async function getPortfolioSummary(): Promise<PortfolioSummary> {
  const holdings = await listHoldings();
  const tickers = [...new Set(holdings.map((h) => h.ticker))];
  const quotesResult = await getQuotes(tickers);
  return buildPortfolioSummary(holdings, quotesResult);
}
