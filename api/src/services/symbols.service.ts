/**
 * Company search (the ai-service ranks Finnhub's US symbol list in Postgres)
 * and symbol lookups (read straight from `market_symbols`, which Prisma owns
 * and the ai-service fills).
 *
 * Search is best effort: on any failure it answers no matches and not ready,
 * and callers still accept an exact ticker typed in full.
 */
import { z } from "zod";

import { prisma } from "../db/prisma.js";
import { logger } from "../logger.js";
import { aiServiceFetch, aiServiceUrl } from "./aiServiceClient.js";

const symbolMatchSchema = z.object({
  ticker: z.string(),
  name: z.string(),
  type: z.enum(["stock", "etf", "adr"]),
  exchange: z.string().nullable(),
});

const upstreamSchema = z.object({
  results: z.array(symbolMatchSchema),
  ready: z.boolean(),
});

export type SymbolMatch = z.infer<typeof symbolMatchSchema>;
export type SymbolSearchResult = z.infer<typeof upstreamSchema>;

/** Search runs on every (debounced) keystroke; a slow answer is no answer. */
const SEARCH_TIMEOUT_MS = 5000;

const NOT_READY: SymbolSearchResult = { results: [], ready: false };

/** Up to 8 ranked matches for a name or ticker; never throws. */
export async function searchSymbols(query: string): Promise<SymbolSearchResult> {
  const url = aiServiceUrl("/symbols/search");
  url.searchParams.set("q", query);
  try {
    const response = await aiServiceFetch(url, {
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn(
        { status: response.status },
        "ai-service symbol search returned non-OK",
      );
      return NOT_READY;
    }
    const parsed = upstreamSchema.safeParse(await response.json());
    if (!parsed.success) {
      logger.warn(
        { err: parsed.error.flatten() },
        "ai-service symbol search had an unexpected shape",
      );
      return NOT_READY;
    }
    return parsed.data;
  } catch (error) {
    logger.warn({ err: error }, "failed to reach ai-service symbol search");
    return NOT_READY;
  }
}

/** Display names for the tickers found in the symbol list (others omitted). */
export async function symbolNames(tickers: string[]): Promise<Map<string, string>> {
  if (tickers.length === 0) return new Map();
  const rows = await prisma.marketSymbol.findMany({
    where: { ticker: { in: tickers } },
    select: { ticker: true, name: true },
  });
  return new Map(rows.map((row) => [row.ticker, row.name]));
}

/** Whether the ticker is in the symbol list (no ai-service or Finnhub call). */
export async function isListedSymbol(ticker: string): Promise<boolean> {
  const row = await prisma.marketSymbol.findUnique({
    where: { ticker },
    select: { ticker: true },
  });
  return row !== null;
}
