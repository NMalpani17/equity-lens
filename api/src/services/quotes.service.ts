/**
 * Client for the AI service's market-data endpoints.
 *
 * The upstream response is external input, so it is validated with Zod. This
 * client never throws: on any transport failure it returns every requested
 * ticker as `unavailable`, so the portfolio summary can still render holdings.
 */
import { z } from "zod";

import { logger } from "../logger.js";
import { aiServiceFetch, aiServiceUrl } from "./aiServiceClient.js";

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

// Validate the envelope shape loosely: each quote entry is validated
// individually below so one malformed quote can never sink the whole batch.
const upstreamEnvelopeSchema = z.object({
  quotes: z.record(z.unknown()),
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

  const url = aiServiceUrl("/quotes");
  url.searchParams.set("symbols", tickers.join(","));

  try {
    const response = await aiServiceFetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.warn(
        { url: url.toString(), status: response.status },
        "ai-service quotes returned non-OK",
      );
      return allUnavailable(tickers);
    }

    const envelope = upstreamEnvelopeSchema.safeParse(await response.json());
    if (!envelope.success) {
      logger.warn(
        { url: url.toString(), err: envelope.error.flatten() },
        "ai-service quotes response had an unexpected shape",
      );
      return allUnavailable(tickers);
    }

    const quotes: Record<string, Quote> = {};
    const errors: Record<string, string> = { ...envelope.data.errors };
    for (const [ticker, raw] of Object.entries(envelope.data.quotes)) {
      const parsed = upstreamQuoteSchema.safeParse(raw);
      if (parsed.success) {
        quotes[ticker] = toQuote(parsed.data);
      } else {
        // A single malformed quote must not fail the whole batch: mark just
        // this ticker unavailable and keep the valid quotes.
        logger.warn(
          { ticker, err: parsed.error.flatten() },
          "dropping malformed quote from ai-service",
        );
        errors[ticker] = "unavailable";
      }
    }
    return { quotes, errors };
  } catch (error) {
    logger.warn(
      { url: url.toString(), err: error },
      "failed to reach ai-service quotes",
    );
    return allUnavailable(tickers);
  }
}

/** Result of checking whether a single ticker is a real, quotable symbol. */
export type TickerCheck = "ok" | "not_found" | "unavailable";

const tickerCheckSchema = z.object({
  results: z.record(z.enum(["ok", "not_found", "unavailable"])),
});

// A cold batch check downloads recent prices for every unknown ticker.
const BATCH_CHECK_TIMEOUT_MS = 60_000;

/**
 * Check many tickers at once (CSV import). The ai-service answers from its
 * caches and one batched yfinance download, so this spends no Finnhub calls
 * unless yfinance is down (then at most 20). Never throws: on failure every
 * ticker is "unavailable", which callers treat like a single-holding add.
 */
export async function verifyTickers(
  tickers: string[],
): Promise<Record<string, TickerCheck>> {
  const unavailable = (): Record<string, TickerCheck> =>
    Object.fromEntries(tickers.map((t) => [t, "unavailable" as const]));
  if (tickers.length === 0) return {};

  const url = aiServiceUrl("/tickers/verify");
  try {
    const response = await aiServiceFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols: tickers }),
      signal: AbortSignal.timeout(BATCH_CHECK_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn(
        { status: response.status },
        "ai-service ticker check returned non-OK",
      );
      return unavailable();
    }
    const parsed = tickerCheckSchema.safeParse(await response.json());
    if (!parsed.success) {
      logger.warn(
        { err: parsed.error.flatten() },
        "ai-service ticker check had an unexpected shape",
      );
      return unavailable();
    }
    return { ...unavailable(), ...parsed.data.results };
  } catch (error) {
    logger.warn({ err: error }, "failed to reach ai-service for the ticker check");
    return unavailable();
  }
}

/**
 * Check whether a ticker exists via the AI service's single-quote endpoint.
 * Returns "ok" if quotable, "not_found" if the symbol is unknown, and
 * "unavailable" when the market-data service can't be reached (so callers can
 * decide whether a transient outage should block the user).
 */
export async function verifyTicker(ticker: string): Promise<TickerCheck> {
  const url = aiServiceUrl(`/quotes/${encodeURIComponent(ticker)}`);

  try {
    const response = await aiServiceFetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.ok) {
      return "ok";
    }
    if (response.status === 404) {
      return "not_found";
    }
    logger.warn(
      { url: url.toString(), status: response.status },
      "ai-service ticker check returned non-OK",
    );
    return "unavailable";
  } catch (error) {
    logger.warn(
      { url: url.toString(), err: error },
      "failed to reach ai-service for ticker check",
    );
    return "unavailable";
  }
}
