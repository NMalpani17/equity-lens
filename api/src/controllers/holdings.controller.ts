/** Holdings controller (HTTP layer). Validates input and delegates to service. */
import type { Request, Response } from "express";

import * as holdingsService from "../services/holdings.service.js";
import { verifyTicker } from "../services/quotes.service.js";
import { InvalidTickerError } from "../errors.js";
import {
  createHoldingSchema,
  holdingIdSchema,
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

export async function listHoldings(_req: Request, res: Response): Promise<void> {
  const holdings = await holdingsService.listHoldings();
  res.status(200).json(holdings);
}

export async function getHolding(req: Request, res: Response): Promise<void> {
  const id = holdingIdSchema.parse(req.params.id);
  const holding = await holdingsService.getHolding(id);
  res.status(200).json(holding);
}

export async function createHolding(req: Request, res: Response): Promise<void> {
  const input = createHoldingSchema.parse(req.body);
  await assertTickerExists(input.ticker);
  const holding = await holdingsService.createHolding(input);
  res.status(201).json(holding);
}

export async function updateHolding(req: Request, res: Response): Promise<void> {
  const id = holdingIdSchema.parse(req.params.id);
  const input = updateHoldingSchema.parse(req.body);
  // Only verify the ticker when it actually changes: the client may resend the
  // unchanged ticker, and re-checking it against the market data service on
  // every edit is wasteful (and would fail if the service is momentarily down).
  if (input.ticker !== undefined) {
    const existing = await holdingsService.getHolding(id);
    if (input.ticker !== existing.ticker) {
      await assertTickerExists(input.ticker);
    }
  }
  const holding = await holdingsService.updateHolding(id, input);
  res.status(200).json(holding);
}

export async function deleteHolding(req: Request, res: Response): Promise<void> {
  const id = holdingIdSchema.parse(req.params.id);
  await holdingsService.deleteHolding(id);
  res.status(204).send();
}
