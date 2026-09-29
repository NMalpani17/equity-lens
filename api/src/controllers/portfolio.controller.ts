/** Portfolio controller (HTTP layer). */
import type { Request, Response } from "express";

import { getPortfolioSummary } from "../services/portfolio.service.js";
import { ensureDemoHoldings } from "../services/holdings.service.js";
import { getUserId, isAnonymousRequest } from "../middleware/auth.js";

export async function getSummary(req: Request, res: Response): Promise<void> {
  const userId = getUserId(req);
  // Anonymous demo visitors get a sample portfolio on first load.
  if (isAnonymousRequest(req)) {
    await ensureDemoHoldings(userId);
  }
  const summary = await getPortfolioSummary(userId);
  res.status(200).json(summary);
}
