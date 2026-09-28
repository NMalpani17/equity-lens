/**
 * Client for the AI service's market-data endpoints.
 *
 * The upstream response is external input, so it is validated with Zod. This
 * client never throws: on any transport failure it returns every requested
 * ticker as `unavailable`, so the portfolio summary can still render holdings.
 */
import { z } from "zod";

import { config } from "../config.js";
import { logger } from "../logger.js";

export const quoteSchema = z.object({
  ticker: z.string(),
  price: z.number(),
  previousClose: z.number(),
  change: z.number(),
  changePercent: z.number(),
  currency: z.string(),
  name: z.string().nullable(),
  provider: z.string(),
  asOf: z.string(),
});

export type Quote = z.infer<typeof quoteSchema>;

// The AI service serializes with snake_case field names.
const upstreamQuoteSchema = z.object({
  ticker: z.string(),
  price: z.number(),
  previous_close: z.number(),
  change: z.number(),
  change_percent: z.number(),
  currency: z.string(),
  name: z.string().nullable(),
  provider: z.string(),
  as_of: z.string(),
});

const upstreamResponseSchema = z.object({
  quotes: z.record(upstreamQuoteSchema),
  errors: z.record(z.string()),
});

export interface QuotesResult {
  quotes: Record<string, Quote>;
  errors: Record<string, string>;
}

const REQUEST_TIMEOUT_MS = 8000;

function toQuote(raw: z.infer<typeof upstreamQuoteSchema>): Quote {
  return {
    ticker: raw.ticker,
    price: raw.price,
    previousClose: raw.previous_close,
    change: raw.change,
    changePercent: raw.change_percent,
    currency: raw.currency,
    name: raw.name,
    provider: raw.provider,
    asOf: raw.as_of,
  };
}

function allUnavailable(tickers: string[]): QuotesResult {
  const errors: Record<string, string> = {};
  for (const ticker of tickers) {
    errors[ticker] = "unavailable";
  }
  return { quotes: {}, errors };
}

/** Fetch quotes for the given tickers from the AI service. */
export async function getQuotes(tickers: string[]): Promise<QuotesResult> {
  if (tickers.length === 0) {
    return { quotes: {}, errors: {} };
  }

  const url = new URL("/quotes", config.aiServiceUrl);
  url.searchParams.set("symbols", tickers.join(","));

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.warn(
        { url: url.toString(), status: response.status },
        "ai-service quotes returned non-OK",
      );
      return allUnavailable(tickers);
    }

    const parsed = upstreamResponseSchema.parse(await response.json());
    const quotes: Record<string, Quote> = {};
    for (const [ticker, raw] of Object.entries(parsed.quotes)) {
      quotes[ticker] = toQuote(raw);
    }
    return { quotes, errors: parsed.errors };
  } catch (error) {
    logger.warn(
      { url: url.toString(), err: error },
      "failed to reach ai-service quotes",
    );
    return allUnavailable(tickers);
  }
}
