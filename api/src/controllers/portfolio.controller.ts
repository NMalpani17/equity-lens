/** Portfolio controller (HTTP layer). */
import type { Request, Response } from "express";

import { getPortfolioSummary } from "../services/portfolio.service.js";

export async function getSummary(_req: Request, res: Response): Promise<void> {
  const summary = await getPortfolioSummary();
  res.status(200).json(summary);
}
