/** Health routes. */
import { Router } from "express";

import { getHealth, getLive, postWarmup } from "../controllers/health.controller.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { optionalAuth, requireAuth } from "../middleware/auth.js";

export const healthRouter = Router();

// API status for anyone; plus the ai-service's for signed-in users (top-bar dot).
healthRouter.get("/health", asyncHandler(optionalAuth), asyncHandler(getHealth));
// Liveness only (platform health check).
healthRouter.get("/live", getLive);
// Wake the ai-service once a user has a session (fire-and-forget).
healthRouter.post("/warmup", asyncHandler(requireAuth), asyncHandler(postWarmup));
