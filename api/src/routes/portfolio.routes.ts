/** Portfolio routes. */
import { Router } from "express";

import { getSummary } from "../controllers/portfolio.controller.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth } from "../middleware/auth.js";

export const portfolioRouter = Router();

// The portfolio summary is user-specific and requires authentication.
portfolioRouter.use(asyncHandler(requireAuth));

portfolioRouter.get("/portfolio/summary", asyncHandler(getSummary));
