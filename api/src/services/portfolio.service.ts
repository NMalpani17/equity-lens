/**
 * Portfolio summary: combines stored holdings with live quotes from the AI
 * service. Each holding is a lot; lots that share a ticker are grouped into a
 * single position with aggregate figures. All grouping happens here (not on the
 * client) so the API is the single source of truth.
 */
import { listHoldings } from "./holdings.service.js";
import { getQuotes, type Quote, type QuotesResult } from "./quotes.service.js";
import type {
  HoldingDto,
  PortfolioLot,
  PortfolioPosition,
  PortfolioSummary,
  PortfolioTotals,
  PriceStatus,
} from "../types.js";

/** Round to cents to avoid floating-point noise in monetary values. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Round share counts to 8 decimals (matches the DB precision). */
function round8(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

/** The price status for a ticker given the quotes result. */
function statusFor(ticker: string, quotesResult: QuotesResult): PriceStatus {
  if (quotesResult.quotes[ticker]) {
    return "ok";
  }
  return quotesResult.errors[ticker] === "not_found" ? "not_found" : "unavailable";
}

/** Build a priced lot from a single holding. */
function buildLot(
  holding: HoldingDto,
  quote: Quote | undefined,
  status: PriceStatus,
): PortfolioLot {
  const costBasis = round2(holding.shares * holding.buyPrice);
  const base = {
    id: holding.id,
    ticker: holding.ticker,
    shares: holding.shares,
    buyPrice: holding.buyPrice,
    purchaseDate: holding.purchaseDate,
    costBasis,
  };

  if (!quote) {
    return {
      ...base,
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
  return {
    ...base,
    currentPrice: quote.price,
    marketValue,
    gainLoss,
    gainLossPercent: costBasis > 0 ? round2((gainLoss / costBasis) * 100) : 0,
    dailyChange: round2(holding.shares * quote.change),
    dailyChangePercent: round2(quote.changePercent),
    priceStatus: "ok",
  };
}

/** Aggregate the lots for one ticker into a position. */
function buildPosition(
  ticker: string,
  holdings: HoldingDto[],
  quotesResult: QuotesResult,
): PortfolioPosition {
  const quote = quotesResult.quotes[ticker];
  const status = statusFor(ticker, quotesResult);
  const lots = holdings.map((h) => buildLot(h, quote, status));

  const totalShares = round8(holdings.reduce((sum, h) => sum + h.shares, 0));
  const rawCost = holdings.reduce((sum, h) => sum + h.shares * h.buyPrice, 0);
  const costBasis = round2(rawCost);
  const avgBuyPrice = totalShares > 0 ? round2(rawCost / totalShares) : 0;

  const base = {
    ticker,
    name: quote?.name ?? null,
    totalShares,
    avgBuyPrice,
    costBasis,
    lots,
  };

  if (!quote) {
    return {
      ...base,
      currentPrice: null,
      marketValue: null,
      gainLoss: null,
      gainLossPercent: null,
      dailyChange: null,
      dailyChangePercent: null,
      priceStatus: status,
    };
  }

  const marketValue = round2(totalShares * quote.price);
  const gainLoss = round2(marketValue - costBasis);
  return {
    ...base,
    currentPrice: quote.price,
    marketValue,
    gainLoss,
    gainLossPercent: costBasis > 0 ? round2((gainLoss / costBasis) * 100) : 0,
    dailyChange: round2(totalShares * quote.change),
    dailyChangePercent: round2(quote.changePercent),
    priceStatus: "ok",
  };
}

/**
 * Pure computation: merge holdings with a quotes result into a grouped summary.
 * Kept side-effect free so it can be unit-tested without any I/O.
 */
export function buildPortfolioSummary(
  holdings: HoldingDto[],
  quotesResult: QuotesResult,
): PortfolioSummary {
  // Group lots by ticker, preserving the order each ticker first appears.
  const order: string[] = [];
  const byTicker = new Map<string, HoldingDto[]>();
  for (const holding of holdings) {
    const existing = byTicker.get(holding.ticker);
    if (existing) {
      existing.push(holding);
    } else {
      byTicker.set(holding.ticker, [holding]);
      order.push(holding.ticker);
    }
  }

  const positions = order.map((ticker) =>
    buildPosition(ticker, byTicker.get(ticker)!, quotesResult),
  );

  return { positions, totals: computeTotals(positions) };
}

/** Aggregate totals over priced positions only, so figures stay coherent. */
function computeTotals(positions: PortfolioPosition[]): PortfolioTotals {
  let marketValue = 0;
  let costBasis = 0;
  let dailyChange = 0;
  let pricedCount = 0;
  let unpricedCount = 0;

  for (const position of positions) {
    if (position.priceStatus !== "ok" || position.marketValue === null) {
      unpricedCount += 1;
      continue;
    }
    pricedCount += 1;
    marketValue += position.marketValue;
    costBasis += position.costBasis;
    dailyChange += position.dailyChange ?? 0;
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

/** Orchestrator: load the user's holdings, fetch quotes, and build the summary. */
export async function getPortfolioSummary(userId: string): Promise<PortfolioSummary> {
  const holdings = await listHoldings(userId);
  const tickers = [...new Set(holdings.map((h) => h.ticker))];
  const quotesResult = await getQuotes(tickers);
  return buildPortfolioSummary(holdings, quotesResult);
}
