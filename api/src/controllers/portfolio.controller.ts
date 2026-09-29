/** Portfolio controller (HTTP layer). */
import type { Request, Response } from "express";

import { getPortfolioSummary } from "../services/portfolio.service.js";
import { getUserId } from "../middleware/auth.js";

export async function getSummary(req: Request, res: Response): Promise<void> {
  const userId = getUserId(req);
  const summary = await getPortfolioSummary(userId);
  res.status(200).json(summary);
}
