/** Typed client for company search, the watchlist and the earnings calendar. */
import { request } from "./api";

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
