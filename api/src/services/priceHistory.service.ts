/**
 * Client for the AI service's daily-closes endpoint (portfolio performance).
 *
 * The upstream response is external input, so it is validated with Zod. A
 * transport failure or malformed body throws UpstreamError: unlike quotes,
 * there is nothing useful to chart without the closes.
 */
import { z } from "zod";

import { UpstreamError } from "../errors.js";
import { logger } from "../logger.js";
import { aiServiceFetch, aiServiceUrl } from "./aiServiceClient.js";

const pricePointSchema = z.object({ date: z.string().date(), close: z.number() });

const upstreamSchema = z.object({
  series: z.record(z.array(pricePointSchema)),
  errors: z.record(z.string()),
  through: z.string().date(),
});

export type PricePoint = z.infer<typeof pricePointSchema>;
export type DailyCloses = z.infer<typeof upstreamSchema>;

// A cold request fetches each ticker's full range from yfinance.
const REQUEST_TIMEOUT_MS = 45_000;

const UNAVAILABLE_MESSAGE = "Price history is unavailable right now. Please try again.";

/** Split-adjusted daily closes from `start` (YYYY-MM-DD) for each ticker. */
export async function getDailyCloses(
  tickers: string[],
  start: string,
): Promise<DailyCloses> {
  const url = aiServiceUrl("/history/daily");
  url.searchParams.set("symbols", tickers.join(","));
  url.searchParams.set("start", start);

  let response: Response;
  try {
    response = await aiServiceFetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn({ err: error }, "failed to reach ai-service daily closes");
    throw new UpstreamError(UNAVAILABLE_MESSAGE);
  }
  if (!response.ok) {
    logger.warn({ status: response.status }, "ai-service daily closes returned non-OK");
    throw new UpstreamError(UNAVAILABLE_MESSAGE);
  }
  const parsed = upstreamSchema.safeParse(await response.json());
  if (!parsed.success) {
    logger.warn(
      { err: parsed.error.flatten() },
      "ai-service daily closes response had an unexpected shape",
    );
    throw new UpstreamError(UNAVAILABLE_MESSAGE);
  }
  return parsed.data;
}
