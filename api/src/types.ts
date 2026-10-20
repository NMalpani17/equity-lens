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

/** A ticker just added to the watchlist. */
export interface WatchlistAddedDto {
  ticker: string;
  name: string | null;
  /** Price when added; null when no quote was available (filled later). */
  addedPrice: number | null;
  addedPriceAt: string | null;
  addedAt: string;
}

/** A next earnings report, as shown on a watchlist row. */
export interface NextEarningsDto {
  date: string;
  hour: "bmo" | "amc" | "dmh" | null;
  epsEstimate: number | null;
}

/** One watchlist row: a company the user is considering, priced live. */
export interface WatchlistRowDto {
  ticker: string;
  name: string | null;
  price: number | null;
  /** Today's change vs the previous close. */
  change: number | null;
  changePercent: number | null;
  priceStatus: PriceStatus;
  addedAt: string;
  addedPrice: number | null;
  /** When `addedPrice` was recorded (later than `addedAt` if filled later). */
  addedPriceAt: string | null;
  changeSinceAdded: number | null;
  changeSinceAddedPercent: number | null;
  nextEarnings: NextEarningsDto | null;
  report: { status: "ready" | "outdated" | "none"; demoLocked: boolean };
  /** The user also holds this ticker (after "I bought it"). */
  inPortfolio: boolean;
}

export interface WatchlistDto {
  items: WatchlistRowDto[];
  limit: number;
}

export type EarningsSource = "holding" | "watchlist" | "both";

/** The Watchlist page's "Upcoming earnings" (holdings and watchlist). */
export interface UpcomingEarningsDto {
  earnings: (NextEarningsDto & {
    ticker: string;
    name: string | null;
    source: EarningsSource;
  })[];
  /** Tickers with nothing scheduled in the window (e.g. ETFs). */
  unscheduled: { ticker: string; name: string | null; source: EarningsSource }[];
  windowStart: string | null;
  windowEnd: string | null;
  refreshedAt: string | null;
  /** The calendar is loading or being updated. */
  refreshing: boolean;
  /** False when the calendar couldn't be read. */
  available: boolean;
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

/** Chart ranges for portfolio performance. */
export const PERFORMANCE_RANGES = ["1M", "3M", "6M", "1Y", "ALL"] as const;
export type PerformanceRange = (typeof PERFORMANCE_RANGES)[number];

/** One trading day on the performance chart. */
export interface PerformancePoint {
  date: string;
  /** Time-weighted price return since the start of the range, in percent. */
  portfolioPercent: number;
  /** The benchmark's price return since the start, or null without its closes. */
  benchmarkPercent: number | null;
  /** Market value of the lots held that day (at that day's close). */
  portfolioValue: number;
}

/** Why a ticker is missing from the chart. */
export type PerformanceExclusionReason =
  /** The market-data service has no daily closes for it. */
  | "no_history"
  /** Bought on or after the latest close, so it has no close to count from. */
  | "no_close_yet";

export interface PortfolioPerformance {
  range: PerformanceRange;
  /**
   * "ok": points to chart. "empty": no holdings. "no_dates": no lot has a
   * purchase date. "no_data": dated lots exist but none has a close yet.
   */
  status: "ok" | "empty" | "no_dates" | "no_data";
  benchmark: { ticker: string; available: boolean };
  startDate: string | null;
  endDate: string | null;
  /** True when the range began before the first purchase, so the chart starts there. */
  startClamped: boolean;
  portfolioReturnPercent: number | null;
  benchmarkReturnPercent: number | null;
  points: PerformancePoint[];
  excluded: { ticker: string; reason: PerformanceExclusionReason }[];
  /** Lots left out because they have no purchase date. */
  lotsWithoutDate: number;
}

/** One sector's share of the portfolio's market value. */
export interface SectorSlice {
  /** One of 11 GICS sectors, "Funds", or "Other" when unknown. */
  sector: string;
  marketValue: number;
  weightPercent: number;
  /** The positions in it, largest first. */
  holdings: { ticker: string; name: string | null; marketValue: number }[];
}

export interface SectorAllocation {
  totalMarketValue: number;
  /** Largest first, with "Other" last. */
  sectors: SectorSlice[];
  /** Positions without a live price, left out of the breakdown. */
  unpricedTickers: string[];
  /** Positions whose sector hasn't been looked up yet (shown in "Other"). */
  pendingTickers: string[];
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

/** Where relayed server-sent events go (the SSE response, in production). */
export interface EventSink {
  send(event: string, data: unknown): void;
}
