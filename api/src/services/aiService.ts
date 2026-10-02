/**
 * Client for the downstream FastAPI AI service.
 *
 * The upstream response is validated with Zod because it is external input.
 */
import { z } from "zod";

import { logger } from "../logger.js";
import { aiServiceFetch, aiServiceUrl } from "./aiServiceClient.js";
import type { ServiceHealth } from "../types.js";

const aiHealthSchema = z.object({
  status: z.string(),
  service: z.string(),
  version: z.string(),
  environment: z.string(),
});

const REQUEST_TIMEOUT_MS = 3000;

/**
 * Fetch the AI service health. Never throws — on any failure it returns an
 * `unreachable` status so the caller can report degraded health.
 */
export async function getAiServiceHealth(): Promise<ServiceHealth> {
  const url = aiServiceUrl("/health");
  try {
    const response = await aiServiceFetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.warn({ url, status: response.status }, "ai-service returned non-OK");
      return { status: "unreachable", service: "ai-service" };
    }

    const data = aiHealthSchema.parse(await response.json());
    return {
      status: "ok",
      service: data.service,
      version: data.version,
      environment: data.environment,
    };
  } catch (error) {
    logger.warn({ url, err: error }, "failed to reach ai-service");
    return { status: "unreachable", service: "ai-service" };
  }
}
