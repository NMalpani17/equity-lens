/** Health-check controller (HTTP layer). */
import type { Request, Response } from "express";

import { HttpError } from "../errors.js";
import { getUserId } from "../middleware/auth.js";
import {
  getAiServiceHealth,
  warmAiService,
  warmupLimiter,
} from "../services/aiService.js";
import type { HealthResponse } from "../types.js";

const VERSION = "0.1.0";

/**
 * Report the API's health, and for signed-in users (real or demo) the
 * ai-service's too: 200 when everything is healthy, 503 when it's down.
 * Anonymous callers get only the API's own status, so they can never wake
 * the ai-service (it scales to zero and is billed while running).
 */
export async function getHealth(req: Request, res: Response): Promise<void> {
  if (!req.userId) {
    const body: HealthResponse = {
      status: "ok",
      service: "equity-lens-api",
      version: VERSION,
    };
    res.status(200).json(body);
    return;
  }
  const aiService = await getAiServiceHealth();
  const healthy = aiService.status === "ok";

  const body: HealthResponse = {
    status: healthy ? "ok" : "degraded",
    service: "equity-lens-api",
    version: VERSION,
    dependencies: { aiService },
  };

  res.status(healthy ? 200 : 503).json(body);
}

/**
 * Liveness for the platform health check: the process is up and serving.
 * Deliberately checks no dependencies, so a sleeping or slow ai-service never
 * fails a deploy or gets this instance restarted.
 */
export function getLive(_req: Request, res: Response): void {
  res.status(200).json({ status: "ok", service: "equity-lens-api" });
}

/**
 * Wake the ai-service ahead of the user's first question. Signed-in (or demo)
 * users only; the client fires it once a session exists, without waiting. At
 * most once per minute per user (429 otherwise). The request stays open until
 * the ai-service answers (or the warm-up times out) so the platform keeps this
 * instance's CPU while the ping is in flight. Otherwise always 200: warming is
 * best effort.
 */
export async function postWarmup(req: Request, res: Response): Promise<void> {
  const retryAfterMs = warmupLimiter.take(getUserId(req));
  if (retryAfterMs > 0) {
    const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);
    res.set("Retry-After", String(retryAfterSeconds));
    throw new HttpError(
      429,
      "warmup_rate_limited",
      "The AI service was warmed up recently. Try again shortly.",
      { retryAfterSeconds },
    );
  }
  const aiService = await warmAiService();
  res.status(200).json({ aiService: aiService.status === "ok" ? "ok" : "waking" });
}
