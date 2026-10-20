/** Typed client for company search, the watchlist and the earnings calendar. */
import { request, type PriceStatus } from "./api";

// --- Company search -------------------------------------------------------

export interface SymbolMatch {
  ticker: string;
  /** Display name, e.g. "Microsoft Corp". */
  name: string;
  type: "stock" | "etf" | "adr";
  /** Market identifier code; "OOTC" is over the counter. */
  exchange: string | null;
}

export interface SymbolSearchResult {
  results: SymbolMatch[];
  /** False while the company list isn't loaded; an exact ticker still works. */
  ready: boolean;
}

/** Up to 8 ranked matches for a name or ticker ("micro", "mircosoft", "MSFT"). */
export function searchSymbols(
  query: string,
  signal?: AbortSignal,
): Promise<SymbolSearchResult> {
  return request<SymbolSearchResult>(
    `/api/symbols/search?q=${encodeURIComponent(query)}`,
    { signal },
  );
}

/** "Microsoft Corp (MSFT)". */
export function matchLabel(match: Pick<SymbolMatch, "ticker" | "name">): string {
  return `${match.name} (${match.ticker})`;
}

// --- Watchlist ------------------------------------------------------------

export type EarningsHour = "bmo" | "amc" | "dmh";

export interface NextEarnings {
  date: string;
  hour: EarningsHour | null;
  epsEstimate: number | null;
}

export type ReportStatus = "ready" | "outdated" | "none";

export interface WatchlistRow {
  ticker: string;
  name: string | null;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  priceStatus: PriceStatus;
  addedAt: string;
  addedPrice: number | null;
  addedPriceAt: string | null;
  changeSinceAdded: number | null;
  changeSinceAddedPercent: number | null;
  nextEarnings: NextEarnings | null;
  report: { status: ReportStatus; demoLocked: boolean };
  inPortfolio: boolean;
}

export interface Watchlist {
  items: WatchlistRow[];
  limit: number;
}

export function getWatchlist(): Promise<Watchlist> {
  return request<Watchlist>("/api/watchlist");
}

export function addToWatchlist(ticker: string): Promise<unknown> {
  return request("/api/watchlist", {
    method: "POST",
    body: JSON.stringify({ ticker }),
  });
}

export function removeFromWatchlist(ticker: string): Promise<void> {
  return request<void>(`/api/watchlist/${encodeURIComponent(ticker)}`, {
    method: "DELETE",
  });
}

const HOUR_LABELS: Record<EarningsHour, string> = {
  bmo: "Before open",
  amc: "After close",
  dmh: "During market",
};

/** "Before open", "After close", "During market", or null if not announced. */
export function earningsHourLabel(hour: EarningsHour | null): string | null {
  return hour ? HOUR_LABELS[hour] : null;
}
