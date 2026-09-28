/** Shared API types. */

/** A holding as returned by the API (Decimals serialized to numbers). */
export interface HoldingDto {
  id: string;
  ticker: string;
  shares: number;
  buyPrice: number;
  createdAt: string;
  updatedAt: string;
}

/** Per-holding row in the portfolio summary, enriched with live pricing. */
export interface PortfolioHolding {
  id: string;
  ticker: string;
  name: string | null;
  shares: number;
  buyPrice: number;
  costBasis: number;
  /** Live pricing fields are null when a quote could not be retrieved. */
  currentPrice: number | null;
  marketValue: number | null;
  gainLoss: number | null;
  gainLossPercent: number | null;
  dailyChange: number | null;
  dailyChangePercent: number | null;
  /** "ok" when priced, otherwise why pricing is missing. */
  priceStatus: "ok" | "not_found" | "unavailable";
}

/** Aggregate totals across all priced holdings. */
export interface PortfolioTotals {
  marketValue: number;
  costBasis: number;
  gainLoss: number;
  gainLossPercent: number;
  dailyChange: number;
  /** Number of holdings that had a live price and are included in the totals. */
  pricedCount: number;
  /** Number of holdings excluded from the totals because pricing was missing. */
  unpricedCount: number;
  /** True when some holdings are unpriced, so the totals are only partial. */
  partial: boolean;
}

export interface PortfolioSummary {
  holdings: PortfolioHolding[];
  totals: PortfolioTotals;
}

export interface ServiceHealth {
  status: "ok" | "unreachable";
  service: string;
  version?: string;
  environment?: string;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  service: string;
  version: string;
  /** Health of downstream dependencies. */
  dependencies: {
    aiService: ServiceHealth;
  };
}
