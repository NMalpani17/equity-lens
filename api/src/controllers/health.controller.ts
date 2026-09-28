/** Health-check controller (HTTP layer). */
import type { Request, Response } from "express";

import { getAiServiceHealth } from "../services/aiService.js";
import type { HealthResponse } from "../types.js";

const VERSION = "0.1.0";

/**
 * Report the API's health and the health of its downstream dependencies.
 * Returns 200 when everything is healthy, 503 when a dependency is down.
 */
export async function getHealth(_req: Request, res: Response): Promise<void> {
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
