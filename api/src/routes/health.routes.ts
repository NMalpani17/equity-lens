/** Health routes. */
import { Router } from "express";

import { getHealth, getLive } from "../controllers/health.controller.js";

export const healthRouter = Router();

// Dependency-aware status for the header badge.
healthRouter.get("/health", getHealth);
// Liveness only (platform health check).
healthRouter.get("/live", getLive);
