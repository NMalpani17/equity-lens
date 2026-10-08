/**
 * Proper company names for display ("Amazon.com, Inc.", not "Amazon Com Inc").
 *
 * The ai-service cleans names as it writes and reads them; this covers what
 * the api reads directly: `rag_tickers` rows and stored reports written
 * before the cleanup. Keep the table in sync with
 * `ai-service/app/services/rag/company_names.py`.
 */
export const COMPANY_NAMES: Readonly<Record<string, string>> = {
  AAPL: "Apple Inc.",
  AMD: "Advanced Micro Devices, Inc.",
  AMZN: "Amazon.com, Inc.",
  COST: "Costco Wholesale Corporation",
  GOOG: "Alphabet Inc.",
  GOOGL: "Alphabet Inc.",
  JPM: "JPMorgan Chase & Co.",
  META: "Meta Platforms, Inc.",
  MSFT: "Microsoft Corporation",
  NFLX: "Netflix, Inc.",
  NKE: "NIKE, Inc.",
  NVDA: "NVIDIA Corporation",
  SBUX: "Starbucks Corporation",
  TSLA: "Tesla, Inc.",
};

// A trailing abbreviation without its period: "Microsoft Corp" -> "Corp."
const BARE_SUFFIX_RE = /(?<=\s)(Inc|Corp|Co|Ltd)$/;

/** The proper name for `ticker`; `name` cleaned lightly, else the ticker. */
export function companyDisplayName(
  ticker: string,
  name: string | null | undefined,
): string {
  const curated = COMPANY_NAMES[ticker.trim().toUpperCase()];
  if (curated) return curated;
  const text = (name ?? "").split(/\s+/).filter(Boolean).join(" ");
  if (!text) return ticker;
  return text.replace(BARE_SUFFIX_RE, "$1.");
}
