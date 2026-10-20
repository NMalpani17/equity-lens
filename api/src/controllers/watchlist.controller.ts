/** Watchlist controller (HTTP layer). Validates input and delegates to services. */
import type { Request, Response } from "express";

import { getUserId, isAnonymousRequest } from "../middleware/auth.js";
import {
  addWatchlistItemSchema,
  watchlistTickerParamSchema,
} from "../schemas/watchlist.schema.js";
import * as watchlist from "../services/watchlist.service.js";

/** The user's id, after seeding the sample watchlist for demo visitors. */
async function watchlistOwner(req: Request): Promise<string> {
  const userId = getUserId(req);
  if (isAnonymousRequest(req)) {
    await watchlist.ensureDemoWatchlist(userId);
  }
  return userId;
}

/** POST /api/watchlist { ticker } */
export async function addItem(req: Request, res: Response): Promise<void> {
  const { ticker } = addWatchlistItemSchema.parse(req.body);
  const item = await watchlist.watchTicker(await watchlistOwner(req), ticker);
  res.status(201).json(item);
}

/** DELETE /api/watchlist/:ticker */
export async function removeItem(req: Request, res: Response): Promise<void> {
  const ticker = watchlistTickerParamSchema.parse(req.params.ticker);
  await watchlist.removeItem(await watchlistOwner(req), ticker);
  res.status(204).send();
}
