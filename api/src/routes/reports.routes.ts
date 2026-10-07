/** Research report routes (all authenticated; generating needs a real account). */
import { Router } from "express";

import * as reports from "../controllers/reports.controller.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth } from "../middleware/auth.js";

export const reportsRouter = Router();

reportsRouter.use("/reports", asyncHandler(requireAuth));

reportsRouter.get("/reports", asyncHandler(reports.listReports));
reportsRouter.get("/reports/:ticker", asyncHandler(reports.getReport));
reportsRouter.post("/reports/:ticker", asyncHandler(reports.generateReport));
