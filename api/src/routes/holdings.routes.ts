/** Holdings CRUD routes. */
import { Router } from "express";

import * as holdings from "../controllers/holdings.controller.js";
import * as holdingsImport from "../controllers/import.controller.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth } from "../middleware/auth.js";

export const holdingsRouter = Router();

// Every holdings route requires a valid Supabase JWT and is scoped to its user.
holdingsRouter.use(asyncHandler(requireAuth));

holdingsRouter.get("/holdings", asyncHandler(holdings.listHoldings));
holdingsRouter.post("/holdings", asyncHandler(holdings.createHolding));
// CSV import: preview (validates, writes nothing), then save the confirmed rows.
holdingsRouter.post("/holdings/import/preview", asyncHandler(holdingsImport.preview));
holdingsRouter.post("/holdings/import", asyncHandler(holdingsImport.commit));
// Collection-level delete (a whole position by ticker), e.g. ?ticker=AAPL.
holdingsRouter.delete("/holdings", asyncHandler(holdings.deleteHoldingsByTicker));
holdingsRouter.get("/holdings/:id", asyncHandler(holdings.getHolding));
holdingsRouter.patch("/holdings/:id", asyncHandler(holdings.updateHolding));
holdingsRouter.delete("/holdings/:id", asyncHandler(holdings.deleteHolding));
