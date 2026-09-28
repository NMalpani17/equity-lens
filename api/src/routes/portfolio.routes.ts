/** Portfolio routes. */
import { Router } from "express";

import { getSummary } from "../controllers/portfolio.controller.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export const portfolioRouter = Router();

portfolioRouter.get("/portfolio/summary", asyncHandler(getSummary));
