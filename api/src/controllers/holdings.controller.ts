/** Holdings controller (HTTP layer). Validates input and delegates to service. */
import type { Request, Response } from "express";

import * as holdingsService from "../services/holdings.service.js";
import {
  createHoldingSchema,
  holdingIdSchema,
  updateHoldingSchema,
} from "../schemas/holding.schema.js";

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
  const holding = await holdingsService.createHolding(input);
  res.status(201).json(holding);
}

export async function updateHolding(req: Request, res: Response): Promise<void> {
  const id = holdingIdSchema.parse(req.params.id);
  const input = updateHoldingSchema.parse(req.body);
  const holding = await holdingsService.updateHolding(id, input);
  res.status(200).json(holding);
}

export async function deleteHolding(req: Request, res: Response): Promise<void> {
  const id = holdingIdSchema.parse(req.params.id);
  await holdingsService.deleteHolding(id);
  res.status(204).send();
}
