/**
 * Client for the downstream FastAPI AI service.
 *
 * The upstream response is validated with Zod because it is external input.
 */
import { z } from "zod";

import { logger } from "../logger.js";
import { createKeyedRateLimiter } from "./rateLimit.js";
import { aiServiceFetch, aiServiceUrl } from "./aiServiceClient.js";
import type { ServiceHealth } from "../types.js";

const aiHealthSchema = z.object({
  status: z.string(),
  service: z.string(),
  version: z.string(),
  environment: z.string(),
});

const REQUEST_TIMEOUT_MS = 3000;
/** Long enough for a cold start: the ai-service is up by the time it answers. */
export const WARMUP_TIMEOUT_MS = 20_000;
/** A successful warm-up is reused for this long instead of pinging again. */
export const WARMUP_REUSE_MS = 60_000;
/** Each user may trigger a warm-up at most this often. */
export const WARMUP_USER_WINDOW_MS = 60_000;

/** Per-user warm-up limit (per api instance). */
export const warmupLimiter = createKeyedRateLimiter(WARMUP_USER_WINDOW_MS);

/**
 * Fetch the AI service health. Never throws — on any failure it returns an
 * `unreachable` status so the caller can report degraded health.
 */
export async function getAiServiceHealth(
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<ServiceHealth> {
  const url = aiServiceUrl("/health");
  try {
    const response = await aiServiceFetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
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

let warming: Promise<ServiceHealth> | null = null;
let lastWarmAt = 0;

/**
 * Wake the ai-service (scaled to zero) before the user's first question by
 * pinging its /health and waiting up to WARMUP_TIMEOUT_MS. Concurrent calls
 * share one ping, and a success within WARMUP_REUSE_MS is reused, so a burst
 * of page loads costs one request. Never throws.
 */
export async function warmAiService(now = Date.now): Promise<ServiceHealth> {
  if (now() - lastWarmAt < WARMUP_REUSE_MS) {
    return { status: "ok", service: "ai-service" };
  }
  warming ??= getAiServiceHealth(WARMUP_TIMEOUT_MS)
    .then((health) => {
      if (health.status === "ok") lastWarmAt = now();
      return health;
    })
    .finally(() => {
      warming = null;
    });
  return warming;
}

/** Forget the last warm-up and the per-user limits (tests). */
export function resetWarmup(): void {
  warming = null;
  lastWarmAt = 0;
  warmupLimiter.reset();
}
