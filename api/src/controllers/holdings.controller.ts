/** Holdings controller (HTTP layer). Validates input and delegates to service. */
import type { Request, Response } from "express";

import * as holdingsService from "../services/holdings.service.js";
import { verifyTicker } from "../services/quotes.service.js";
import { getUserId, isAnonymousRequest } from "../middleware/auth.js";
import { InvalidTickerError, NotFoundError } from "../errors.js";
import {
  createHoldingSchema,
  holdingIdSchema,
  tickerSchema,
  updateHoldingSchema,
} from "../schemas/holding.schema.js";

/**
 * Reject tickers the market-data service does not recognize. A transient
 * outage ("unavailable") does not block the user; only a confirmed unknown
 * symbol is rejected.
 */
async function assertTickerExists(ticker: string): Promise<void> {
  if ((await verifyTicker(ticker)) === "not_found") {
    throw new InvalidTickerError(`'${ticker}' is not a recognized ticker symbol.`);
  }
}

export async function listHoldings(req: Request, res: Response): Promise<void> {
  const userId = getUserId(req);
  // Anonymous demo visitors get a sample portfolio on first load.
  if (isAnonymousRequest(req)) {
    await holdingsService.ensureDemoHoldings(userId);
  }
  const holdings = await holdingsService.listHoldings(userId);
  res.status(200).json(holdings);
}

export async function getHolding(req: Request, res: Response): Promise<void> {
  const userId = getUserId(req);
  const id = holdingIdSchema.parse(req.params.id);
  const holding = await holdingsService.getHolding(id, userId);
  res.status(200).json(holding);
}

export async function createHolding(req: Request, res: Response): Promise<void> {
  const userId = getUserId(req);
  const input = createHoldingSchema.parse(req.body);
  await assertTickerExists(input.ticker);
  const holding = await holdingsService.createHolding(input, userId);
  res.status(201).json(holding);
}

export async function updateHolding(req: Request, res: Response): Promise<void> {
  const userId = getUserId(req);
  const id = holdingIdSchema.parse(req.params.id);
  const input = updateHoldingSchema.parse(req.body);
  // Only verify the ticker when it actually changes: the client may resend the
  // unchanged ticker, and re-checking it against the market data service on
  // every edit is wasteful (and would fail if the service is momentarily down).
  if (input.ticker !== undefined) {
    const existing = await holdingsService.getHolding(id, userId);
    if (input.ticker !== existing.ticker) {
      await assertTickerExists(input.ticker);
    }
  }
  const holding = await holdingsService.updateHolding(id, input, userId);
  res.status(200).json(holding);
}

export async function deleteHolding(req: Request, res: Response): Promise<void> {
  const userId = getUserId(req);
  const id = holdingIdSchema.parse(req.params.id);
  await holdingsService.deleteHolding(id, userId);
  res.status(204).send();
}

/** Delete every lot for a ticker (a whole position), e.g. ?ticker=AAPL. */
export async function deleteHoldingsByTicker(
  req: Request,
  res: Response,
): Promise<void> {
  const userId = getUserId(req);
  const ticker = tickerSchema.parse(req.query.ticker);
  const deleted = await holdingsService.deleteHoldingsByTicker(ticker, userId);
  if (deleted === 0) {
    throw new NotFoundError(`no holdings found for ${ticker}`);
  }
  res.status(204).send();
}
