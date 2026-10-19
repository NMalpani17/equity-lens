/**
 * Client for the AI service's company-profile endpoint (sector allocation).
 *
 * The upstream response is external input, so it is validated with Zod. A
 * transport failure or malformed body throws UpstreamError: showing every
 * holding as "Other" during an outage would be misleading.
 */
import { z } from "zod";

import { UpstreamError } from "../errors.js";
import { logger } from "../logger.js";
import { aiServiceFetch, aiServiceUrl } from "./aiServiceClient.js";

const profileSchema = z.object({
  ticker: z.string(),
  name: z.string().nullable(),
  sector: z.string().nullable(),
});

const upstreamSchema = z.object({
  profiles: z.record(profileSchema),
  pending: z.array(z.string()),
});

export type CompanyProfiles = z.infer<typeof upstreamSchema>;

// A request may look up to 25 uncached tickers (Finnhub, then yfinance).
const REQUEST_TIMEOUT_MS = 30_000;

const UNAVAILABLE_MESSAGE = "Sector data is unavailable right now. Please try again.";

/** Sector and name per ticker; tickers not looked up yet come back pending. */
export async function getCompanyProfiles(tickers: string[]): Promise<CompanyProfiles> {
  if (tickers.length === 0) {
    return { profiles: {}, pending: [] };
  }
  const url = aiServiceUrl("/profiles");
  url.searchParams.set("symbols", tickers.join(","));

  let response: Response;
  try {
    response = await aiServiceFetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn({ err: error }, "failed to reach ai-service profiles");
    throw new UpstreamError(UNAVAILABLE_MESSAGE);
  }
  if (!response.ok) {
    logger.warn({ status: response.status }, "ai-service profiles returned non-OK");
    throw new UpstreamError(UNAVAILABLE_MESSAGE);
  }
  const parsed = upstreamSchema.safeParse(await response.json());
  if (!parsed.success) {
    logger.warn(
      { err: parsed.error.flatten() },
      "ai-service profiles response had an unexpected shape",
    );
    throw new UpstreamError(UNAVAILABLE_MESSAGE);
  }
  return parsed.data;
}
