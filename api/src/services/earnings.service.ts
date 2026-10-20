/**
 * Client for the ai-service's earnings calendar (Finnhub's calendar, cached in
 * Postgres and refreshed in the background at most once a day), plus the
 * Watchlist page's "Upcoming earnings": the user's holdings and watchlist.
 *
 * Reading the calendar costs no Finnhub calls. Never throws: if the calendar
 * can't be read, every ticker is unscheduled and `available` is false.
 */
import { z } from "zod";

import { logger } from "../logger.js";
import { aiServiceFetch, aiServiceUrl } from "./aiServiceClient.js";
import { listHeldTickers } from "./holdings.service.js";
import { symbolNames } from "./symbols.service.js";
import { listWatchlistItems } from "./watchlist.service.js";
import type { EarningsSource, UpcomingEarningsDto } from "../types.js";

/** Days ahead the calendar covers (the ai-service's maximum). */
export const EARNINGS_WINDOW_DAYS = 60;

const eventSchema = z.object({
  ticker: z.string(),
  date: z.string().date(),
  hour: z.enum(["bmo", "amc", "dmh"]).nullable(),
  eps_estimate: z.number().nullable(),
  revenue_estimate: z.number().nullable(),
  fiscal_year: z.number().int().nullable(),
  fiscal_quarter: z.number().int().nullable(),
});

const upstreamSchema = z.object({
  earnings: z.array(eventSchema),
  unscheduled: z.array(z.string()),
  window_start: z.string().date(),
  window_end: z.string().date(),
  refreshed_at: z.string().nullable(),
  refreshing: z.boolean(),
  available: z.boolean(),
});

export interface EarningsEvent {
  ticker: string;
  date: string;
  /** "bmo" before the open, "amc" after the close, "dmh" during the session. */
  hour: "bmo" | "amc" | "dmh" | null;
  epsEstimate: number | null;
}

export interface UpcomingEarnings {
  earnings: EarningsEvent[];
  unscheduled: string[];
  windowStart: string | null;
  windowEnd: string | null;
  refreshedAt: string | null;
  refreshing: boolean;
  available: boolean;
}

const REQUEST_TIMEOUT_MS = 8000;

function unavailable(tickers: string[]): UpcomingEarnings {
  return {
    earnings: [],
    unscheduled: tickers,
    windowStart: null,
    windowEnd: null,
    refreshedAt: null,
    refreshing: false,
    available: false,
  };
}

/** Each ticker's next earnings report within `days`, soonest first. */
export async function getUpcomingEarnings(
  tickers: string[],
  days: number = EARNINGS_WINDOW_DAYS,
): Promise<UpcomingEarnings> {
  if (tickers.length === 0) {
    return { ...unavailable([]), available: true };
  }
  const url = aiServiceUrl("/earnings/upcoming");
  try {
    const response = await aiServiceFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols: tickers, days }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn({ status: response.status }, "ai-service earnings returned non-OK");
      return unavailable(tickers);
    }
    const parsed = upstreamSchema.safeParse(await response.json());
    if (!parsed.success) {
      logger.warn(
        { err: parsed.error.flatten() },
        "ai-service earnings response had an unexpected shape",
      );
      return unavailable(tickers);
    }
    const data = parsed.data;
    return {
      earnings: data.earnings.map((event) => ({
        ticker: event.ticker,
        date: event.date,
        hour: event.hour,
        epsEstimate: event.eps_estimate,
      })),
      unscheduled: data.unscheduled,
      windowStart: data.window_start,
      windowEnd: data.window_end,
      refreshedAt: data.refreshed_at,
      refreshing: data.refreshing,
      available: data.available,
    };
  } catch (error) {
    logger.warn({ err: error }, "failed to reach ai-service earnings");
    return unavailable(tickers);
  }
}

/**
 * Upcoming earnings for everything the user holds or watches, each tagged
 * with where it comes from. Read-only: holdings are never changed.
 */
export async function getUserUpcomingEarnings(
  userId: string,
): Promise<UpcomingEarningsDto> {
  const [held, watched] = await Promise.all([
    listHeldTickers(userId),
    listWatchlistItems(userId).then((items) => items.map((item) => item.ticker)),
  ]);
  const heldSet = new Set(held);
  const watchedSet = new Set(watched);
  const tickers = [...new Set([...held, ...watched])];
  const source = (ticker: string): EarningsSource =>
    heldSet.has(ticker) && watchedSet.has(ticker)
      ? "both"
      : heldSet.has(ticker)
        ? "holding"
        : "watchlist";

  const [calendar, names] = await Promise.all([
    getUpcomingEarnings(tickers),
    symbolNames(tickers),
  ]);
  const name = (ticker: string) => names.get(ticker) ?? null;
  return {
    earnings: calendar.earnings.map((event) => ({
      ...event,
      name: name(event.ticker),
      source: source(event.ticker),
    })),
    unscheduled: calendar.unscheduled.map((ticker) => ({
      ticker,
      name: name(ticker),
      source: source(ticker),
    })),
    windowStart: calendar.windowStart,
    windowEnd: calendar.windowEnd,
    refreshedAt: calendar.refreshedAt,
    refreshing: calendar.refreshing,
    available: calendar.available,
  };
}
