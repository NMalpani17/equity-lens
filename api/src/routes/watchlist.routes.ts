/** Watchlist routes (companies the user is considering, not owned). */
import { Router } from "express";

import * as watchlist from "../controllers/watchlist.controller.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth } from "../middleware/auth.js";

export const watchlistRouter = Router();

watchlistRouter.use("/watchlist", asyncHandler(requireAuth));

watchlistRouter.post("/watchlist", asyncHandler(watchlist.addItem));
watchlistRouter.delete("/watchlist/:ticker", asyncHandler(watchlist.removeItem));
