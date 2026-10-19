/** Portfolio controller (HTTP layer). */
import type { Request, Response } from "express";

import { getPortfolioSummary } from "../services/portfolio.service.js";
import { getPortfolioPerformance } from "../services/performance.service.js";
import { getSectorAllocation } from "../services/sectors.service.js";
import { ensureDemoHoldings } from "../services/holdings.service.js";
import { getUserId, isAnonymousRequest } from "../middleware/auth.js";
import { performanceQuerySchema } from "../schemas/portfolio.schema.js";

/**
 * The user's id, after seeding the sample portfolio for anonymous demo
 * visitors (idempotent, so the dashboard's parallel first loads are safe).
 */
async function portfolioOwner(req: Request): Promise<string> {
  const userId = getUserId(req);
  if (isAnonymousRequest(req)) {
    await ensureDemoHoldings(userId);
  }
  return userId;
}

export async function getSummary(req: Request, res: Response): Promise<void> {
  const summary = await getPortfolioSummary(await portfolioOwner(req));
  res.status(200).json(summary);
}

export async function getSectors(req: Request, res: Response): Promise<void> {
  const allocation = await getSectorAllocation(await portfolioOwner(req));
  res.status(200).json(allocation);
}

export async function getPerformance(req: Request, res: Response): Promise<void> {
  const { range } = performanceQuerySchema.parse(req.query);
  const performance = await getPortfolioPerformance(await portfolioOwner(req), range);
  res.status(200).json(performance);
}
