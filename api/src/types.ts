/** Shared API types. */

/** Why live pricing is present or missing. */
export type PriceStatus = "ok" | "not_found" | "unavailable";

/** A holding (one buy lot) as returned by the API (Decimals → numbers). */
export interface HoldingDto {
  id: string;
  ticker: string;
  shares: number;
  buyPrice: number;
  /** Optional purchase date, serialized as an ISO date (YYYY-MM-DD). */
  purchaseDate: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A single lot within a position, enriched with live pricing. */
export interface PortfolioLot {
  id: string;
  ticker: string;
  shares: number;
  buyPrice: number;
  purchaseDate: string | null;
  costBasis: number;
  /** Live pricing fields are null when a quote could not be retrieved. */
  currentPrice: number | null;
  marketValue: number | null;
  gainLoss: number | null;
  gainLossPercent: number | null;
  dailyChange: number | null;
  dailyChangePercent: number | null;
  priceStatus: PriceStatus;
}

/**
 * A position groups all lots that share a ticker. Aggregate figures use the
 * combined shares; per-lot detail lives in `lots`.
 */
export interface PortfolioPosition {
  ticker: string;
  name: string | null;
  totalShares: number;
  /** Cost-weighted average buy price across the lots. */
  avgBuyPrice: number;
  costBasis: number;
  currentPrice: number | null;
  marketValue: number | null;
  gainLoss: number | null;
  gainLossPercent: number | null;
  dailyChange: number | null;
  dailyChangePercent: number | null;
  priceStatus: PriceStatus;
  lots: PortfolioLot[];
}

/** Aggregate totals across all priced positions. */
export interface PortfolioTotals {
  marketValue: number;
  costBasis: number;
  gainLoss: number;
  gainLossPercent: number;
  dailyChange: number;
  /** Number of positions that had a live price and are included in the totals. */
  pricedCount: number;
  /** Number of positions excluded from the totals because pricing was missing. */
  unpricedCount: number;
  /** True when some positions are unpriced, so the totals are only partial. */
  partial: boolean;
}

export interface PortfolioSummary {
  positions: PortfolioPosition[];
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
  /** Health of downstream dependencies (signed-in callers only). */
  dependencies?: {
    aiService: ServiceHealth;
  };
}
