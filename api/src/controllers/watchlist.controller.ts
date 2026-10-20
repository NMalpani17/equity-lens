/** Watchlist controller (HTTP layer). Validates input and delegates to services. */
import type { Request, Response } from "express";

import { getUserId, isAnonymousRequest } from "../middleware/auth.js";
import {
  addWatchlistItemSchema,
  watchlistTickerParamSchema,
} from "../schemas/watchlist.schema.js";
import { getUserUpcomingEarnings } from "../services/earnings.service.js";
import * as watchlist from "../services/watchlist.service.js";
import { getWatchlist } from "../services/watchlistView.service.js";

/** The user's id, after seeding the sample watchlist for demo visitors. */
async function watchlistOwner(req: Request): Promise<string> {
  const userId = getUserId(req);
  if (isAnonymousRequest(req)) {
    await watchlist.ensureDemoWatchlist(userId);
  }
  return userId;
}

/** GET /api/watchlist — rows with live prices, earnings and report status. */
export async function listItems(req: Request, res: Response): Promise<void> {
  const userId = await watchlistOwner(req);
  res.status(200).json(await getWatchlist(userId, isAnonymousRequest(req)));
}

/** GET /api/earnings/upcoming — the next 60 days for holdings and watchlist. */
export async function upcomingEarnings(req: Request, res: Response): Promise<void> {
  const userId = await watchlistOwner(req);
  res.status(200).json(await getUserUpcomingEarnings(userId));
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
