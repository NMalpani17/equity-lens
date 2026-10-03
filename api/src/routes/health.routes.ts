/** Health routes. */
import { Router } from "express";

import { getHealth, getLive, postWarmup } from "../controllers/health.controller.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth } from "../middleware/auth.js";

export const healthRouter = Router();

// Dependency-aware status for the header badge.
healthRouter.get("/health", getHealth);
// Liveness only (platform health check).
healthRouter.get("/live", getLive);
// Wake the ai-service once a user has a session (fire-and-forget).
healthRouter.post("/warmup", asyncHandler(requireAuth), asyncHandler(postWarmup));
