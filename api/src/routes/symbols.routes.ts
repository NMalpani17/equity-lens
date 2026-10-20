/** Company search routes. */
import { Router } from "express";

import * as symbols from "../controllers/symbols.controller.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth } from "../middleware/auth.js";

export const symbolsRouter = Router();

symbolsRouter.use("/symbols", asyncHandler(requireAuth));

// ?q=<name or ticker>: at most 8 ranked matches, no Finnhub calls.
symbolsRouter.get("/symbols/search", asyncHandler(symbols.search));
