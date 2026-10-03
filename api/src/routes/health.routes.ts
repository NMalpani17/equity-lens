/** Health routes. */
import { Router } from "express";

import { getHealth, getLive, postWarmup } from "../controllers/health.controller.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export const healthRouter = Router();

// Dependency-aware status for the header badge.
healthRouter.get("/health", getHealth);
// Liveness only (platform health check).
healthRouter.get("/live", getLive);
// Wake the ai-service on page load (fire-and-forget from the client).
healthRouter.post("/warmup", asyncHandler(postWarmup));
