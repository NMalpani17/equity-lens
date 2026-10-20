/** Watchlist routes (companies the user is considering, not owned). */
import { Router } from "express";

import * as watchlist from "../controllers/watchlist.controller.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth } from "../middleware/auth.js";

export const watchlistRouter = Router();

watchlistRouter.use(["/watchlist", "/earnings"], asyncHandler(requireAuth));

watchlistRouter.get("/watchlist", asyncHandler(watchlist.listItems));
watchlistRouter.post("/watchlist", asyncHandler(watchlist.addItem));
watchlistRouter.delete("/watchlist/:ticker", asyncHandler(watchlist.removeItem));
// Upcoming earnings for the user's holdings and watchlist (next 60 days).
watchlistRouter.get("/earnings/upcoming", asyncHandler(watchlist.upcomingEarnings));
